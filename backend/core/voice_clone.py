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
from __future__ import annotations

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


def add_profile(name: str, speaker_id: str, sample_path: str, duration: float = 0.0) -> Dict[str, object]:
    items = load_profiles()
    entry = {
        "id": uuid.uuid4().hex[:12],
        "name": (name or "未命名音色").strip()[:40],
        "speaker_id": speaker_id,
        "sample": sample_path,
        "duration": round(float(duration or 0), 2),
        "created_at": int(time.time()),
    }
    items.insert(0, entry)
    save_profiles(items)
    return entry


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
    return (os.environ.get("ECHOMIND_TTS_ENGINE") or "volc").strip().lower()


def clone_voice(audio_path: str, name: str, duration: float = 0.0) -> Dict[str, object]:
    """上传样音并把音色登记为档案。返回 {ok, speaker_id, profile, error}。"""
    source = Path(audio_path)
    if not source.is_file():
        return {"ok": False, "error": "样音文件不存在"}
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
