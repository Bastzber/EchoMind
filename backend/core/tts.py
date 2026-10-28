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


def _pcm_to_wav(pcm: bytes) -> bytes:
    buffer = io.BytesIO()
    with wave.open(buffer, 'wb') as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)
        wav.setframerate(SAMPLE_RATE)
        wav.writeframes(pcm)
    return buffer.getvalue()


def breeze_speak(
    text: str,
    ref_audio: Optional[str] = None,
    ref_text: Optional[str] = None,
    instruction: Optional[str] = None,
    cfg_scale: Optional[float] = None,
    timeout: float = 180.0,
) -> Dict[str, Any]:
    """调用本地 breeze-server 合成，返回 {ok, path, provider}。"""
    content = (text or '').strip()
    if not content:
        return {'ok': False, 'error': '文本不能为空'}
    fields: Dict[str, str] = {'text': content}
    files: Dict[str, tuple] = {}
    if ref_audio and ref_text:
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
    wav = _pcm_to_wav(pcm)
    digest = hashlib.sha1((content + str(time.time())).encode('utf-8')).hexdigest()[:16]
    target = cache_dir() / f'breeze-{digest}.wav'
    target.write_bytes(wav)
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


def speak(text: str, provider: str = 'auto', profile_id: str = '') -> Dict[str, Any]:
    """按优先级挑选引擎：breeze（本地）→ doubao（云端）→ 失败。"""
    auto = (provider or 'auto').lower()
    if auto in ('auto', 'breeze') and breeze_available():
        result = breeze_speak(text)
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