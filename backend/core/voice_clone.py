# -*- coding: utf-8 -*-
r"""声音克隆：用一段 15 秒左右的人声复刻音色，再用这个音色念文本。

实现策略
--------
真正的音色复刻必须依赖模型或云服务，本项目采用"可插拔引擎"：

1. volc（默认）：豆包语音「声音复刻」，用设置里已配置的 API Key 调用；
   没有 Key 或接口不可用时会返回明确提示，而不是静默失败。
2. local：预留给本地模型（GPT-SoVITS / XTTS），装上后把
   ECHOMIND_TTS_ENGINE=local 指过去即可，业务代码不用改。

音色档案（speaker）存在用户目录，不写进音效库：
    %APPDATA%\EchoMind\voice_profiles\profiles.json
"""

import json
import os
import time
import urllib.error
import urllib.request
import uuid
from pathlib import Path
from typing import Dict, List, Optional

CLONE_URL = "https://openspeech.bytedance.com/api/v3/tts/upload_voice"
SPEAK_URL = "https://openspeech.bytedance.com/api/v3/tts/create"
DEFAULT_MODEL = "seed-audio-1.0"
MIN_SECONDS = 6.0
MAX_SECONDS = 60.0


def profile_dir() -> Path:
    base = Path(os.environ.get("APPDATA", "")) / "EchoMind" / "voice_profiles"
    base.mkdir(parents=True, exist_ok=True)
    return base


def _profiles_file() -> Path:
    return profile_dir() / "profiles.json"


def load_profiles() -> List[Dict[str, object]]:
    path = _profiles_file()
    if not path.is_file():
        return []
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        return data if isinstance(data, list) else []
    except Exception:
        return []


def save_profiles(items: List[Dict[str, object]]) -> None:
    _profiles_file().write_text(json.dumps(items, ensure_ascii=False, indent=2), encoding="utf-8")


def add_profile(
    name: str,
    speaker_id: str,
    sample_path: str,
    duration: float = 0.0,
    provider: str = "volc",
    ref_text: str = "",
) -> Dict[str, object]:
    items = load_profiles()
    entry = {
        "id": uuid.uuid4().hex[:12],
        "name": (name or "未命名音色").strip()[:40],
        "speaker_id": speaker_id,
        "sample": sample_path,
        "duration": round(float(duration or 0), 2),
        "provider": (provider or "volc"),
        "ref_text": (ref_text or "").strip()[:500],
        "created_at": int(time.time()),
    }
    items.insert(0, entry)
    save_profiles(items)
    return entry


def update_profile(profile_id: str, name=None, ref_text=None):
    """改名或修正样音文稿。"""
    items = load_profiles()
    updated = None
    for item in items:
        if str(item.get("id")) != str(profile_id):
            continue
        if name is not None and str(name).strip():
            item["name"] = str(name).strip()[:40]
        if ref_text is not None:
            item["ref_text"] = str(ref_text).strip()[:500]
        updated = item
        break
    if updated is None:
        return None
    save_profiles(items)
    return updated

def delete_profile(profile_id: str) -> bool:
    items = load_profiles()
    kept = [item for item in items if item.get("id") != profile_id]
    if len(kept) == len(items):
        return False
    save_profiles(kept)
    return True


def _api_key() -> str:
    """复用 AI 设置里保存的豆包语音 Key。"""
    try:
        from core import sfx_generator

        sfx_generator.load_config()
        return sfx_generator.voice_api_key()
    except Exception:
        return ""


def engine_name() -> str:
    """当前实际生效的合成引擎。

    以前直接返回 ECHOMIND_TTS_ENGINE 或默认字面量 volc —— 但 tts.py 里
    Breeze 是优先的，用户界面因此显示「引擎：volc」，而他的音色全是本地
    breeze 克隆的（11-04 截图反馈）。改成按实际可用性判断。
    """
    configured = (os.environ.get("ECHOMIND_TTS_ENGINE") or "").strip().lower()
    if configured:
        return configured
    try:
        from core import tts

        if tts.breeze_available():
            return "breeze"
    except Exception:
        pass
    return "volc"


# ==================== VoiceStudio（OmniVoice）引擎 ====================
# VoiceStudio 是独立进程：Electron 外壳 + FastAPI 后端，默认监听 127.0.0.1:3900。
# 它的接口正好是 OpenAI 兼容那一套：
#   克隆   POST /profiles        （multipart：name / ref_audio / ref_text）
#   合成   POST /v1/audio/speech （JSON：model / input / voice / response_format）
# 所以 EchoMind 这边只要多做两件事：把样音推过去建档案，以后按档案 id 合成。
VS_DEFAULT_URL = "http://127.0.0.1:3900"
VS_PROVIDER = "voicestudio"

# 本机直连必须绕开系统代理：这台机器上系统代理指向 127.0.0.1:7890，
# 代理没开的时候 urllib 会直接连不上（11-24 实测：VoiceStudio 明明活着，
# /voice/profiles 却报 voicestudio=False）。云端接口照旧走系统代理。
_VS_OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))


def _voicestudio_config_path() -> Path:
    base = Path(os.environ.get("APPDATA", "")) / "EchoMind"
    return base / "voicestudio.json"


def voicestudio_url() -> str:
    """VoiceStudio 后端地址：环境变量 > 配置文件 > 默认 3900。

    它会变：重装/换机器后端口不一定是 3900（11-24 实测重装后只剩 6761/6762）。
    配置写在用户目录下的 EchoMind/voicestudio.json：{"url": "http://127.0.0.1:3900"}。
    """
    configured = (os.environ.get("ECHOMIND_VOICESTUDIO_URL") or "").strip().rstrip("/")
    if configured:
        return configured
    try:
        path = _voicestudio_config_path()
        if path.is_file():
            data = json.loads(path.read_text(encoding="utf-8"))
            url = str(data.get("url") or "").strip().rstrip("/")
            if url:
                return url
    except Exception:
        pass
    return VS_DEFAULT_URL


VOICESTUDIO_CANDIDATE_PORTS = (3900, 3901, 6761, 6762)


def voicestudio_discover(timeout: float = 0.8) -> str:
    """在常见端口里探一遍，找到能回 /v1/models 的那个并记进配置。"""
    import socket

    seen = {voicestudio_url()}
    candidates = [voicestudio_url()]
    for port in VOICESTUDIO_CANDIDATE_PORTS:
        url = "http://127.0.0.1:%d" % int(port)
        if url not in candidates:
            candidates.append(url)
    for url in candidates:
        host_port = url.split("//", 1)[-1]
        host, _, port_text = host_port.partition(":")
        port = int(port_text or 80)
        probe = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        probe.settimeout(timeout)
        try:
            if probe.connect_ex((host or "127.0.0.1", port)) != 0:
                continue
        finally:
            probe.close()
        try:
            request = urllib.request.Request(url + "/v1/models", headers={"Accept": "application/json"})
            with _VS_OPENER.open(request, timeout=timeout + 1.0) as response:
                if int(getattr(response, "status", 200)) == 200:
                    if url not in seen:
                        try:
                            path = _voicestudio_config_path()
                            path.parent.mkdir(parents=True, exist_ok=True)
                            path.write_text(json.dumps({"url": url}, ensure_ascii=False, indent=1), encoding="utf-8")
                        except Exception:
                            pass
                    return url
        except Exception:
            continue
    return ""


def voicestudio_available(timeout: float = 3.0) -> bool:
    """VoiceStudio 后端在不在。只看 /v1/models，不加载任何模型。

    配置的地址不通时会顺手扫一遍常见端口（重装后端口会变），
    扫到了就写进配置文件，下次直接用。
    """
    def probe(url: str) -> bool:
        try:
            request = urllib.request.Request(url + "/v1/models", headers={"Accept": "application/json"})
            with _VS_OPENER.open(request, timeout=timeout) as response:
                return int(getattr(response, "status", 200)) == 200
        except Exception:
            return False

    if probe(voicestudio_url()):
        return True
    discovered = voicestudio_discover()
    return bool(discovered) and probe(discovered)


def _vs_post_multipart(path: str, fields: Dict[str, str], files: Dict[str, Path], timeout: float = 300.0) -> Dict[str, object]:
    boundary = "----echomind" + uuid.uuid4().hex
    body = bytearray()
    for key, value in fields.items():
        body += ("--%s\r\nContent-Disposition: form-data; name=\"%s\"\r\n\r\n%s\r\n" % (boundary, key, value)).encode("utf-8")
    for key, file_path in files.items():
        body += ("--%s\r\nContent-Disposition: form-data; name=\"%s\"; filename=\"%s\"\r\n"
                 "Content-Type: application/octet-stream\r\n\r\n" % (boundary, key, Path(file_path).name)).encode("utf-8")
        body += Path(file_path).read_bytes()
        body += b"\r\n"
    body += ("--%s--\r\n" % boundary).encode("utf-8")
    request = urllib.request.Request(
        voicestudio_url() + path,
        data=bytes(body),
        method="POST",
        headers={"Content-Type": "multipart/form-data; boundary=" + boundary},
    )
    with _VS_OPENER.open(request, timeout=timeout) as response:
        return json.loads(response.read().decode("utf-8", "ignore") or "{}")


def clone_voice_voicestudio(name: str, sample: Path, duration: float, ref_text: str) -> Dict[str, object]:
    """把样音推给 VoiceStudio 建音色档案，本地存一份指向它的记录。"""
    if not voicestudio_available():
        return {
            "ok": False,
            "error": "没连上 VoiceStudio（%s）。先把 VoiceStudio 打开，再回来克隆。" % voicestudio_url(),
        }
    fields = {"name": (name or "EchoMind").strip()[:60], "kind": "clone"}
    if (ref_text or "").strip():
        fields["ref_text"] = ref_text.strip()[:500]
    try:
        payload = _vs_post_multipart("/profiles", fields, {"ref_audio": sample})
    except urllib.error.HTTPError as exc:
        detail = ""
        try:
            detail = exc.read().decode("utf-8", "ignore")[:200]
        except Exception:
            pass
        return {"ok": False, "error": "VoiceStudio 建档案失败（%s）：%s" % (exc.code, detail or exc.reason)}
    except Exception as exc:
        return {"ok": False, "error": "连 VoiceStudio 出错：%s" % str(exc)[:180]}

    profile = payload.get("profile") if isinstance(payload.get("profile"), dict) else payload
    vs_id = str((profile or {}).get("id") or "").strip()
    if not vs_id:
        return {"ok": False, "error": "VoiceStudio 没有返回档案 id：" + str(payload)[:180]}
    entry = add_profile(
        (profile or {}).get("name") or name,
        vs_id,
        str(sample),
        duration,
        provider=VS_PROVIDER,
        ref_text=ref_text or "",
    )
    return {"ok": True, "speaker_id": vs_id, "profile": entry, "engine": VS_PROVIDER}


def _save_profile_fields(profile_id: str, **fields) -> None:
    items = load_profiles()
    for item in items:
        if str(item.get("id")) == str(profile_id):
            item.update(fields)
            break
    else:
        return
    save_profiles(items)


def ensure_voicestudio_profile(profile: Dict[str, object]) -> Dict[str, object]:
    """把 EchoMind 的音色档案映射成 VoiceStudio 档案（没有就拿样音现建一个）。

    为什么要这层映射：EchoMind 的音色列表里既有 breeze 档案也有豆包档案，
    用户在下拉框里换引擎时，不该被「这条档案是谁建的」绑死 —— 选中 VoiceStudio
    就用 VoiceStudio 的模型念。样音已经在档案里，推过去建档案只要十几秒，
    建过就记下 vs_profile_id，下次直接用。
    """
    existing = str(profile.get("vs_profile_id") or "").strip()
    if not existing and str(profile.get("provider") or "") == VS_PROVIDER:
        # 早期用 VoiceStudio 克隆的档案把 id 直接存在 speaker_id 里
        existing = str(profile.get("speaker_id") or "").strip()
    if existing:
        return {"ok": True, "id": existing, "cached": True}
    sample = str(profile.get("sample") or "")
    if not sample or not Path(sample).is_file():
        return {"ok": False, "error": "这个音色没有样音文件，VoiceStudio 复刻不了它"}
    if not voicestudio_available():
        return {"ok": False, "error": "没连上 VoiceStudio（%s）。先把 VoiceStudio 打开。" % voicestudio_url()}
    name = str(profile.get("name") or "EchoMind 音色")
    result = clone_voice_voicestudio(
        "%s（EchoMind）" % name,
        Path(sample),
        float(profile.get("duration") or 0.0),
        str(profile.get("ref_text") or ""),
    )
    if not result.get("ok"):
        return result
    vs_id = str(result.get("speaker_id") or "")
    if profile.get("id") and vs_id:
        _save_profile_fields(str(profile.get("id")), vs_profile_id=vs_id)
    return {"ok": True, "id": vs_id, "cached": False}


def vs_speak_to_cache(text: str, voice: str, speed: float = 1.0, model: str = "omnivoice") -> Dict[str, object]:
    """用 VoiceStudio 的档案合成一段语音，落到 EchoMind 的 tts_cache。"""
    if not (text or "").strip():
        return {"ok": False, "error": "文本不能为空"}
    if not voicestudio_available():
        return {
            "ok": False,
            "error": "没连上 VoiceStudio（%s）。先把 VoiceStudio 打开。" % voicestudio_url(),
        }
    payload = {
        "model": model,
        "input": text[:4000],
        "voice": str(voice or "default"),
        "response_format": "wav",
    }
    try:
        payload["speed"] = max(0.5, min(2.0, float(speed or 1.0)))
    except Exception:
        pass
    try:
        request = urllib.request.Request(
            voicestudio_url() + "/v1/audio/speech",
            data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
            method="POST",
            headers={"Content-Type": "application/json"},
        )
        with _VS_OPENER.open(request, timeout=600) as response:
            raw = response.read()
        if raw[:4] != b"RIFF":
            return {"ok": False, "error": "VoiceStudio 返回的不是 WAV：" + raw[:120].decode("utf-8", "ignore")}
        from core import tts as _tts

        target = _tts.cache_dir() / ("vs-%s.wav" % uuid.uuid4().hex[:12])
        target.write_bytes(raw)
        return {"ok": True, "path": str(target), "engine": VS_PROVIDER}
    except urllib.error.HTTPError as exc:
        detail = ""
        try:
            detail = exc.read().decode("utf-8", "ignore")[:200]
        except Exception:
            pass
        return {"ok": False, "error": "VoiceStudio 合成失败（%s）：%s" % (exc.code, detail or exc.reason)}
    except Exception as exc:
        return {"ok": False, "error": "%s: %s" % (type(exc).__name__, str(exc)[:180])}


def clone_voice(
    audio_path: str,
    name: str,
    duration: float = 0.0,
    provider: str = "volc",
    ref_text: str = "",
) -> Dict[str, object]:
    """登记音色。provider=breeze 时只存参考音频+文稿（零样本克隆，不联网）。"""
    source = Path(audio_path)
    if not source.is_file():
        return {"ok": False, "error": "样音文件不存在"}

    engine_key = (provider or "").strip().lower()
    if engine_key in (VS_PROVIDER, "vs"):
        return clone_voice_voicestudio(name, source, duration, ref_text)

    if engine_key in ("omnivoice", "builtin", "native"):
        # 内置 OmniVoice 是零样本：档案里只要样音 + 文稿，不需要任何外部服务
        text = (ref_text or "").strip()
        if not text:
            return {"ok": False, "error": "内置 OmniVoice 需要填写这段样音的文字稿（它靠它复用音色）"}
        entry = add_profile(name, "", str(source), duration, provider="omnivoice", ref_text=text)
        return {"ok": True, "speaker_id": "", "profile": entry, "engine": "omnivoice"}

    if engine_key == "breeze":
        text = (ref_text or "").strip()
        if not text:
            return {"ok": False, "error": "本地 Breeze 需要填写这段样音的文字稿"}
        entry = add_profile(name, "", str(source), duration, provider="breeze", ref_text=text)
        return {"ok": True, "speaker_id": "", "profile": entry}
    if duration and (duration < MIN_SECONDS or duration > MAX_SECONDS):
        return {"ok": False, "error": "样音时长需要在 %d-%d 秒之间（当前 %.1f 秒）" % (MIN_SECONDS, MAX_SECONDS, duration)}

    if engine_name() != "volc":
        return {"ok": False, "error": "本地引擎尚未安装。请安装 GPT-SoVITS/XTTS 并设置 ECHOMIND_TTS_ENGINE=local"}

    key = _api_key()
    if not key:
        return {"ok": False, "error": "还没有配置豆包语音 API Key。请到 设置 → AI 设置 → 音频生成 填写后再试。"}

    try:
        boundary = "----echomind" + uuid.uuid4().hex
        body = bytearray()
        body += ("--%s\r\nContent-Disposition: form-data; name=\"name\"\r\n\r\n%s\r\n" % (boundary, name or "EchoMind")).encode()
        body += ("--%s\r\nContent-Disposition: form-data; name=\"model\"\r\n\r\n%s\r\n" % (boundary, DEFAULT_MODEL)).encode()
        body += ("--%s\r\nContent-Disposition: form-data; name=\"file\"; filename=\"%s\"\r\n"
                 "Content-Type: application/octet-stream\r\n\r\n" % (boundary, source.name)).encode()
        body += source.read_bytes()
        body += ("\r\n--%s--\r\n" % boundary).encode()

        request = urllib.request.Request(
            CLONE_URL,
            data=bytes(body),
            method="POST",
            headers={
                "Content-Type": "multipart/form-data; boundary=" + boundary,
                "X-Api-Key": key,
                "X-Api-Resource-Id": "seed-tts-1.0",
            },
        )
        with urllib.request.urlopen(request, timeout=180) as response:
            payload = json.loads(response.read().decode("utf-8", "ignore") or "{}")
        speaker_id = str(
            payload.get("speaker_id")
            or (payload.get("data") or {}).get("speaker_id")
            or (payload.get("Result") or {}).get("SpeakerID")
            or ""
        )
        if not speaker_id:
            return {"ok": False, "error": "接口没有返回 speaker_id：" + str(payload)[:180]}
        profile = add_profile(name, speaker_id, str(source), duration)
        return {"ok": True, "speaker_id": speaker_id, "profile": profile}
    except urllib.error.HTTPError as exc:
        detail = ""
        try:
            detail = exc.read().decode("utf-8", "ignore")[:200]
        except Exception:
            pass
        return {"ok": False, "error": "复刻接口返回 %s：%s" % (exc.code, detail or exc.reason)}
    except Exception as exc:
        return {"ok": False, "error": "%s: %s" % (type(exc).__name__, str(exc)[:180])}


def speak(text: str, speaker_id: str, out_dir: Optional[str] = None) -> Dict[str, object]:
    """用克隆好的音色念一段文本，返回 wav 路径。"""
    content = (text or "").strip()
    if not content:
        return {"ok": False, "error": "文本不能为空"}
    if not speaker_id:
        return {"ok": False, "error": "缺少音色 ID"}

    key = _api_key()
    if not key:
        return {"ok": False, "error": "还没有配置豆包语音 API Key"}

    try:
        payload = {
            "model": DEFAULT_MODEL,
            "text": content[:1000],
            "voice": {"type": "speaker", "speaker_id": speaker_id},
        }
        request = urllib.request.Request(
            SPEAK_URL,
            data=json.dumps(payload).encode("utf-8"),
            method="POST",
            headers={
                "Content-Type": "application/json",
                "X-Api-Key": key,
                "X-Api-Resource-Id": "seed-tts-1.0",
            },
        )
        with urllib.request.urlopen(request, timeout=180) as response:
            raw = response.read()
        target_dir = Path(out_dir) if out_dir else profile_dir()
        target_dir.mkdir(parents=True, exist_ok=True)
        target = target_dir / ("voice_%s.wav" % uuid.uuid4().hex[:8])
        if raw[:4] == b"RIFF":
            target.write_bytes(raw)
        else:
            data = json.loads(raw.decode("utf-8", "ignore") or "{}")
            audio_b64 = data.get("audio") or (data.get("data") or {}).get("audio") or ""
            if not audio_b64:
                return {"ok": False, "error": "接口没有返回音频：" + str(data)[:180]}
            import base64

            target.write_bytes(base64.b64decode(audio_b64))
        return {"ok": True, "path": str(target), "text": content}
    except urllib.error.HTTPError as exc:
        detail = ""
        try:
            detail = exc.read().decode("utf-8", "ignore")[:200]
        except Exception:
            pass
        return {"ok": False, "error": "合成接口返回 %s：%s" % (exc.code, detail or exc.reason)}
    except Exception as exc:
        return {"ok": False, "error": "%s: %s" % (type(exc).__name__, str(exc)[:180])}
