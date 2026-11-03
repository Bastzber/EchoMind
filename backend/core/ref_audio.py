# -*- coding: utf-8 -*-
"""参考音频标准化：把用户拖进来的任意音频转成 Breeze 能安全吃的格式。

为什么必须做：
  Breeze 的 C++ 解码器不做输入校验。实测把 RIFF 长度字段是 0xffffffff 的 WAV
  （流式输出常见写法）、32-bit float、24-bit、头部损坏的文件喂给它，
  进程直接 0xc0000005 访问冲突崩掉，四次测试四次崩。

  崩了之后整个语音功能就没了 —— 不是这一条失败，是所有合成全废。
  所以上传前统一转成 24 kHz / 单声道 / 16-bit PCM WAV。
"""
from __future__ import annotations

import io
import logging
import wave
from pathlib import Path
from typing import Optional

import numpy as np

logger = logging.getLogger(__name__)

TARGET_RATE = 24000
TARGET_CHANNELS = 1


def _decode_with_av(source: Path) -> tuple[np.ndarray, int, int]:
    import av

    container = av.open(str(source), mode="r", metadata_errors="ignore")
    try:
        stream = next((s for s in container.streams if s.type == "audio"), None)
        if stream is None:
            raise ValueError("没有音频轨")
        rate = int(
            getattr(stream.codec_context, "sample_rate", 0)
            or getattr(stream, "rate", 0)
            or TARGET_RATE
        )
        chunks = []
        for frame in container.decode(stream):
            arr = np.asarray(frame.to_ndarray(), dtype=np.float32)
            if arr.ndim == 1:
                arr = arr[np.newaxis, :]
            chunks.append(arr.T.copy())
    finally:
        container.close()
    if not chunks:
        raise ValueError("解码得到空音频")
    samples = np.concatenate(chunks, axis=0).astype(np.float32, copy=False)
    # PyAV 对 s16 流返回 int16 量级数组而不是 -1~1；不归一化会把音色编码喂歪
    peak = float(np.max(np.abs(samples))) if samples.size else 0.0
    if peak > 2.0:
        samples = samples / np.float32(32768.0)
    return samples, rate, int(samples.shape[1])


def _to_mono(samples: np.ndarray) -> np.ndarray:
    if samples.ndim == 1:
        return samples
    if samples.shape[1] == 1:
        return samples[:, 0]
    return samples.mean(axis=1)


def _resample(samples: np.ndarray, src_rate: int, dst_rate: int) -> np.ndarray:
    if src_rate == dst_rate or src_rate <= 0:
        return samples
    # 线性插值够了：参考音频只用来提取音色，不做听感评估
    duration = samples.shape[0] / float(src_rate)
    target_len = max(1, int(round(duration * dst_rate)))
    src_index = np.arange(samples.shape[0], dtype=np.float64)
    dst_index = np.linspace(0.0, samples.shape[0] - 1, target_len)
    return np.interp(dst_index, src_index, samples).astype(np.float32)


def _encode_wav(samples: np.ndarray, rate: int) -> bytes:
    clipped = np.clip(samples, -1.0, 1.0)
    pcm = (clipped * 32767.0).astype("<i2")
    buffer = io.BytesIO()
    with wave.open(buffer, "wb") as writer:
        writer.setnchannels(TARGET_CHANNELS)
        writer.setsampwidth(2)
        writer.setframerate(int(rate))
        writer.writeframes(pcm.tobytes())
    return buffer.getvalue()


def normalize_reference(audio_bytes: bytes) -> Optional[bytes]:
    """任意音频 bytes → 24kHz/单声道/16-bit WAV bytes；解不开返回 None。"""
    if not audio_bytes:
        return None
    # 已经是标准格式（24k 单声道 16bit）就原样返回，省一次转码
    quick = _try_fast_path(audio_bytes)
    if quick is not None:
        return quick
    try:
        samples, rate, _channels = _decode_with_av(_as_path(audio_bytes))
    except Exception as exc:
        logger.warning("[TTS] 参考音频解码失败，放弃标准化: %s", exc)
        return None
    mono = _to_mono(samples)
    resampled = _resample(mono, rate, TARGET_RATE)
    return _encode_wav(resampled, TARGET_RATE)


def _as_path(audio_bytes: bytes) -> Path:
    """PyAV 能读 file-like，但畸形 WAV 走 BytesIO 时它更早抛异常；落临时文件更稳。"""
    import tempfile

    handle = tempfile.NamedTemporaryFile(suffix=".bin", delete=False)
    try:
        handle.write(audio_bytes)
        handle.close()
        return Path(handle.name)
    except Exception:
        handle.close()
        raise


def _try_fast_path(audio_bytes: bytes) -> Optional[bytes]:
    """已经是 24k 单声道 16-bit 且头部完整的 WAV，直接用，不转码。"""
    if len(audio_bytes) < 44 or audio_bytes[:4] != b"RIFF":
        return None
    try:
        with wave.open(io.BytesIO(audio_bytes), "rb") as reader:
            channels = reader.getnchannels()
            width = reader.getsampwidth()
            rate = reader.getframerate()
            frames = reader.getnframes()
    except Exception:
        return None
    # 头部里写着巨大帧数的（流式占位符 0xffffffff）不算健康，走完整转码
    if frames <= 0 or frames > rate * 3600:
        return None
    if channels != TARGET_CHANNELS or width != 2 or rate != TARGET_RATE:
        return None
    return audio_bytes
