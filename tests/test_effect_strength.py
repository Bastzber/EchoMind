# -*- coding: utf-8 -*-
"""效果器强度：湿声要真的听得出差异（RMS 提升 / 尾巴），且干声保持原样。"""
from __future__ import annotations

import math
import struct
import sys
import tempfile
import unittest
import wave
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
if str(REPO_ROOT / "backend") not in sys.path:
    sys.path.insert(0, str(REPO_ROOT / "backend"))

from core import effects


def write_burst(path: Path, rate: int = 22050) -> None:
    """一段短促脉冲 + 静音：混响的尾巴会落在静音里，便于比较。"""
    frames = int(rate * 1.2)
    with wave.open(str(path), "wb") as handle:
        handle.setnchannels(2)
        handle.setsampwidth(2)
        handle.setframerate(rate)
        for i in range(frames):
            value = 0
            if i < rate * 0.1:
                value = int(9000 * math.sin(2 * math.pi * 400 * i / rate))
            handle.writeframes(struct.pack("<hh", value, value))


def tail_rms(path: str, start_ratio: float = 0.3) -> float:
    with wave.open(str(path), "rb") as handle:
        frames = handle.getnframes()
        channels = handle.getnchannels()
        rate = handle.getframerate()
        start = int(frames * start_ratio)
        handle.setpos(start)
        raw = handle.readframes(frames - start)
    if not raw:
        return 0.0
    total = 0
    count = 0
    for index in range(0, len(raw), 2 * channels):
        for channel in range(channels):
            value = struct.unpack_from("<h", raw, index + channel * 2)[0]
            total += value * value
            count += 1
    return math.sqrt(total / max(count, 1))


class EffectStrengthTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.source = Path(self.temp.name) / "burst.wav"
        write_burst(self.source)

    def tearDown(self) -> None:
        self.temp.cleanup()

    def test_all_presets_add_audible_tail(self) -> None:
        """除干声外，每个预设都要有可听见的尾巴（干声是 0）。"""
        tails = {}
        for preset in ("room_small", "room_large", "hall", "church", "tunnel", "outdoor", "plate"):
            result = effects.apply_effect(str(self.source), preset, 0.5)
            self.assertTrue(result["ok"], preset + " 失败: " + str(result.get("error")))
            tails[preset] = tail_rms(result["path"])
            self.assertGreater(tails[preset], 5.0, f"{preset} 的混响尾巴几乎听不到（{tails[preset]:.1f}）")
        # 空间越大尾巴越强，这个小房间 < 大厅
        self.assertGreater(tails["hall"], tails["room_small"] * 3)
        self.assertGreater(tails["church"], tails["room_large"])

    def test_wet_slider_increases_tail(self) -> None:
        low = effects.apply_effect(str(self.source), "hall", 0.2)
        high = effects.apply_effect(str(self.source), "hall", 0.8)
        self.assertGreater(tail_rms(high["path"]), tail_rms(low["path"]) * 1.2)


if __name__ == "__main__":
    unittest.main()
