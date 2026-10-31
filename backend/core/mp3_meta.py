# -*- coding: utf-8 -*-
"""MP3 纯 Python 解析：PyAV 读不出时长时的兜底。

背景：有一批 MP3（ID3v2.3 + 256kbps CBR）PyAV 会报告缺少采样率/声道信息，
导致被标记成"损坏文件"，界面上还提供删除按钮——实际文件完全正常。

这里只做一件事：读 ID3 头、扫第一个有效 MPEG 帧头、按码率估算时长。
不依赖任何第三方库，也不会抛异常给上层（失败返回 None）。
"""
from __future__ import annotations

import os
from typing import Any, Dict, Optional

# 版本 -> 码率表（kbps），索引为 bitrate_index
_BITRATES_V1 = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320]
_BITRATES_V2 = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160]
_SAMPLE_RATES = {1: [44100, 48000, 32000], 2: [22050, 24000, 16000], 25: [11025, 12000, 8000]}


def _skip_id3v2(data: bytes) -> int:
    if len(data) < 10 or data[:3] != b"ID3":
        return 0
    size = (
        ((data[6] & 0x7F) << 21)
        | ((data[7] & 0x7F) << 14)
        | ((data[8] & 0x7F) << 7)
        | (data[9] & 0x7F)
    )
    footer = 10 if (data[5] & 0x10) else 0
    return 10 + size + footer


def _parse_frame_header(b: bytes) -> Optional[Dict[str, Any]]:
    if len(b) < 4 or b[0] != 0xFF or (b[1] & 0xE0) != 0xE0:
        return None
    version_bits = (b[1] >> 3) & 0x03
    layer_bits = (b[1] >> 1) & 0x03
    bitrate_index = (b[2] >> 4) & 0x0F
    rate_index = (b[2] >> 2) & 0x03
    if version_bits == 1 or layer_bits != 1:  # 保留位 / 非 Layer III
        return None
    if bitrate_index in (0, 15) or rate_index == 3:
        return None
    version = {3: 1, 2: 2, 0: 25}.get(version_bits, 1)
    table = _BITRATES_V1 if version == 1 else _BITRATES_V2
    bitrate = table[bitrate_index] * 1000
    sample_rate = _SAMPLE_RATES[version][rate_index]
    channels = 1 if ((b[3] >> 6) & 0x03) == 3 else 2
    return {"bitrate": bitrate, "sample_rate": sample_rate, "channels": channels}


def read_mp3_meta(path: str | os.PathLike[str]) -> Optional[Dict[str, Any]]:
    """返回 {duration, sample_rate, channels, bitrate}，解析不了就返回 None。"""
    try:
        file_size = os.path.getsize(path)
    except OSError:
        return None
    if file_size < 128:
        return None
    try:
        with open(path, "rb") as fh:
            head = fh.read(256 * 1024)
    except OSError:
        return None

    offset = _skip_id3v2(head)
    # ID3v1 标签固定在末尾 128 字节
    tail = 128 if file_size - offset > 128 else 0
    audio_bytes = max(0, file_size - offset - tail)

    info = None
    for i in range(offset, max(offset, len(head) - 4)):
        info = _parse_frame_header(head[i:i + 4])
        if info:
            offset = i
            audio_bytes = max(0, file_size - offset - tail)
            break
    if not info or info["bitrate"] <= 0:
        return None

    duration = audio_bytes * 8.0 / info["bitrate"]
    return {
        "duration": round(duration, 3),
        "sample_rate": info["sample_rate"],
        "channels": info["channels"],
        "bitrate": info["bitrate"],
    }
