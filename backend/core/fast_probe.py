# -*- coding: utf-8 -*-
"""只读文件头的时长解析：比 PyAV 快一个数量级。

PyAV 打开一个文件要 40ms（要初始化容器/解码器上下文），6.5 万条要 45 分钟。
库里 99% 是 WAV 和 MP3——这两种只读前几十字节就能算出时长，0.05ms 级。

拿到时长用来填 files.duration，波形仍然由后台任务单独补（要整段解码）。
"""
from __future__ import annotations

import os
import struct
from typing import Any, Dict, Optional

_WAV_HEADER = 4096


def _wav_info(path: str) -> Optional[Dict[str, Any]]:
    """解析 RIFF/WAVE 头：跳过任意 LIST/INFO 块，找 fmt 和 data。"""
    try:
        size = os.path.getsize(path)
        with open(path, "rb") as fh:
            head = fh.read(64 * 1024)
    except OSError:
        return None
    if len(head) < 44 or head[:4] != b"RIFF" or head[8:12] != b"WAVE":
        return None

    channels = sample_rate = byte_rate = 0
    data_size = 0
    offset = 12
    while offset + 8 <= len(head):
        chunk_id = head[offset:offset + 4]
        chunk_size = struct.unpack("<I", head[offset + 4:offset + 8])[0]
        body = offset + 8
        if chunk_id == b"fmt " and body + 16 <= len(head):
            _fmt, channels, sample_rate, byte_rate = struct.unpack(
                "<HHII", head[body:body + 12]
            )
        elif chunk_id == b"data":
            # chunk_size 可能是 0xFFFFFFFF（流式写入没回填），取两者较小值更稳
            remain = max(0, size - body)
            data_size = chunk_size if 0 < chunk_size <= remain else remain
            break
        offset = body + chunk_size + (chunk_size & 1)

    if not byte_rate or not sample_rate:
        return None
    if not data_size:
        data_size = max(0, size - 44)
    duration = data_size / float(byte_rate)
    if duration <= 0:
        return None
    return {
        "duration": round(duration, 3),
        "sample_rate": int(sample_rate),
        "channels": int(channels or 0),
    }


def _flac_info(path: str) -> Optional[Dict[str, Any]]:
    """FLAC STREAMINFO：total_samples + sample_rate 都在里面。"""
    try:
        with open(path, "rb") as fh:
            head = fh.read(64)
    except OSError:
        return None
    if len(head) < 42 or head[:4] != b"fLaC":
        return None
    block = head[8:42]
    if len(block) < 34:
        return None
    raw = int.from_bytes(block[10:18], "big")
    sample_rate = (raw >> 44) & 0xFFFFF
    channels = ((raw >> 41) & 0x7) + 1
    total_samples = raw & 0xFFFFFFFFF
    if not sample_rate or not total_samples:
        return None
    return {
        "duration": round(total_samples / float(sample_rate), 3),
        "sample_rate": int(sample_rate),
        "channels": int(channels),
    }


def probe_header(path: str) -> Optional[Dict[str, Any]]:
    """只读头拿 {duration, sample_rate, channels}；不认识的格式返回 None。"""
    ext = os.path.splitext(str(path))[1].lower()
    try:
        if ext == ".wav":
            return _wav_info(path)
        # MP3 不在这里解析：mp3_meta 靠「文件大小 / 首帧码率」估算，
        # 短文件实测误差 10~20%（0.28s 算成 0.34s），交给 PyAV 更准。
        if ext == ".flac":
            return _flac_info(path)
    except Exception:
        return None
    return None
