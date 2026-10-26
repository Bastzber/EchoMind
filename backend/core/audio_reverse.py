# -*- coding: utf-8 -*-
"""倒放：把音频反向后写成临时 WAV，供播放器直接播放。

播放器本身是 <audio>，没法直接倒着播；这里生成一个反向文件，
前端按原路径 + mtime 缓存，同一文件不会重复生成。
"""
from __future__ import annotations

import hashlib
import os
import tempfile
from pathlib import Path
from typing import Dict


def reverse_cache_dir() -> Path:
    base = Path(tempfile.gettempdir()) / "echomind-reverse"
    base.mkdir(parents=True, exist_ok=True)
    return base


def _cache_key(source: Path) -> str:
    stat = source.stat()
    raw = f"{source.resolve()}|{int(stat.st_mtime)}|{stat.st_size}".encode("utf-8", "ignore")
    return hashlib.sha1(raw).hexdigest()


def reverse_to_wav(source: str) -> Dict[str, object]:
    """返回 {ok, path, duration, cached, error}。"""
    import av
    import numpy as np

    src = Path(source)
    if not src.is_file():
        return {"ok": False, "error": "源文件不存在"}

    target = reverse_cache_dir() / (_cache_key(src) + "_rev.wav")
    if target.is_file() and target.stat().st_size > 64:
        return {"ok": True, "path": str(target), "cached": True, "error": ""}

    try:
        chunks = []
        rate = 44100
        layout = "stereo"
        with av.open(str(src)) as container:
            stream = next((s for s in container.streams if s.type == "audio"), None)
            if stream is None:
                return {"ok": False, "error": "没有音频流"}
            rate = stream.rate or 44100
            layout = "stereo" if (stream.channels or 0) >= 2 else "mono"
            resampler = av.AudioResampler(format="fltp", layout=layout, rate=rate)
            for frame in container.decode(stream):
                for out in resampler.resample(frame):
                    chunks.append(out.to_ndarray())
            for out in resampler.resample(None):
                chunks.append(out.to_ndarray())

        if not chunks:
            return {"ok": False, "error": "没有解出音频数据"}

        data = np.concatenate(chunks, axis=1)[:, ::-1]  # 沿时间轴反转
        channels = int(data.shape[0])

        tmp_target = target.with_suffix(".tmp.wav")
        with av.open(str(tmp_target), "w", format="wav") as output:
            out_stream = output.add_stream("pcm_s16le", rate=rate)
            out_stream.layout = layout
            step = 1024
            for start in range(0, data.shape[1], step):
                block = data[:, start:start + step]
                if block.shape[1] == 0:
                    continue
                frame = av.AudioFrame.from_ndarray(block.astype("float32"), format="fltp", layout=layout)
                frame.sample_rate = rate
                for packet in out_stream.encode(frame):
                    output.mux(packet)
            for packet in out_stream.encode(None):
                output.mux(packet)

        os.replace(tmp_target, target)
        return {
            "ok": True,
            "path": str(target),
            "duration": round(data.shape[1] / max(rate, 1), 3),
            "channels": channels,
            "cached": False,
            "error": "",
        }
    except Exception as exc:
        return {"ok": False, "error": f"{type(exc).__name__}: {str(exc)[:160]}"}
