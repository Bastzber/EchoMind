# -*- coding: utf-8 -*-
"""声音配方：用分层采样 + 参数映射「演奏」出一个音效。

与 AI 文本生成的区别：这里是本地、毫秒级、可实时调节的。
每个配方 = 若干层样本 + 两个轴（远近 / 轻重），
轴的值映射到低通、增益、音高与各层的触发概率。
"""
from __future__ import annotations

import io
import logging
import math
import random
import wave
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional, Sequence, Tuple

import numpy as np

logger = logging.getLogger(__name__)

TARGET_SR = 48000


@dataclass
class Layer:
    id: str
    pool: List[str]
    gain_db: float = 0.0
    prob: float = 1.0
    offset_ms: Tuple[int, int] = (0, 0)
    pitch_span: float = 0.0
    trim_seconds: float = 1.2
    label: str = ""
    strength_gain: float = 0.0      # x=1（最强）时额外增益
    prob_min: float = -1.0          # y=0（纯净）时的触发概率
    prob_max: float = -1.0          # y=1（丰富）时的触发概率
    audio: List[np.ndarray] = field(default_factory=list)

    def ensure_audio(self, max_seconds: float = 1.2) -> None:
        """首次触发时解码并缓存，之后每次触发都是纯内存操作。"""
        if self.audio:
            return
        for path in self.pool:
            samples = _decode(path)
            if samples is None or samples.size == 0:
                continue
            self.audio.append(_onset_trim(samples, max_seconds))
            if len(self.audio) >= 12:
                break


@dataclass
class Recipe:
    id: str
    name: str
    category: str
    layers: List[Layer] = field(default_factory=list)
    mode: str = "step"   # step: X=远近 Y=轻重；env: X=强弱 Y=细节
    synth: str = ""      # wind / rain / sea / fire：程序化合成，不用库内素材

    def to_dict(self) -> Dict[str, Any]:
        return {
            "id": self.id,
            "name": self.name,
            "category": self.category,
            "mode": self.mode,
            "layers": [
                {
                    "id": l.id,
                    "label": l.label or l.id,
                    "pool": len(l.pool),
                    "prob": l.prob,
                    "gain_db": l.gain_db,
                    "strength_gain": l.strength_gain,
                    "samples": [p for p in l.pool[:20]],
                }
                for l in self.layers
            ],
        }


def _db_to_gain(db: float) -> float:
    return 10 ** (float(db) / 20.0)


def _decode(path: str) -> Optional[np.ndarray]:
    """解码为 48k 单声道 float32；失败返回 None。"""
    try:
        from core.audio_service import get_audio_service

        decoded = get_audio_service().decode(path, mono=True)
        samples = np.asarray(decoded.samples, dtype=np.float32)
        if samples.ndim > 1:
            samples = samples.mean(axis=1)
        sr = int(decoded.sample_rate or TARGET_SR)
        if sr != TARGET_SR and len(samples):
            n = int(len(samples) * TARGET_SR / sr)
            idx = np.linspace(0, len(samples) - 1, max(n, 1))
            samples = np.interp(idx, np.arange(len(samples)), samples).astype(np.float32)
        peak = float(np.max(np.abs(samples))) if samples.size else 0.0
        if peak > 1.0:
            samples = samples / peak
        return samples
    except Exception as exc:
        logger.debug("解码样本失败 %s: %s", path, exc)
        return None


def _pitch_shift(samples: np.ndarray, semitones: float) -> np.ndarray:
    """用线性重采样做粗糙移调（够用且快）。"""
    if abs(semitones) < 0.05 or samples.size == 0:
        return samples
    ratio = 2 ** (float(semitones) / 12.0)
    new_len = max(1, int(len(samples) / ratio))
    idx = np.linspace(0, len(samples) - 1, new_len)
    return np.interp(idx, np.arange(len(samples)), samples).astype(np.float32)


def _lowpass(samples: np.ndarray, cutoff_hz: float) -> np.ndarray:
    """一阶低通（频域实现，避免 Python 逐样本循环拖慢触发）。"""
    if samples.size < 16 or cutoff_hz >= TARGET_SR / 2.2:
        return samples
    spectrum = np.fft.rfft(samples)
    freqs = np.fft.rfftfreq(len(samples), 1.0 / TARGET_SR)
    spectrum = spectrum / np.sqrt(1.0 + (freqs / max(cutoff_hz, 60.0)) ** 2)
    return np.fft.irfft(spectrum, len(samples)).astype(np.float32)


def _onset_trim(samples: np.ndarray, max_seconds: float = 0.45) -> np.ndarray:
    """只保留第一个起音后的短片段：保证一次触发 = 一步，而不是一串脚步。"""
    if samples.size == 0:
        return samples
    peak = float(np.max(np.abs(samples)))
    if peak <= 0:
        return samples
    threshold = peak * 0.15
    voiced = np.where(np.abs(samples) > threshold)[0]
    start = int(voiced[0]) if voiced.size else 0
    # 起音前留 10ms，避免削掉瞬态头
    start = max(0, start - int(0.01 * TARGET_SR))
    end = min(len(samples), start + int(max_seconds * TARGET_SR))
    return _trim(samples[start:end], max_seconds)


def _trim(samples: np.ndarray, max_seconds: float = 4.0) -> np.ndarray:
    """单个样本截断 + 淡入淡出，避免长素材把一次触发拉成几十秒。"""
    limit = int(max_seconds * TARGET_SR)
    if len(samples) > limit:
        samples = samples[:limit]
    fade = min(int(0.008 * TARGET_SR), len(samples) // 4)
    if fade > 1:
        ramp = np.linspace(0.0, 1.0, fade, dtype=np.float32)
        samples[:fade] *= ramp
        samples[-fade:] *= ramp[::-1]
    return samples


_SAMPLE_CACHE: Dict[str, np.ndarray] = {}


def _load_single(path: str, trim_seconds: float = 0.9) -> Optional[np.ndarray]:
    cached = _SAMPLE_CACHE.get(path)
    if cached is not None:
        return cached
    samples = _decode(path)
    if samples is None or samples.size == 0:
        return None
    samples = _onset_trim(samples, trim_seconds)
    _SAMPLE_CACHE[path] = samples
    return samples


def list_recipe_samples(recipe: Recipe, limit: int = 30) -> List[Dict[str, Any]]:
    """列出配方主层的候选样本（供「选择素材」用）。"""
    import os as _os

    out: List[Dict[str, Any]] = []
    seen = set()
    for layer in recipe.layers:
        for path in layer.pool:
            if path in seen:
                continue
            seen.add(path)
            try:
                size = _os.path.getsize(path)
            except OSError:
                size = 0
            out.append(
                {
                    "path": path,
                    "filename": _os.path.basename(path),
                    "size": size,
                    "layer": layer.id,
                }
            )
            if len(out) >= limit:
                return out
    return out


def render_hit(
    recipe: Recipe,
    x: float,
    y: float,
    seed: Optional[int] = None,
    sample: Optional[str] = None,
    variation: float = 1.0,
    enabled: Optional[Sequence[str]] = None,
    layer_samples: Optional[Dict[str, str]] = None,
) -> np.ndarray:
    """x=远近(0 近,1 远)  y=轻重(0 轻,1 重)。返回混好的单声道 float32。"""
    rng = random.Random(seed)
    x = min(max(float(x), 0.0), 1.0)
    y = min(max(float(y), 0.0), 1.0)

    cutoff = 18000 * (2500 / 18000) ** x        # 远处更闷
    gain_db = -9.0 * x                           # 远处更轻
    pitch_semi = 3.0 - 7.0 * y                   # 重步更低沉

    pieces: List[Tuple[int, np.ndarray]] = []
    variation = min(max(float(variation), 0.0), 1.0)

    # 指定了单个素材：只播这一条，不叠任何层（最干净）
    if sample:
        single = _load_single(sample, 0.9)
        if single is not None:
            jitter_pitch = rng.uniform(-0.25, 0.25) * variation
            jitter_gain = rng.uniform(-1.5, 1.5) * variation
            single = _pitch_shift(single, pitch_semi + jitter_pitch)
            single = single * _db_to_gain(gain_db + jitter_gain)
            rms = float(np.sqrt(np.mean(np.square(single)))) if single.size else 0.0
            if rms > 1e-5:
                single = single * (0.12 / rms)
            single = _trim_compat(single)
            pieces.append((0, single))
            buffer = _finalize(pieces, cutoff)
            return buffer

    enabled_set = set(enabled) if enabled else None
    for layer in recipe.layers:
        if enabled_set is not None and layer.id not in enabled_set:
            continue
        # env 模式：y 控制细节层概率，x 控制强度层增益
        if recipe.mode == "env" and layer.prob_max >= 0:
            layer_prob = layer.prob_min + (layer.prob_max - layer.prob_min) * y
        else:
            layer_prob = layer.prob
        if rng.random() > layer_prob:
            continue
        if not layer.pool:
            continue
        # 单层指定素材：优先用用户选的那条
        override_path = (layer_samples or {}).get(layer.id)
        if override_path:
            single = _load_single(override_path, layer.trim_seconds)
            if single is not None:
                extra_gain = layer.strength_gain * x if recipe.mode == "env" else 0.0
                pieces.append((0, single * _db_to_gain(layer.gain_db + gain_db + extra_gain)))
                continue

        if not layer.audio:
            layer.ensure_audio(layer.trim_seconds)
            # 干净优先：只保留最短的一批样本（长样本往往是一串脚步/带环境）
            if layer.audio:
                layer.audio.sort(key=lambda arr: len(arr))
                layer.audio = layer.audio[: max(3, len(layer.audio) // 2)]
        if not layer.audio:
            continue
        samples = rng.choice(layer.audio)
        # 响度归一：避免某条样本特别轻/特别响把整体搞脏
        rms = float(np.sqrt(np.mean(np.square(samples)))) if samples.size else 0.0
        if rms > 1e-5:
            samples = samples * (0.12 / rms)
        samples = _pitch_shift(samples, pitch_semi + rng.uniform(-layer.pitch_span, layer.pitch_span))
        offset_ms = rng.randint(*layer.offset_ms)
        extra_gain = layer.strength_gain * x if recipe.mode == "env" else 0.0
        pieces.append(
            (int(offset_ms * TARGET_SR / 1000), samples * _db_to_gain(layer.gain_db + gain_db + extra_gain))
        )

    if not pieces:
        return np.zeros(int(0.2 * TARGET_SR), dtype=np.float32)

    total = max(offset + len(samples) for offset, samples in pieces)
    buffer = np.zeros(total, dtype=np.float32)
    for offset, samples in pieces:
        buffer[offset:offset + len(samples)] += samples
    buffer = _lowpass(buffer, cutoff)
    # 高通掉 90Hz 以下的低频轰鸣（房间噪声常在这里）
    if buffer.size > 32:
        spec = np.fft.rfft(buffer)
        freqs = np.fft.rfftfreq(len(buffer), 1.0 / TARGET_SR)
        spec = spec * np.clip(freqs / 90.0, 0.0, 1.0)
        buffer = np.fft.irfft(spec, len(buffer)).astype(np.float32)

    # 触发结果控制在 1.0 秒内，并做尾部淡出，避免"一步"拖着长长尾巴
    limit = int(1.0 * TARGET_SR)
    if len(buffer) > limit:
        buffer = buffer[:limit]
    tail = min(int(0.07 * TARGET_SR), len(buffer) // 3)
    if tail > 1:
        buffer[-tail:] *= np.linspace(1.0, 0.0, tail, dtype=np.float32)
    peak = float(np.max(np.abs(buffer))) if buffer.size else 0.0
    if peak > 0.98:
        buffer = buffer * (0.98 / peak)
    return buffer


def _trim_compat(samples: np.ndarray) -> np.ndarray:
    tail = min(int(0.07 * TARGET_SR), len(samples) // 3)
    if tail > 1:
        samples = samples.copy()
        samples[-tail:] *= np.linspace(1.0, 0.0, tail, dtype=np.float32)
    return samples


def _finalize(pieces: List[Tuple[int, np.ndarray]], cutoff: float) -> np.ndarray:
    total = max(offset + len(samples) for offset, samples in pieces)
    buffer = np.zeros(total, dtype=np.float32)
    for offset, samples in pieces:
        buffer[offset:offset + len(samples)] += samples
    buffer = _lowpass(buffer, cutoff)
    if buffer.size > 32:
        spec = np.fft.rfft(buffer)
        freqs = np.fft.rfftfreq(len(buffer), 1.0 / TARGET_SR)
        buffer = np.fft.irfft(spec * np.clip(freqs / 90.0, 0.0, 1.0), len(buffer)).astype(np.float32)
    limit = int(1.0 * TARGET_SR)
    if len(buffer) > limit:
        buffer = buffer[:limit]
    buffer = _trim_compat(buffer)
    peak = float(np.max(np.abs(buffer))) if buffer.size else 0.0
    if peak > 0.98:
        buffer = buffer * (0.98 / peak)
    return buffer


def render_session(recipe: Recipe, events: Sequence[Dict[str, Any]], max_seconds: float = 60.0) -> np.ndarray:
    """按事件时间戳把多次 hit 拼接成一段音频（用于「完成录制」）。"""
    limit = int(max_seconds * TARGET_SR)
    buffer = np.zeros(limit, dtype=np.float32)
    for event in events:
        t = float(event.get("t", 0) or 0)
        if t < 0 or t >= max_seconds:
            continue
        hit = render_hit(
            recipe,
            event.get("x", 0.3),
            event.get("y", 0.5),
            None,
            event.get("sample"),
            float(event.get("variation", 1.0) or 0),
        )
        start = int(t * TARGET_SR)
        end = min(limit, start + len(hit))
        if end > start:
            buffer[start:end] += hit[: end - start]
    peak = float(np.max(np.abs(buffer))) if buffer.size else 0.0
    if peak > 0.98:
        buffer = buffer * (0.98 / peak)
    return buffer


def render_ambience(
    recipe: Recipe,
    x: float,
    y: float,
    seconds: float = 6.0,
    variation: float = 1.0,
    enabled: Optional[Sequence[str]] = None,
    layer_samples: Optional[Dict[str, str]] = None,
) -> np.ndarray:
    """渲染一段可无缝循环的环境床。

    配方带 synth（wind/rain/sea/fire）时用程序化噪声合成，天然无断层。
    """
    if recipe.synth:
        from core.noise_ambience import synth_ambience

        return synth_ambience(recipe.synth, x, y, seconds)

    rng = random.Random()
    x = min(max(float(x), 0.0), 1.0)
    y = min(max(float(y), 0.0), 1.0)
    total = int(seconds * TARGET_SR)
    fade = int(0.35 * TARGET_SR)
    buffer = np.zeros(total + fade, dtype=np.float32)
    enabled_set = set(enabled) if enabled else None

    for layer in recipe.layers:
        if enabled_set is not None and layer.id not in enabled_set:
            continue
        layer_prob = (
            layer.prob_min + (layer.prob_max - layer.prob_min) * y
            if layer.prob_max >= 0 else layer.prob
        )
        if rng.random() > max(layer_prob, 0.02):
            continue
        override = (layer_samples or {}).get(layer.id)
        if override:
            source = _load_single(override, 2.4)
        else:
            if not layer.audio:
                layer.ensure_audio(layer.trim_seconds)
            if not layer.audio:
                continue
            source = rng.choice(layer.audio)
        if source is None or source.size == 0:
            continue

        gain = _db_to_gain(layer.gain_db - 6.0 * x)
        if layer.strength_gain:
            gain *= _db_to_gain(layer.strength_gain * x)

        is_bed = layer.id in ("base", "bed", "open", "step")
        if is_bed:
            # 底声：循环铺满整段，首尾交叉淡化保证无缝
            pos = 0
            while pos < total + fade:
                chunk = source * gain
                end = min(len(buffer), pos + len(chunk))
                buffer[pos:end] += chunk[: end - pos]
                pos += len(chunk) - int(0.05 * TARGET_SR)
        else:
            # 细节层：随机点缀若干次
            count = max(1, int(seconds * (0.6 + layer_prob * 2.5)))
            for _ in range(count):
                start = rng.randint(0, max(1, total - len(source)))
                end = min(len(buffer), start + len(source))
                buffer[start:end] += source[: end - start] * gain

    # 首尾交叉淡化 → 可无缝 loop
    head = buffer[:fade].copy()
    tail = buffer[total:total + fade]
    ramp = np.linspace(0.0, 1.0, fade, dtype=np.float32)
    buffer[total:total + fade] = tail * (1.0 - ramp) + head * ramp
    out = buffer[:total]
    peak = float(np.max(np.abs(out))) if out.size else 0.0
    if peak > 0.95:
        out = out * (0.95 / peak)
    return out


def render_ambience_performance(
    recipe: Recipe,
    events: Sequence[Dict[str, Any]],
    max_seconds: float = 60.0,
    enabled: Optional[Sequence[str]] = None,
    layer_samples: Optional[Dict[str, str]] = None,
) -> np.ndarray:
    """按用户拖动轨迹，把多段环境床首尾交叉淡化拼成一段录音。"""
    total = int(max_seconds * TARGET_SR)
    buffer = np.zeros(total, dtype=np.float32)
    if not events:
        return buffer

    points = sorted(
        (
            {
                "t": float(e.get("t", 0) or 0),
                "x": float(e.get("x", 0.5) or 0.5),
                "y": float(e.get("y", 0.5) or 0.5),
            }
            for e in events
        ),
        key=lambda item: item["t"],
    )

    # 合并过密的轨迹点：拖动时每 450ms 一个点，逐点拼接会产生很多接缝
    merged = []
    for point in points:
        if merged and point["t"] - merged[-1]["t"] < 1.0:
            merged[-1] = point
        else:
            merged.append(point)
    points = merged

    fade = int(0.4 * TARGET_SR)
    for index, point in enumerate(points):
        start = int(max(0.0, point["t"]) * TARGET_SR)
        if start >= total:
            break
        end_t = points[index + 1]["t"] if index + 1 < len(points) else max_seconds
        segment_seconds = max(0.8, min(end_t - point["t"] + 0.5, 8.0))
        segment = render_ambience(
            recipe, point["x"], point["y"], segment_seconds, 1.0, enabled, layer_samples
        )
        # 段落首尾淡入淡出，拼接处自然
        seg_fade = min(fade, len(segment) // 3)
        if seg_fade > 1:
            ramp = np.linspace(0.0, 1.0, seg_fade, dtype=np.float32)
            segment[:seg_fade] *= ramp
            segment[-seg_fade:] *= ramp[::-1]
        end = min(total, start + len(segment))
        if end > start:
            buffer[start:end] += segment[: end - start]

    # 与前端播放时的主增益（0.45）对齐，避免"试听比实时听到的响很多"
    buffer = buffer * 0.225
    peak = float(np.max(np.abs(buffer))) if buffer.size else 0.0
    if peak > 0.95:
        buffer = buffer * (0.95 / peak)
    return buffer


def to_wav_bytes(samples: np.ndarray, sample_rate: int = TARGET_SR) -> bytes:
    pcm = np.clip(samples, -1.0, 1.0)
    pcm16 = (pcm * 32767).astype("<i2")
    out = io.BytesIO()
    with wave.open(out, "wb") as handle:
        handle.setnchannels(1)
        handle.setsampwidth(2)
        handle.setframerate(sample_rate)
        handle.writeframes(pcm16.tobytes())
    return out.getvalue()


def build_from_library(
    recipe_id: str,
    name: str,
    category: str,
    queries: List[Dict[str, Any]],
    limit: int = 12,
    max_sample_seconds: float = 3.0,
    mode: str = "step",
    synth: str = "",
) -> Recipe:
    """用库内检索结果自动组装一个配方。

    queries: [{"layer": "step", "q": "脚步 木板", "prob": 1.0, "gain_db": 0}]
    """
    from core.database import get_db_manager

    db = get_db_manager()
    layers: List[Layer] = []
    for spec in queries:
        rows = db.fts_search("default", spec["q"], limit=limit * 4)
        required = [str(k).lower() for k in (spec.get("require") or []) if str(k).strip()]

        def _ok(row: Dict[str, Any]) -> bool:
            duration = float(row.get("duration") or 0)
            if not (0.15 <= duration <= max_sample_seconds):
                return False
            if not required:
                return True
            text = (str(row.get("filename") or "") + " " + str(row.get("ai_description") or "")).lower()
            return any(k in text for k in required)

        pool = [row["file_path"] for row in rows if row.get("file_path") and _ok(row)][:limit]
        if not pool:
            # 放宽：只要时长合适
            pool = [
                row["file_path"]
                for row in rows
                if row.get("file_path") and 0.15 <= float(row.get("duration") or 0) <= max_sample_seconds
            ][:limit]
        if not pool:
            pool = [row["file_path"] for row in rows if row.get("file_path")][:limit]
        if not pool:
            continue
        layers.append(
            Layer(
                id=str(spec.get("layer") or "layer"),
                pool=pool,
                gain_db=float(spec.get("gain_db", 0) or 0),
                prob=float(spec.get("prob", 1.0) or 1.0),
                offset_ms=tuple(spec.get("offset_ms", (0, 0)) or (0, 0)),
                pitch_span=float(spec.get("pitch_span", 0.0) or 0.0),
                trim_seconds=float(spec.get("trim_seconds", 1.2) or 1.2),
                label=str(spec.get("label") or spec.get("layer") or ""),
                strength_gain=float(spec.get("strength_gain", 0.0) or 0.0),
                prob_min=float(spec.get("prob_min", -1.0)),
                prob_max=float(spec.get("prob_max", -1.0)),
            )
        )
    return Recipe(id=recipe_id, name=name, category=category, layers=layers, mode=mode, synth=synth)
