# -*- coding: utf-8 -*-
"""音频转码：把剪辑软件不认的格式统一转成 WAV/MP3。

顺带用于"损坏文件救急"：解码时容忍中间坏帧，能救回坏点之前的部分。
"""
from __future__ import annotations

import logging
from pathlib import Path
from typing import Dict, Optional

logger = logging.getLogger(__name__)

SUPPORTED_TARGETS = ("wav", "mp3")

# 目标格式对应的编码参数
_TARGET_CONFIG = {
    "wav": {"format": "wav", "codec": "pcm_s16le", "extension": ".wav"},
    "mp3": {"format": "mp3", "codec": "libmp3lame", "extension": ".mp3"},
}


def target_extension(fmt: str) -> str:
    config = _TARGET_CONFIG.get(fmt.lower())
    if not config:
        raise ValueError(f"不支持的目标格式: {fmt}")
    return config["extension"]


def transcode_file(source: str, destination: str, target_format: str = "wav",
                   bitrate: Optional[str] = None, tolerate_errors: bool = True) -> Dict[str, object]:
    """把 source 转成 target_format 写到 destination。

    返回 {ok, frames, salvaged, error}。salvaged=True 表示中途遇到坏帧但救回了前面部分。
    """
    import av

    config = _TARGET_CONFIG.get(target_format.lower())
    if not config:
        return {"ok": False, "frames": 0, "salvaged": False, "error": f"不支持的目标格式: {target_format}"}

    src_path = Path(source)
    dst_path = Path(destination)
    if not src_path.is_file():
        return {"ok": False, "frames": 0, "salvaged": False, "error": "源文件不存在"}
    dst_path.parent.mkdir(parents=True, exist_ok=True)

    frames = 0
    salvaged = False
    error = ""

    try:
        with av.open(str(src_path)) as container:
            audio_streams = [s for s in container.streams if s.type == "audio"]
            if not audio_streams:
                return {"ok": False, "frames": 0, "salvaged": False, "error": "没有音频流"}
            stream = audio_streams[0]

            with av.open(str(dst_path), "w", format=config["format"]) as output:
                encoder = output.add_stream(config["codec"], rate=stream.rate or 44100)
                if target_format.lower() == "mp3" and bitrate:
                    encoder.bit_rate = int(bitrate.rstrip("kK")) * 1000

                try:
                    for frame in container.decode(stream):
                        frames += 1
                        for packet in encoder.encode(frame):
                            output.mux(packet)
                except Exception as exc:  # 坏帧：能救多少救多少
                    if not tolerate_errors:
                        raise
                    salvaged = True
                    error = f"{type(exc).__name__}: {exc}"[:200]
                    logger.warning("转码中途遇到坏帧 %s: %s", src_path.name, exc)

                for packet in encoder.encode(None):
                    output.mux(packet)
    except Exception as exc:
        return {"ok": False, "frames": frames, "salvaged": salvaged, "error": f"{type(exc).__name__}: {exc}"[:200]}

    if not frames:
        try:
            dst_path.unlink()
        except OSError:
            pass
        return {"ok": False, "frames": 0, "salvaged": False, "error": error or "一个音频帧都没解出来"}

    return {"ok": True, "frames": frames, "salvaged": salvaged, "error": error}


def probe_format(path: str) -> str:
    """探测真实容器格式（用来发现"扩展名骗人"的文件）。"""
    try:
        import av
        with av.open(str(path)) as container:
            return container.format.name or ""
    except Exception:
        return ""
