# -*- coding: utf-8 -*-
"""多声道工具：逐声道波形 + 按所选声道生成试听文件。

5.1 之类的音效有 6 个声道，播放器只播"整体"；
这里让用户能看到每个声道的波形，并单独听某一个声道。
"""
from __future__ import annotations

import hashlib
import json
import os
import tempfile
from pathlib import Path
from typing import Dict, List

MAX_CHANNELS = 8


def cache_dir() -> Path:
    base = Path(tempfile.gettempdir()) / "echomind-channels"
    base.mkdir(parents=True, exist_ok=True)
    return base


def _key(source: Path, extra: str = "") -> str:
    stat = source.stat()
    raw = f"{source.resolve()}|{int(stat.st_mtime)}|{stat.st_size}|{extra}".encode("utf-8", "ignore")
    return hashlib.sha1(raw).hexdigest()


def _decode(source: Path):
    """解码成 {channels, rate, data(ndarray[ch, samples])}。"""
    import av
    import numpy as np

    chunks = []
    rate = 44100
    channels = 2
    layout = None
    with av.open(str(source)) as container:
        stream = next((s for s in container.streams if s.type == "audio"), None)
        if stream is None:
            raise RuntimeError("没有音频流")
        rate = stream.rate or 44100
        channels = max(int(stream.channels or 1), 1)
        # PyAV 的 layout 对象 str() 出来是 "<av.AudioLayout '6 channels'>"，
        # 不能直接当布局名用；按声道数映射成 ffmpeg 认识的布局名。
        layout_map = {
            1: "mono", 2: "stereo", 3: "2.1", 4: "quad",
            5: "5.0", 6: "5.1", 7: "6.1", 8: "7.1",
        }
        layout = layout_map.get(channels)
        resampler = None
        if layout:
            try:
                resampler = av.AudioResampler(format="fltp", layout=layout, rate=rate)
            except Exception:
                resampler = None
        if resampler is None:
            # 声道数不在映射表里：用原布局对象，实在不行退回立体声
            try:
                resampler = av.AudioResampler(format="fltp", layout=stream.layout, rate=rate)
                layout = str(getattr(stream.layout, "name", layout) or layout)
            except Exception:
                resampler = av.AudioResampler(format="fltp", layout="stereo", rate=rate)
                layout = "stereo"
                channels = 2
        for frame in container.decode(stream):
            for out in resampler.resample(frame):
                chunks.append(out.to_ndarray())
        for out in resampler.resample(None):
            chunks.append(out.to_ndarray())

    if not chunks:
        raise RuntimeError("没有解出音频数据")
    data = np.concatenate(chunks, axis=1)
    return {"channels": int(data.shape[0]), "rate": int(rate), "data": data, "layout": layout}


def channel_peaks(source: str, points: int = 400) -> Dict[str, object]:
    """每个声道一条降采样峰值曲线，带缓存。"""
    import numpy as np

    src = Path(source)
    if not src.is_file():
        return {"ok": False, "error": "文件不存在"}
    points = max(50, min(int(points), 2000))
    target = cache_dir() / (_key(src, f"peaks{points}") + ".json")
    if target.is_file():
        try:
            return json.loads(target.read_text(encoding="utf-8"))
        except Exception:
            pass

    try:
        decoded = _decode(src)
        data = decoded["data"]
        total = data.shape[1]
        bucket = max(1, total // points)
        curves: List[List[float]] = []
        for channel in range(min(decoded["channels"], MAX_CHANNELS)):
            row = np.abs(data[channel])
            usable = (len(row) // bucket) * bucket
            if usable == 0:
                curves.append([0.0])
                continue
            reshaped = row[:usable].reshape(-1, bucket)
            peaks = reshaped.max(axis=1)
            peak_max = float(peaks.max()) or 1.0
            curves.append([round(float(v) / peak_max, 4) for v in peaks])
        result = {
            "ok": True,
            "channels": decoded["channels"],
            "layout": decoded.get("layout") or "",
            "rate": decoded["rate"],
            "duration": round(total / max(decoded["rate"], 1), 3),
            "peaks": curves,
        }
        target.write_text(json.dumps(result), encoding="utf-8")
        return result
    except Exception as exc:
        return {"ok": False, "error": f"{type(exc).__name__}: {str(exc)[:160]}"}


def render_channel_mix(source: str, audible: List[int]) -> Dict[str, object]:
    """生成试听文件：只保留 audible 里的声道（1 基），其余静音。"""
    import av

    src = Path(source)
    if not src.is_file():
        return {"ok": False, "error": "文件不存在"}
    key = _key(src, "mix" + ",".join(str(int(i)) for i in sorted(audible)))
    target = cache_dir() / (key + ".wav")
    if target.is_file() and target.stat().st_size > 64:
        return {"ok": True, "path": str(target), "cached": True, "error": ""}

    try:
        decoded = _decode(src)
        data = decoded["data"].copy()
        channels = decoded["channels"]
        wanted = {int(i) - 1 for i in audible if 1 <= int(i) <= channels}
        if wanted:
            for index in range(channels):
                if index not in wanted:
                    data[index, :] = 0.0

        tmp = target.with_suffix(".tmp.wav")
        with av.open(str(tmp), "w", format="wav") as output:
            out_stream = output.add_stream("pcm_s16le", rate=decoded["rate"])
            out_stream.layout = decoded.get("layout") or ("stereo" if channels == 2 else "mono")
            step = 1024
            for start in range(0, data.shape[1], step):
                block = data[:, start:start + step]
                if block.shape[1] == 0:
                    continue
                frame = av.AudioFrame.from_ndarray(block.astype("float32"), format="fltp",
                                                  layout=out_stream.layout)
                frame.sample_rate = decoded["rate"]
                for packet in out_stream.encode(frame):
                    output.mux(packet)
            for packet in out_stream.encode(None):
                output.mux(packet)
        os.replace(tmp, target)
        return {"ok": True, "path": str(target), "cached": False, "channels": channels, "error": ""}
    except Exception as exc:
        return {"ok": False, "error": f"{type(exc).__name__}: {str(exc)[:160]}"}
