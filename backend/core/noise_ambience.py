# -*- coding: utf-8 -*-
"""程序化环境音：用噪声合成可无缝循环的风/雨/海/火。

所有信号都在频域构造（随机相位 → irfft），因此天然周期，
首尾相接不会有断层，也不需要交叉淡化。
"""
from __future__ import annotations

import numpy as np

SR = 48000


def _periodic_noise(seconds: float, shape) -> np.ndarray:
    """构造长度 = seconds 的严格周期噪声，shape(freqs) 返回幅度包络。"""
    n = int(seconds * SR)
    freqs = np.fft.rfftfreq(n, 1.0 / SR)
    magnitude = shape(freqs)
    phase = np.random.uniform(0, 2 * np.pi, len(freqs))
    spectrum = magnitude * np.exp(1j * phase)
    spectrum[0] = 0.0
    out = np.fft.irfft(spectrum, n).astype(np.float32)
    peak = float(np.max(np.abs(out))) or 1.0
    return out / peak


def _band(freqs, low, high, slope=1.0):
    low = max(low, 1.0)
    high = max(high, low + 1.0)
    band = np.zeros_like(freqs)
    band[(freqs >= low) & (freqs <= high)] = 1.0
    band[freqs < low] = (freqs[freqs < low] / low) ** slope
    band[freqs > high] = (high / freqs[freqs > high]) ** slope
    return band


def _lfo(n: int, seconds: float, rate: float, depth: float, phase: float = 0.0) -> np.ndarray:
    t = np.arange(n) / SR
    cycles = max(1.0, round(rate * seconds))
    wave = np.sin(2 * np.pi * cycles * t / seconds + phase)
    return (1.0 - depth + depth * (0.5 + 0.5 * wave)).astype(np.float32)


def _events(n: int, count: int, decay: float, low_freq: float = 1500.0) -> np.ndarray:
    """随机短脉冲（雨滴/火星），首尾环绕保证周期。"""
    out = np.zeros(n, dtype=np.float32)
    length = int(decay * SR)
    if length < 8:
        return out
    env = np.exp(-np.linspace(0, 6, length)).astype(np.float32)
    source = _periodic_noise(max(0.2, decay * 2), lambda f: _band(f, low_freq, low_freq * 3.0))
    for _ in range(count):
        start = np.random.randint(0, n)
        end = start + length
        piece = source[:length] * env
        if end <= n:
            out[start:end] += piece
        else:
            out[start:] += piece[: n - start]
            out[: end - n] += piece[n - start:]
    return out


# 每个配方的 4 条独立音轨 + 每条音轨受 x/y 控制的增益范围
STEM_MIX: dict = {
    "wind": {
        "base":   {"x": (0.02, 0.5), "y": (0.4, 1.0)},
        "gust":   {"x": (0.2, 0.55), "y": (0.0, 0.9)},
        "strong": {"x": (0.0, 1.0), "y": (0.25, 0.5)},
        "accent": {"x": (0.1, 0.3), "y": (0.0, 0.7)},
    },
    "rain": {
        "base":   {"x": (0.06, 0.7), "y": (0.35, 1.0)},
        "mid":    {"x": (0.2, 0.8), "y": (0.2, 0.45)},
        "drops":  {"x": (0.2, 0.5), "y": (0.1, 0.9)},
        "accent": {"x": (0.3, 0.6), "y": (0.0, 0.55)},
    },
    "sea": {
        "base":   {"x": (0.06, 0.7), "y": (0.5, 1.0)},
        "surge":  {"x": (0.2, 0.85), "y": (0.25, 0.6)},
        "foam":   {"x": (0.1, 0.4), "y": (0.0, 0.8)},
        "accent": {"x": (0.2, 0.5), "y": (0.0, 0.5)},
    },
    "forest": {
        "base":   {"x": (0.03, 0.5), "y": (0.5, 1.0)},
        "mid":    {"x": (0.15, 0.5), "y": (0.1, 0.6)},
        "drops":  {"x": (0.1, 0.5), "y": (0.0, 0.9)},
        "accent": {"x": (0.1, 0.4), "y": (0.0, 0.5)},
    },
    "fire": {
        "base":   {"x": (0.08, 0.7), "y": (0.6, 1.0)},
        "air":    {"x": (0.2, 0.5), "y": (0.1, 0.55)},
        "drops":  {"x": (0.25, 0.6), "y": (0.0, 0.9)},
        "accent": {"x": (0.15, 0.4), "y": (0.0, 0.6)},
    },
}


STEM_ORDER = ("base", "mid", "drops", "accent")


def user_stem_dir(kind: str):
    """%APPDATA%/EchoMind/ambience/<kind>/ —— 用户自备素材放这里就会优先使用。"""
    import os
    from pathlib import Path

    root = Path(os.environ.get("APPDATA", "")) / "EchoMind" / "ambience" / kind
    return root


def load_user_stems(kind: str, seconds: float = 6.0):
    """读取用户素材并做成可循环音轨；没有素材返回 None。"""
    try:
        from core.sound_recipe import _decode

        folder = user_stem_dir(kind)
        if not folder.exists():
            return None
        files = sorted(
            [p for p in folder.iterdir() if p.suffix.lower() in (".wav", ".mp3", ".flac", ".ogg")]
        )
        if not files:
            return None

        n = int(seconds * SR)
        fade = int(0.5 * SR)
        stems = {}
        for index, path in enumerate(files[:4]):
            samples = _decode(str(path))
            if samples is None or samples.size < SR // 2:
                continue
            if samples.size < n:
                reps = int(np.ceil(n / samples.size))
                samples = np.tile(samples, reps)
            seed = samples[: n + fade].astype(np.float32).copy()
            if fade < len(seed):
                ramp = np.linspace(0.0, 1.0, fade, dtype=np.float32)
                seed[:fade] = seed[:fade] * ramp + seed[n:n + fade] * (1.0 - ramp)
            chunk = seed[:n]
            peak = float(np.max(np.abs(chunk))) or 1.0
            stems[STEM_ORDER[min(index, 3)]] = (chunk / peak * 0.9).astype(np.float32)
        if not stems:
            return None
        for key in STEM_ORDER:
            stems.setdefault(key, np.zeros(n, dtype=np.float32))
        return stems
    except Exception:
        return None


_STEM_CACHE: dict = {}


def _bird_events(n: int, count: int, seconds: float) -> np.ndarray:
    """鸟鸣：短促的频率扫动（啾啾），首尾环绕保证周期。"""
    out = np.zeros(n, dtype=np.float32)
    for _ in range(count):
        length = int(np.random.uniform(0.05, 0.18) * SR)
        if length < 32:
            continue
        t = np.arange(length) / SR
        base = np.random.uniform(1800, 4200)
        sweep = base * (1.0 + np.random.uniform(-0.25, 0.35) * t / (t[-1] or 1))
        phase = 2 * np.pi * np.cumsum(sweep) / SR
        tone = np.sin(phase) * np.exp(-np.linspace(0, 5, length))
        start = np.random.randint(0, n)
        end = start + length
        if end <= n:
            out[start:end] += tone
        else:
            out[start:] += tone[: n - start]
            out[: end - n] += tone[n - start:]
    peak = float(np.max(np.abs(out))) or 1.0
    return (out / peak).astype(np.float32)


def synth_stems(kind: str, seconds: float = 6.0) -> dict:
    cached = _STEM_CACHE.get((kind, round(seconds, 1)))
    if cached is not None:
        return cached
    result = _synth_stems_impl(kind, seconds)
    _STEM_CACHE[(kind, round(seconds, 1))] = result
    return result


def _synth_stems_impl(kind: str, seconds: float = 6.0) -> dict:
    """返回 4 条同长度、同相位起点的循环音轨（播放端只调音量，永不重启）。"""
    n = int(seconds * SR)
    if kind == "wind":
        stems = {
            "base": _periodic_noise(seconds, lambda f: _band(f, 110, 700) * 0.9),
            "gust": _periodic_noise(seconds, lambda f: _band(f, 480, 2200)) * _lfo(n, seconds, 0.14, 0.9),
            "strong": _periodic_noise(seconds, lambda f: _band(f, 700, 3600)) * _lfo(n, seconds, 0.07, 0.6),
            "accent": _events(n, 12, 0.08, 1800) * 0.7,
        }
    elif kind == "rain":
        stems = {
            "base": _periodic_noise(seconds, lambda f: _band(f, 2500, 11000) * 0.85),
            "mid": _periodic_noise(seconds, lambda f: _band(f, 300, 1600) * 0.7),
            "drops": _events(n, 220, 0.045, 3200),
            "accent": _events(n, 24, 0.12, 1200),
        }
    elif kind == "sea":
        stems = {
            "base": _periodic_noise(seconds, lambda f: _band(f, 55, 900) * 0.9) * _lfo(n, seconds, 0.08, 0.85),
            "surge": _periodic_noise(seconds, lambda f: _band(f, 800, 2600) * 0.7) * _lfo(n, seconds, 0.1, 0.9, 1.7),
            "foam": _periodic_noise(seconds, lambda f: _band(f, 2400, 9500) * 0.5) * _lfo(n, seconds, 0.13, 0.95, 0.6),
            "accent": _events(n, 10, 0.2, 1400) * 0.8,
        }
    elif kind == "forest":
        stems = {
            "base": _periodic_noise(seconds, lambda f: _band(f, 400, 2400) * 0.35) * _lfo(n, seconds, 0.05, 0.5),
            "mid": _periodic_noise(seconds, lambda f: _band(f, 150, 700) * 0.25),
            "drops": _bird_events(n, 18, seconds),
            "accent": _bird_events(n, 5, seconds) * 0.7,
        }
    else:
        stems = {
            "base": _periodic_noise(seconds, lambda f: _band(f, 55, 520) * 0.9),
            "air": _periodic_noise(seconds, lambda f: _band(f, 850, 3200) * 0.45),
            "drops": _events(n, 90, 0.028, 1100),
            "accent": _events(n, 12, 0.09, 500),
        }
    out = {}
    for key, data in stems.items():
        data = data.astype(np.float32)
        peak = float(np.max(np.abs(data))) or 1.0
        out[key] = (data / peak * 0.9).astype(np.float32)
    return out


_CACHE: dict = {}


def warmup(kinds=("wind", "rain", "sea", "fire")) -> None:
    """启动时预热，避免第一次拖动卡住。"""
    for kind in kinds:
        for x, y in ((0.2, 0.3), (0.8, 0.8)):
            try:
                synth_ambience(kind, x, y, 6.0)
            except Exception:
                pass


def synth_ambience(kind: str, x: float, y: float, seconds: float = 6.0) -> np.ndarray:
    """带缓存：按 0.1 网格量化，拖动时命中率很高。"""
    key = (kind, round(x, 1), round(y, 1), round(seconds, 1))
    cached = _CACHE.get(key)
    if cached is not None:
        return cached
    result = _synth_impl(kind, x, y, seconds)
    if len(_CACHE) > 120:
        _CACHE.clear()
    _CACHE[key] = result
    return result


def _synth_impl(kind: str, x: float, y: float, seconds: float = 6.0) -> np.ndarray:
    """kind: wind / rain / sea / fire；x=强弱, y=细节。"""
    x = float(min(max(x, 0.0), 1.0))
    y = float(min(max(y, 0.0), 1.0))
    n = int(seconds * SR)

    if kind == "wind":
        base = _periodic_noise(seconds, lambda f: _band(f, 120, 900 + 900 * x) * 1.0)
        gust = _periodic_noise(seconds, lambda f: _band(f, 500, 2500 + 2500 * x) * (0.3 + 0.7 * y))
        gust *= _lfo(n, seconds, 0.15, 0.9)
        mix = base * (0.55 + 0.45 * x) + gust * (0.25 + 0.6 * y)
    elif kind == "rain":
        hiss = _periodic_noise(seconds, lambda f: _band(f, 1800, 12000) * 0.9)
        rumble = _periodic_noise(seconds, lambda f: _band(f, 80, 500) * (0.4 + 0.6 * x))
        drops = _events(n, int(40 + 220 * y), 0.05, 2500)
        mix = hiss * (0.5 + 0.4 * y) + rumble * 0.6 + drops * (0.35 + 0.5 * y)
    elif kind == "sea":
        body = _periodic_noise(seconds, lambda f: _band(f, 60, 1200 + 1200 * x) * 0.8)
        swell = _lfo(n, seconds, 0.09, 0.85)
        body *= swell
        foam = _periodic_noise(seconds, lambda f: _band(f, 2200, 9000) * (0.2 + 0.6 * y))
        foam *= _lfo(n, seconds, 0.11, 0.95, phase=1.2)
        mix = body * (0.6 + 0.4 * x) + foam * (0.15 + 0.45 * y)
    else:  # fire
        body = _periodic_noise(seconds, lambda f: _band(f, 60, 600) * (0.6 + 0.4 * x))
        air = _periodic_noise(seconds, lambda f: _band(f, 900, 4000) * 0.35)
        crackle = _events(n, int(8 + 70 * y), 0.03, 900)
        mix = body + air * (0.2 + 0.3 * y) + crackle * (0.4 + 0.6 * y)

    mix = mix.astype(np.float32)
    peak = float(np.max(np.abs(mix))) or 1.0
    if peak > 0.95:
        mix = mix * (0.95 / peak)
    return mix
