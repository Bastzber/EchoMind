# -*- coding: utf-8 -*-
"""去人声（中置声道消除）。

原理：人声在混音里通常摆在正中，左右声道内容几乎相同。
把 L - R 相减，居中的成分（人声、底鼓、贝斯）被抵消，剩下的就是两侧的乐器。

适合：从立体声歌曲里抽一个能用的伴奏垫底。
不适合：人声偏左/偏右、或本身是单声道的素材。
"""
from __future__ import annotations

import logging
from pathlib import Path
from typing import Dict, Optional

logger = logging.getLogger(__name__)


def remove_vocals(source: str, destination: str, strength: float = 1.0) -> Dict[str, object]:
    """把 source 的人声尽量消掉，写到 destination（WAV，16bit 立体声）。

    strength = 1.0 是标准的中置消除；0.5 保留一点人声（有时更好听）。
    """
    import av
    import numpy as np

    src_path = Path(source)
    dst_path = Path(destination)
    if not src_path.is_file():
        return {"ok": False, "error": "源文件不存在"}

    try:
        with av.open(str(src_path)) as container:
            streams = [s for s in container.streams if s.type == "audio"]
            if not streams:
                return {"ok": False, "error": "没有音频流"}
            stream = streams[0]
            if (stream.channels or 0) < 2:
                return {"ok": False, "error": "需要立体声（单声道无法做中置消除）"}

            resampler = av.AudioResampler(format="fltp", layout="stereo", rate=stream.rate or 44100)
            left_chunks = []
            right_chunks = []
            for frame in container.decode(stream):
                for out_frame in resampler.resample(frame):
                    data = out_frame.to_ndarray()  # shape: (channels, samples)
                    if data.shape[0] < 2:
                        continue
                    left_chunks.append(data[0])
                    right_chunks.append(data[1])
            for out_frame in resampler.resample(None):
                data = out_frame.to_ndarray()
                if data.shape[0] >= 2:
                    left_chunks.append(data[0])
                    right_chunks.append(data[1])

        if not left_chunks:
            return {"ok": False, "error": "没有解出音频数据"}

        left = np.concatenate(left_chunks)
        right = np.concatenate(right_chunks)
        # 中置消除：左右相减；strength 控制抵消强度
        side = left - right * float(strength)
        # 归一化，避免削波
        peak = float(np.max(np.abs(side))) if side.size else 0.0
        if peak > 0.98:
            side = side * (0.98 / peak)

        stereo = np.stack([side, side])  # (2, samples)
        dst_path.parent.mkdir(parents=True, exist_ok=True)

        with av.open(str(dst_path), "w", format="wav") as output:
            out_stream = output.add_stream("pcm_s16le", rate=stream.rate or 44100)
            out_stream.layout = "stereo"
            samples_per_frame = 1024
            for start in range(0, stereo.shape[1], samples_per_frame):
                chunk = stereo[:, start:start + samples_per_frame]
                if chunk.shape[1] == 0:
                    continue
                frame = av.AudioFrame.from_ndarray(
                    chunk.astype("float32"), format="fltp", layout="stereo"
                )
                frame.sample_rate = stream.rate or 44100
                for packet in out_stream.encode(frame):
                    output.mux(packet)
            for packet in out_stream.encode(None):
                output.mux(packet)

        return {"ok": True, "samples": int(stereo.shape[1]), "error": ""}
    except Exception as exc:
        logger.warning("去人声失败 %s: %s", src_path.name, exc)
        return {"ok": False, "error": f"{type(exc).__name__}: {str(exc)[:160]}"}
