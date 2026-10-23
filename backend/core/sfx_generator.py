# -*- coding: utf-8 -*-
"""AI 音效生成：豆包语音 seed-audio-1.0（HTTP 非流式）。

- 端点: POST https://openspeech.bytedance.com/api/v3/tts/create
- 鉴权: X-Api-Key（豆包语音控制台 API Key，非方舟 ark key）
- 纯文本生成: text_prompt 直接描述音效，单次最长 120 秒，按秒计费
"""
import base64
import json
import logging
import os
import time
import urllib.request
import uuid
from pathlib import Path

logger = logging.getLogger(__name__)

API_URL = "https://openspeech.bytedance.com/api/v3/tts/create"
MODEL = "seed-audio-1.0"

_voice_api_key = ""
_save_dir: Path | None = None

_CONFIG_FILE = (
    Path(os.environ.get("APPDATA", "")) / "soundbot" / ".sfx_config.json"
)


def configure_voice_api_key(key: str) -> None:
    global _voice_api_key
    _voice_api_key = (key or "").strip()


def voice_api_key() -> str:
    return _voice_api_key


def is_configured() -> bool:
    return bool(_voice_api_key)


def load_config() -> None:
    """启动时读取磁盘上的 SFX 配置（覆盖 .env.ark 默认值）。"""
    global _voice_api_key, _save_dir
    try:
        if not _CONFIG_FILE.exists():
            return
        data = json.loads(_CONFIG_FILE.read_text(encoding="utf-8"))
        key = str(data.get("api_key") or "").strip()
        if key:
            _voice_api_key = key
        save_dir = str(data.get("save_dir") or "").strip()
        if save_dir:
            recovered = _recover_path(save_dir)
            if recovered is not None:
                _save_dir = recovered
            else:
                logger.warning(
                    "SFX 保存目录不存在或路径乱码，改用默认目录: %s", save_dir
                )
        logger.info("已从磁盘加载 SFX 配置（key=%s）", "有" if key else "无")
    except Exception as exc:
        logger.warning("加载 SFX 配置文件失败: %s", exc)


def save_config(api_key: str = "", save_dir: str = "") -> None:
    """把 SFX 配置写入磁盘（AI 设置界面调用）。"""
    global _voice_api_key, _save_dir
    if api_key:
        _voice_api_key = api_key.strip()
    if save_dir:
        try:
            _save_dir = Path(save_dir.strip())
        except Exception:
            pass
    payload = {}
    if _voice_api_key:
        payload["api_key"] = _voice_api_key
    if _save_dir:
        payload["save_dir"] = str(_save_dir)
    try:
        _CONFIG_FILE.parent.mkdir(parents=True, exist_ok=True)
        _CONFIG_FILE.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
        logger.info("SFX 配置已保存到磁盘")
    except Exception as exc:
        logger.error("保存 SFX 配置文件失败: %s", exc)


def configure_save_dir(path: str) -> None:
    global _save_dir
    if path:
        try:
            _save_dir = Path(path)
        except Exception:
            _save_dir = None


def _recover_path(raw: str) -> Path | None:
    """修复历史遗留的乱码路径（GBK 字节被当 UTF-8 读入）。"""
    candidates = [raw]
    for enc in ("gbk", "utf-8"):
        try:
            candidates.append(raw.encode("latin-1").decode(enc))
        except Exception:
            continue
    for candidate in candidates:
        try:
            path = Path(candidate)
            if path.exists():
                return path
        except Exception:
            continue
    return None


def get_save_dir() -> Path:
    """生成音效的保存目录（自动创建）。"""
    global _save_dir
    if not _save_dir:
        # 默认放到用户数据目录，避免写死开发机路径
        base = Path(os.environ.get("APPDATA", "") or ".") / "EchoMind"
        _save_dir = base / "AI生成音效"
    try:
        _save_dir.mkdir(parents=True, exist_ok=True)
    except Exception as exc:
        logger.error("创建 AI 生成音效目录失败: %s", exc)
    return _save_dir


def generate_sfx(
    text_prompt: str,
    sample_rate: int = 44100,
    fmt: str = "mp3",
    timeout: float = 300.0,
) -> tuple[bytes, float]:
    """调用豆包语音生成音效。

    Returns:
        (audio_bytes, duration_seconds)
    """
    if not _voice_api_key:
        raise RuntimeError("豆包语音 API Key 未配置（需开通豆包语音并在控制台获取 X-Api-Key）")
    if not text_prompt or not text_prompt.strip():
        raise RuntimeError("生成描述不能为空")

    audio_config = {"format": fmt, "sample_rate": sample_rate}
    body = json.dumps(
        {
            "model": MODEL,
            "text_prompt": text_prompt.strip()[:3000],
            "audio_config": audio_config,
            "watermark": {},
        },
        ensure_ascii=False,
    ).encode("utf-8")

    req = urllib.request.Request(API_URL, data=body, method="POST")
    req.add_header("Content-Type", "application/json")
    req.add_header("X-Api-Key", _voice_api_key)
    req.add_header("X-Api-Request-Id", str(uuid.uuid4()))

    t0 = time.time()
    # 这是国内服务，强制直连：用户开着系统代理时，走代理反而会连不上
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    with opener.open(req, timeout=timeout) as resp:
        raw = resp.read()
    logger.info("豆包语音响应 %d 字节，耗时 %.1fs", len(raw), time.time() - t0)

    payload = json.loads(raw.decode("utf-8"))
    code = payload.get("code")
    if code not in (None, 0, 3000, 3001):
        raise RuntimeError("豆包语音错误 code=%s msg=%s" % (code, payload.get("message")))

    audio_b64 = payload.get("audio")
    if not audio_b64:
        raise RuntimeError("豆包语音响应缺少 audio 数据")
    audio = base64.b64decode(audio_b64)
    duration = float(payload.get("duration") or payload.get("original_duration") or 0)
    if duration <= 0:
        # 无法从响应取到时长时按 10 秒默认（仅用于 UI 展示）
        duration = 10.0
    return audio, duration
