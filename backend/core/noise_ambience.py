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
