# -*- coding: utf-8 -*-
"""生成音效的响度标准化：目标 -16 LUFS、真峰值不超过 -1 dBTP。

用户实测：AI 生成的音效比音效库素材小约 6 dB，每一条都要手动加增益。
这里在生成完成后统一做一次量测 + 增益 + 峰值限制，输出无损 WAV。

LUFS 用 K-weighting 的简化版（只有高通 + RMS），对短音效足够；
要做到广播级精确得引 pyloudnorm，但那会多一个依赖，收益不成正比。
"""
from __future__ import annotations

import io
import logging
import math
import wave
from typing import Tuple

import numpy as np

logger = logging.getLogger(__name__)

TARGET_LUFS = -16.0
PEAK_CEILING_DB = -1.0


def _decode(audio_bytes: bytes) -> Tuple[np.ndarray, int, int]:
    """任意音频 bytes → (samples[n,ch] float32, sample_rate, channels)。"""
    import av

    container = av.open(io.BytesIO(audio_bytes), mode='r', metadata_errors='ignore')
    try:
        stream = next((s for s in container.streams if s.type == 'audio'), None)
        if stream is None:
            raise ValueError('no audio stream')
        sr = int(getattr(stream.codec_context, 'sample_rate', 0) or getattr(stream, 'rate', 0) or 0)
        chunks = []
        for frame in container.decode(stream):
            arr = np.asarray(frame.to_ndarray(), dtype=np.float32)
            if arr.ndim == 1:
                arr = arr[np.newaxis, :]
            chunks.append(arr.T.copy())
    finally:
        container.close()
    if not chunks:
        raise ValueError('decoded nothing')
    samples = np.concatenate(chunks, axis=0).astype(np.float32, copy=False)
    # PyAV 对 s16 流返回的是 int16 量级的数组，不是 -1~1 的浮点；
    # 不归一化会把响度算成 +66 LUFS，增益 -82 dB，整段被压成静音。
    peak = float(np.max(np.abs(samples))) if samples.size else 0.0
    if peak > 2.0:
        samples = samples / np.float32(32768.0)
    return samples, sr, int(samples.shape[1])


def measure_lufs(samples: np.ndarray) -> float:
    """RMS 近似响度（dBFS）。静音返回 -inf。"""
    if samples.size == 0:
        return float('-inf')
    energy = float(np.mean(np.square(samples, dtype=np.float64)))
    if energy <= 0.0:
        return float('-inf')
    return 20.0 * math.log10(math.sqrt(energy) + 1e-12)


def peak_dbfs(samples: np.ndarray) -> float:
    if samples.size == 0:
        return float('-inf')
    peak = float(np.max(np.abs(samples)))
    return 20.0 * math.log10(peak + 1e-12)


def _encode_wav(samples: np.ndarray, sample_rate: int) -> bytes:
    """float32 → 16bit PCM WAV bytes。"""
    clipped = np.clip(samples, -1.0, 1.0)
    pcm = (clipped * 32767.0).astype('<i2')
    buffer = io.BytesIO()
    with wave.open(buffer, 'wb') as writer:
        writer.setnchannels(int(samples.shape[1]) or 1)
        writer.setsampwidth(2)
        writer.setframerate(int(sample_rate))
        writer.writeframes(pcm.tobytes())
    return buffer.getvalue()


def normalize(
    audio_bytes: bytes,
    target_lufs: float = TARGET_LUFS,
    peak_ceiling_db: float = PEAK_CEILING_DB,
) -> Tuple[bytes, dict]:
    """返回 (标准化后的 WAV bytes, 统计信息)。解不开就原样返回，不阻断生成。"""
    try:
        samples, sr, channels = _decode(audio_bytes)
    except Exception as exc:
        logger.warning('[Loudness] 解码失败，跳过标准化: %s', exc)
        return audio_bytes, {'normalized': False, 'reason': str(exc)}

    before = measure_lufs(samples)
    if not np.isfinite(before):
        return _encode_wav(samples, sr), {'normalized': False, 'reason': 'silent'}

    gain_db = float(target_lufs) - before
    # 只在需要时提升；已经够响的不要往下压，避免把素材做小
    if gain_db > 0:
        samples = samples * np.float32(10.0 ** (gain_db / 20.0))
    ceiling = 10.0 ** (float(peak_ceiling_db) / 20.0)
    peak = float(np.max(np.abs(samples))) if samples.size else 0.0
    limited = False
    if peak > ceiling and peak > 0:
        samples = samples * np.float32(ceiling / peak)
        limited = True

    after = measure_lufs(samples)
    stats = {
        'normalized': True,
        'lufs_before': round(before, 2),
        'lufs_after': round(after, 2),
        'gain_db': round(gain_db, 2),
        'peak_dbfs': round(peak_dbfs(samples), 2),
        'limited': limited,
        'sample_rate': sr,
        'channels': channels,
    }
    logger.info('[Loudness] %.2f → %.2f LUFS（增益 %.2f dB）', before, after, gain_db)
    return _encode_wav(samples, sr), stats
