# -*- coding: utf-8 -*-
"""效果器：给干声加混响（卷积混响，IR 程序生成，不依赖外部音频库）。

为什么用卷积而不是算法混响
--------------------------
程序生成一段指数衰减的噪声当作脉冲响应（IR），和干声做 FFT 卷积，
就能得到"房间/大厅/教堂/隧道"这类空间感，且完全离线、无额外依赖。
"""
from __future__ import annotations

import hashlib
import os
import tempfile
from pathlib import Path
from typing import Dict, List

# 预设：decay 衰减时间(秒) / predelay 预延迟(毫秒) / wet 默认干湿比 / damp 高频衰减
PRESETS = {
    "dry":        {"name": "干声", "decay": 0.0, "predelay": 0, "wet": 0.0, "damp": 0.0},
    "room_small": {"name": "小房间", "decay": 0.55, "predelay": 6, "wet": 0.34, "damp": 0.30},
    "room_large": {"name": "大房间", "decay": 1.15, "predelay": 12, "wet": 0.44, "damp": 0.25},
    "hall":       {"name": "大厅", "decay": 2.4, "predelay": 22, "wet": 0.52, "damp": 0.20},
    "church":     {"name": "教堂", "decay": 3.8, "predelay": 38, "wet": 0.58, "damp": 0.16},
    "tunnel":     {"name": "隧道", "decay": 1.7, "predelay": 8, "wet": 0.52, "damp": 0.12},
    "outdoor":    {"name": "户外", "decay": 0.75, "predelay": 28, "wet": 0.30, "damp": 0.40},
    "plate":      {"name": "板式", "decay": 1.9, "predelay": 4, "wet": 0.50, "damp": 0.08},
}

DEFAULT_PRESET = "room_large"
# 算法版本：改动 DSP 时递增，自动作废旧缓存
CACHE_VERSION = "3"


def cache_dir() -> Path:
    base = Path(tempfile.gettempdir()) / "echomind-effects"
    base.mkdir(parents=True, exist_ok=True)
    return base


def _key(source: Path, preset: str, wet: float) -> str:
    stat = source.stat()
    raw = f"{CACHE_VERSION}|{source.resolve()}|{int(stat.st_mtime)}|{stat.st_size}|{preset}|{round(wet, 3)}".encode(
        "utf-8", "ignore"
    )
    return hashlib.sha1(raw).hexdigest()


def _decode(source: Path):
    import av
    import numpy as np

    chunks = []
    rate = 44100
    channels = 2
    with av.open(str(source)) as container:
        stream = next((s for s in container.streams if s.type == "audio"), None)
        if stream is None:
            raise RuntimeError("没有音频流")
        rate = stream.rate or 44100
        channels = max(int(stream.channels or 1), 1)
        layout = {1: "mono", 2: "stereo"}.get(channels, "stereo")
        if channels > 2:
            # 多声道先折叠成立体声：取左/右，其余混进左右
            layout = "stereo"
        resampler = av.AudioResampler(format="fltp", layout=layout, rate=rate)
        for frame in container.decode(stream):
            for out in resampler.resample(frame):
                chunks.append(out.to_ndarray())
        for out in resampler.resample(None):
            chunks.append(out.to_ndarray())
    if not chunks:
        raise RuntimeError("没有解出音频数据")
    data = np.concatenate(chunks, axis=1)
    return {"rate": int(rate), "data": data}


def _impulse_response(rate: int, decay: float, predelay: float, damp: float):
    """指数衰减噪声当作 IR；damp 越大高频越少（更像软装房间）。"""
    import numpy as np

    length = max(int(rate * decay), 1)
    rng = np.random.default_rng(20261026)
    noise = rng.standard_normal(length).astype(np.float32)
    t = np.linspace(0, decay, length, dtype=np.float32)
    envelope = np.exp(-6.9 * t / max(decay, 1e-6)).astype(np.float32)
    ir = noise * envelope
    if damp > 0:
        # 简单一阶低通，模拟高频被吸收
        alpha = float(max(0.02, min(0.9, 1.0 - damp)))
        smoothed = np.empty_like(ir)
        acc = 0.0
        for index in range(length):
            acc = alpha * ir[index] + (1 - alpha) * acc
            smoothed[index] = acc
        ir = smoothed
    # 按能量归一化：让卷积后的湿声和干声量级接近，否则听起来"几乎没效果"
    energy = float(np.sqrt(np.sum(ir.astype(np.float64) ** 2)))
    ir = ir / (energy + 1e-9)
    pad = int(rate * predelay / 1000.0)
    if pad > 0:
        ir = np.concatenate([np.zeros(pad, dtype=np.float32), ir])
    return ir


def _fft_convolve(signal, ir):
    """完整卷积：保留混响尾巴，否则听起来会"没有混响"。"""
    import numpy as np

    size = len(signal) + len(ir) - 1
    nfft = 1 << (size - 1).bit_length()
    spec_signal = np.fft.rfft(signal, nfft)
    spec_ir = np.fft.rfft(ir, nfft)
    return np.fft.irfft(spec_signal * spec_ir, nfft)[:size].astype(np.float32)


def apply_effect(source: str, preset: str = DEFAULT_PRESET, wet: float = -1.0) -> Dict[str, object]:
    """返回 {ok, path, preset, wet, cached, error}。"""
    import av
    import numpy as np

    src = Path(source)
    if not src.is_file():
        return {"ok": False, "error": "文件不存在"}
    preset_key = preset if preset in PRESETS else DEFAULT_PRESET
    config = PRESETS[preset_key]
    wet_value = float(config["wet"]) if wet is None or wet < 0 else max(0.0, min(1.0, float(wet)))

    target = cache_dir() / (_key(src, preset_key, wet_value) + ".wav")
    if target.is_file() and target.stat().st_size > 64:
        return {"ok": True, "path": str(target), "preset": preset_key,
                "wet": wet_value, "cached": True, "error": ""}

    try:
        decoded = _decode(src)
        data = decoded["data"]
        rate = decoded["rate"]
        if preset_key == "dry" or config["decay"] <= 0:
            processed = data
        else:
            ir = _impulse_response(rate, float(config["decay"]), float(config["predelay"]), float(config["damp"]))
            wet_channels = []
            for channel in range(data.shape[0]):
                wet_signal = _fft_convolve(data[channel], ir)
                wet_channels.append(wet_signal)
            wet_data = np.stack(wet_channels)
            # 湿声量级对齐干声（按 RMS 缩放），再按用户湿声比例混合
            dry_rms = float(np.sqrt(np.mean(data.astype(np.float64) ** 2))) or 1e-6
            wet_rms = float(np.sqrt(np.mean(wet_data.astype(np.float64) ** 2))) or 1e-6
            # 湿声再抬一档：按 RMS 对齐后尾巴仍然偏轻，乘一个固定增益
            wet_data = wet_data * (dry_rms / wet_rms) * 5.0
            # 干声补零到湿声长度，尾巴才不会丢
            if wet_data.shape[1] > data.shape[1]:
                pad = wet_data.shape[1] - data.shape[1]
                data = np.pad(data, ((0, 0), (0, pad)))
            # 感知曲线：用户拖到 50% 时实际混入更多湿声
            mix = float(wet_value) ** 0.7
            processed = (1.0 - mix) * data + mix * wet_data
        # 软限幅：硬归一会把混响尾巴一起压小，听起来就"没效果"
        peak_out = float(np.max(np.abs(processed))) or 1.0
        if peak_out > 1.0:
            processed = np.tanh(processed)
            peak_out = float(np.max(np.abs(processed))) or 1.0
            if peak_out > 0.99:
                processed = processed * (0.99 / peak_out)

        layout = {1: "mono", 2: "stereo"}.get(int(processed.shape[0]), "stereo")
        tmp = target.with_suffix(".tmp.wav")
        with av.open(str(tmp), "w", format="wav") as output:
            out_stream = output.add_stream("pcm_s16le", rate=rate)
            out_stream.layout = layout
            step = 1024
            for start in range(0, processed.shape[1], step):
                block = processed[:, start:start + step]
                if block.shape[1] == 0:
                    continue
                frame = av.AudioFrame.from_ndarray(block.astype("float32"), format="fltp", layout=layout)
                frame.sample_rate = rate
                for packet in out_stream.encode(frame):
                    output.mux(packet)
            for packet in out_stream.encode(None):
                output.mux(packet)
        os.replace(tmp, target)
        return {"ok": True, "path": str(target), "preset": preset_key,
                "wet": wet_value, "cached": False, "error": ""}
    except Exception as exc:
        return {"ok": False, "error": f"{type(exc).__name__}: {str(exc)[:160]}"}
