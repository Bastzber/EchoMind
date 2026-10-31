# -*- coding: utf-8 -*-
"""TTS 统一层：本地 Breeze TTS 2（breeze-server）优先，豆包云端兜底。

Breeze 返回 24 kHz / 单声道 / s16le 裸 PCM，这里包成 WAV 落盘供前端播放。
"""
from __future__ import annotations

import hashlib
import io
import json
import logging
import os
import time
import urllib.error
import urllib.request
import uuid
import wave
from pathlib import Path
from typing import Any, Dict, Optional

logger = logging.getLogger(__name__)

DEFAULT_BREEZE_URL = os.environ.get('ECHOMIND_BREEZE_URL', 'http://127.0.0.1:8080')
SAMPLE_RATE = 24000

# 助理播报的音色描述：Breeze 支持用自然语言指令控制音色，实测这句能把
# 基频从 ~190Hz 抬到 ~240Hz（少女声）。改这里或者设 ECHOMIND_VOICE_STYLE 即可。
DEFAULT_VOICE_STYLE = '一个十六七岁的少女，声音清亮甜美，语速自然'


def prune_cache(max_files: int = 300, max_bytes: int = 120 * 1024 * 1024) -> int:
    """清理合成的 wav 缓存，按修改时间保留最新的。

    每段朗读都会落一个 wav，长期对话下来会一直涨（实测 287 个 / 51 MB 且从不清理）。
    这里按「文件数 + 总字节」两个上限裁剪，超出的按最旧优先删。
    """
    try:
        files = sorted(
            (f for f in cache_dir().glob('breeze-*.wav') if f.is_file()),
            key=lambda f: f.stat().st_mtime,
            reverse=True,
        )
    except Exception:
        return 0
    removed = 0
    total = 0
    for index, path in enumerate(files):
        try:
            size = path.stat().st_size
        except OSError:
            continue
        total += size
        if index < max_files and total <= max_bytes:
            continue
        try:
            path.unlink()
            removed += 1
        except OSError:
            pass
    if removed:
        logger.info('[TTS] 清理语音缓存 %d 个', removed)
    return removed


def cache_dir() -> Path:
    try:
        import config

        base = Path(config.get_user_data_dir())
    except Exception:
        base = Path(os.environ.get('APPDATA', '.')) / 'EchoMind'
    target = base / 'tts_cache'
    target.mkdir(parents=True, exist_ok=True)
    return target


def breeze_url() -> str:
    try:
        import config

        configured = getattr(config, 'BREEZE_TTS_URL', None)
        if configured:
            return str(configured).rstrip('/')
    except Exception:
        pass
    return DEFAULT_BREEZE_URL.rstrip('/')


def voice_style() -> str:
    """助理播报用的音色指令，config 优先，其次环境变量，最后内置默认。"""
    try:
        import config

        value = getattr(config, 'ASSISTANT_VOICE_STYLE', None)
        if value:
            return str(value)
    except Exception:
        pass
    return os.environ.get('ECHOMIND_VOICE_STYLE', DEFAULT_VOICE_STYLE)


def breeze_available(timeout: float = 1.5) -> bool:
    try:
        with urllib.request.urlopen(breeze_url() + '/health', timeout=timeout) as resp:
            return resp.status == 200
    except Exception:
        return False


def _multipart(fields: Dict[str, str], files: Optional[Dict[str, tuple]] = None):
    boundary = '----EchoMind' + uuid.uuid4().hex
    parts = []
    for name, value in fields.items():
        if value is None or value == '':
            continue
        parts.append(f'--{boundary}\r\nContent-Disposition: form-data; name="{name}"\r\n\r\n{value}\r\n'.encode('utf-8'))
    for name, (filename, content) in (files or {}).items():
        parts.append(
            f'--{boundary}\r\nContent-Disposition: form-data; name="{name}"; filename="{filename}"\r\n'
            f'Content-Type: application/octet-stream\r\n\r\n'.encode('utf-8') + content + b'\r\n'
        )
    parts.append(f'--{boundary}--\r\n'.encode('utf-8'))
    body = b''.join(parts)
    headers = {
        'Content-Type': f'multipart/form-data; boundary={boundary}',
        'Content-Length': str(len(body)),
    }
    return body, headers


def _pcm_to_wav(pcm: bytes, channels: int = 1, sample_rate: int = SAMPLE_RATE) -> bytes:
    """把 24 kHz 单声道 s16le 裸 PCM 包成 WAV；可升成双声道/更高采样率。"""
    if channels == 1 and sample_rate == SAMPLE_RATE:
        buffer = io.BytesIO()
        with wave.open(buffer, 'wb') as wav:
            wav.setnchannels(1)
            wav.setsampwidth(2)
            wav.setframerate(SAMPLE_RATE)
            wav.writeframes(pcm)
        return buffer.getvalue()

    # 需要重采样或复制声道时用 PyAV（避免手写插值带来的失真）
    try:
        import av
        from av.audio.frame import AudioFrame
        from av.audio.resampler import AudioResampler

        layout = 'mono' if channels == 1 else 'stereo'
        frame = AudioFrame(format='s16', layout='mono', samples=len(pcm) // 2)
        frame.sample_rate = SAMPLE_RATE
        frame.planes[0].update(pcm)
        resampler = AudioResampler(format='s16', layout=layout, rate=sample_rate)
        out_frames = resampler.resample(frame)
        payload = b''.join(bytes(f.planes[0]) for f in out_frames)
        buffer = io.BytesIO()
        with wave.open(buffer, 'wb') as wav:
            wav.setnchannels(channels)
            wav.setsampwidth(2)
            wav.setframerate(sample_rate)
            wav.writeframes(payload)
        return buffer.getvalue()
    except Exception as exc:
        logger.warning('[TTS] 重采样失败，退回单声道: %s', exc)
        buffer = io.BytesIO()
        with wave.open(buffer, 'wb') as wav:
            wav.setnchannels(1)
            wav.setsampwidth(2)
            wav.setframerate(SAMPLE_RATE)
            wav.writeframes(pcm)
        return buffer.getvalue()


def list_saved_voices(timeout: float = 5.0) -> list:
    """Breeze 里已保存的音色 id 列表（GET /v1/voices）。"""
    try:
        request = urllib.request.Request(breeze_url() + '/v1/voices', method='GET')
        with urllib.request.urlopen(request, timeout=timeout) as resp:
            data = json.loads(resp.read().decode('utf-8') or '{}')
    except Exception as exc:
        logger.debug('[TTS] 读取音色列表失败: %s', exc)
        return []
    items = data.get('voices') if isinstance(data, dict) else data
    if not isinstance(items, list):
        return []
    return [
        str(item.get('id') or item.get('name'))
        for item in items
        if isinstance(item, dict) and (item.get('id') or item.get('name'))
    ]


def register_saved_voice(profile: Dict[str, Any], name: str, timeout: float = 120.0) -> Optional[str]:
    """把一个复刻音色注册成 Breeze 的保存音色，返回 voice_id。

    参考音频只编码一次，之后每段合成都用同一个 voice_id，音色不会在句子之间漂。
    """
    sample = str(profile.get('sample') or '')
    ref_text = str(profile.get('ref_text') or '').strip()
    if not sample or not ref_text or not Path(sample).is_file():
        return None
    try:
        payload = Path(sample).read_bytes()
    except Exception as exc:
        logger.warning('[TTS] 读取参考音频失败: %s', exc)
        return None
    fields = {'name': name, 'ref_text': ref_text}
    files = {'ref_audio': (Path(sample).name, payload)}
    body, headers = _multipart(fields, files)
    request = urllib.request.Request(
        breeze_url() + '/v1/voices', data=body, headers=headers, method='POST'
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout) as resp:
            data = json.loads(resp.read().decode('utf-8') or '{}')
    except Exception as exc:
        logger.warning('[TTS] 注册保存音色失败: %s', exc)
        return None
    voice_id = str(data.get('id') or data.get('voice_id') or name)
    logger.info('[TTS] 已注册保存音色 %s', voice_id)
    return voice_id


_breeze_voice_cache: Dict[str, str] = {}


def assistant_voice_id() -> Optional[str]:
    """助理朗读用的固定音色 id。

    ECHOMIND_ASSISTANT_VOICE（或 config.ASSISTANT_VOICE）可以是已有的 voice id，
    也可以是复刻音色的 id/名字（会自动注册成 echomind-<id> 并复用）。
    没配置就返回 None，走原来的「文本指令 + 每次上传参考音频」路径。
    """
    target = (os.environ.get('ECHOMIND_ASSISTANT_VOICE') or '').strip()
    if not target:
        # %APPDATA%\EchoMind\assistant_voice.txt：一行音色 id，改完不用重启后端
        try:
            voice_file = Path(os.environ.get('APPDATA', '')) / 'EchoMind' / 'assistant_voice.txt'
            if voice_file.is_file():
                target = voice_file.read_text(encoding='utf-8').strip()
        except Exception as exc:
            logger.debug('[TTS] 读取 assistant_voice.txt 失败: %s', exc)
    if not target:
        try:
            target = str(getattr(config, 'ASSISTANT_VOICE', '') or '').strip()
        except Exception:
            target = ''
    if not target:
        return None
    if target in _breeze_voice_cache:
        return _breeze_voice_cache[target]

    saved = list_saved_voices()
    if target in saved:
        _breeze_voice_cache[target] = target
        return target

    profile = None
    try:
        from core.voice_clone import load_profiles

        for item in load_profiles():
            if target in (str(item.get('id')), str(item.get('name'))):
                profile = item
                break
    except Exception as exc:
        logger.debug('[TTS] 读取复刻音色失败: %s', exc)
    if not profile:
        return None

    safe = ''.join(ch for ch in str(profile.get('id') or 'default') if ch.isalnum() or ch in '-_')[:24]
    name = 'echomind-' + (safe or 'default')
    if name in saved:
        _breeze_voice_cache[target] = name
        return name
    voice_id = register_saved_voice(profile, name)
    if voice_id:
        _breeze_voice_cache[target] = voice_id
    return voice_id

def breeze_request_parts(
    text: str,
    *,
    ref_audio: Optional[str] = None,
    ref_text: Optional[str] = None,
    instruction: Optional[str] = None,
    cfg_scale: Optional[float] = None,
    voice_id: Optional[str] = None,
) -> Optional[tuple]:
    """构造 Breeze 合成请求的 (url, body, headers)；文本为空返回 None。

    流式端点和一次性合成都走这里，避免两处字段逻辑漂移。
    """
    content = (text or '').strip()
    if not content:
        return None
    fields: Dict[str, str] = {'text': content}
    files: Dict[str, tuple] = {}
    if voice_id:
        fields['voice_id'] = voice_id
    elif ref_audio and ref_text:
        try:
            files['ref_audio'] = (Path(ref_audio).name, Path(ref_audio).read_bytes())
            fields['ref_text'] = ref_text
        except Exception as exc:
            logger.warning('[TTS] 读取参考音频失败: %s', exc)
    if instruction:
        fields['instruction'] = instruction
    if cfg_scale:
        fields['cfg_scale'] = str(cfg_scale)
    body, headers = _multipart(fields, files)
    return breeze_url() + '/v1/audio/speech', body, headers


def breeze_speak(
    text: str,
    ref_audio: Optional[str] = None,
    ref_text: Optional[str] = None,
    instruction: Optional[str] = None,
    cfg_scale: Optional[float] = None,
    timeout: float = 180.0,
    channels: int = 1,
    sample_rate: int = SAMPLE_RATE,
    voice_id: Optional[str] = None,
) -> Dict[str, Any]:
    """调用本地 breeze-server 合成，返回 {ok, path, provider}。"""
    content = (text or '').strip()
    if not content:
        return {'ok': False, 'error': '文本不能为空'}
    fields: Dict[str, str] = {'text': content}
    files: Dict[str, tuple] = {}
    if voice_id:
        # 已保存音色：服务端直接用编码好的参考，不再每次上传音频
        # （文档实测首帧 906ms → 276ms，且各段音色一致）
        fields['voice_id'] = voice_id
    elif ref_audio and ref_text:
        try:
            files['ref_audio'] = (Path(ref_audio).name, Path(ref_audio).read_bytes())
            fields['ref_text'] = ref_text
        except Exception as exc:
            logger.warning('[TTS] 读取参考音频失败: %s', exc)
    if instruction:
        fields['instruction'] = instruction
    if cfg_scale:
        fields['cfg_scale'] = str(cfg_scale)
    body, headers = _multipart(fields, files)
    request = urllib.request.Request(
        breeze_url() + '/v1/audio/speech', data=body, headers=headers, method='POST'
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout) as resp:
            pcm = resp.read()
    except Exception as exc:
        logger.warning('[TTS] Breeze 合成失败: %s', exc)
        return {'ok': False, 'error': f'Breeze 合成失败: {exc}', 'provider': 'breeze'}
    if len(pcm) < 4800:
        return {'ok': False, 'error': 'Breeze 返回音频过短', 'provider': 'breeze'}
    wav = _pcm_to_wav(pcm, channels=channels, sample_rate=sample_rate)
    digest = hashlib.sha1((content + str(time.time())).encode('utf-8')).hexdigest()[:16]
    target = cache_dir() / f'breeze-{digest}.wav'
    target.write_bytes(wav)
    # 每写一个就顺手裁剪，避免长期对话把磁盘吃满
    prune_cache()
    return {'ok': True, 'path': str(target), 'provider': 'breeze', 'seconds': round(len(pcm) / 2 / SAMPLE_RATE, 2)}


def doubao_speak(text: str, profile_id: str = '') -> Dict[str, Any]:
    from core.voice_clone import load_profiles, speak

    profiles = load_profiles()
    if not profiles:
        return {'ok': False, 'error': '还没有复刻音色', 'provider': 'doubao'}
    profile = profiles[0]
    if profile_id:
        profile = next((p for p in profiles if str(p.get('id')) == profile_id), profile)
    result = speak(text, str(profile.get('speaker_id') or ''))
    if not result.get('ok'):
        return {'ok': False, 'error': str(result.get('error') or '朗读失败'), 'provider': 'doubao'}
    return {
        'ok': True,
        'path': result.get('path') or result.get('audio_path') or '',
        'provider': 'doubao',
        'voice': profile.get('name'),
    }


def assistant_reference() -> Optional[Dict[str, str]]:
    """给助理朗读用的固定参考音色。

    Breeze 是零样本克隆模型：不给参考音频时，同一句话分几段合成，
    音色会在不同段之间漂（用户听感就是「一会儿少女一会儿御姐」）。
    这里固定用同一个已复刻音色做参考，保证每一段是同一个人的声音。
    """
    try:
        from core.voice_clone import load_profiles

        for profile in load_profiles():
            sample = str(profile.get('sample') or '')
            ref_text = str(profile.get('ref_text') or '').strip()
            if sample and Path(sample).is_file() and ref_text:
                return {'ref_audio': sample, 'ref_text': ref_text, 'name': str(profile.get('name') or '')}
    except Exception as exc:
        logger.debug('[TTS] 读取参考音色失败: %s', exc)
    return None


def speak(text: str, provider: str = 'auto', profile_id: str = '') -> Dict[str, Any]:
    """按优先级挑选引擎：breeze（本地）→ doubao（云端）→ 失败。"""
    auto = (provider or 'auto').lower()
    if auto in ('auto', 'breeze') and breeze_available():
        # 固定音色：配置了 ECHOMIND_ASSISTANT_VOICE 就走保存音色（voice_id），
        # 每段都是同一份编码好的参考，音色不会在句子之间漂。
        saved_voice = assistant_voice_id()
        if saved_voice:
            result = breeze_speak(text, instruction=voice_style(), voice_id=saved_voice)
            if result.get('ok'):
                return result
            logger.warning('[TTS] 保存音色合成失败，回退到普通路径: %s', result.get('error'))
        # 老路径：文本指令 + 每次上传参考音频（需显式开启）
        reference = (
            assistant_reference()
            if os.environ.get('ECHOMIND_ASSISTANT_VOICE_PROFILE') == '1'
            else None
        )
        if reference:
            result = breeze_speak(
                text,
                ref_audio=reference['ref_audio'],
                ref_text=reference['ref_text'],
                instruction=voice_style(),
            )
        else:
            result = breeze_speak(text, instruction=voice_style())
        if result.get('ok'):
            return result
        if auto == 'breeze':
            return result
    if auto in ('auto', 'doubao'):
        result = doubao_speak(text, profile_id)
        if result.get('ok'):
            return result
        if auto == 'doubao':
            return result
        return {'ok': False, 'error': '本地 Breeze 未启动，且豆包不可用：' + str(result.get('error')), 'provider': 'none'}
    return {'ok': False, 'error': '没有可用的语音引擎', 'provider': 'none'}


def status() -> Dict[str, Any]:
    from core.voice_clone import load_profiles

    return {
        'breeze_available': breeze_available(),
        'breeze_url': breeze_url(),
        'doubao_profiles': len(load_profiles()),
    }