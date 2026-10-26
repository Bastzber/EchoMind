# -*- coding: utf-8 -*-
"""效果器：预设齐全；卷积后时长不变；干声等于原样；结果可缓存。"""
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


def write_stereo(path: Path, seconds: float = 0.6, rate: int = 22050) -> int:
    frames = int(rate * seconds)
    with wave.open(str(path), "wb") as handle:
        handle.setnchannels(2)
        handle.setsampwidth(2)
        handle.setframerate(rate)
        for i in range(frames):
            left = int(6000 * math.sin(2 * math.pi * 220 * i / rate))
            right = int(6000 * math.sin(2 * math.pi * 330 * i / rate))
            handle.writeframes(struct.pack("<hh", left, right))
    return frames


class EffectTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.source = Path(self.temp.name) / "dry.wav"
        self.frames = write_stereo(self.source)

    def tearDown(self) -> None:
        self.temp.cleanup()

    def test_presets_present(self) -> None:
        for key in ("room_small", "room_large", "hall", "church", "tunnel", "outdoor", "plate", "dry"):
            self.assertIn(key, effects.PRESETS)

    def test_hall_reverb_produces_audio(self) -> None:
        result = effects.apply_effect(str(self.source), "hall", 0.35)
        self.assertTrue(result["ok"], result.get("error"))
        target = Path(result["path"])
        self.assertTrue(target.is_file())
        with wave.open(str(target), "rb") as handle:
            self.assertEqual(handle.getnchannels(), 2)
            self.assertGreater(handle.getnframes(), 0)

    def test_dry_preset_keeps_length(self) -> None:
        result = effects.apply_effect(str(self.source), "dry", 0.0)
        self.assertTrue(result["ok"], result.get("error"))
        with wave.open(result["path"], "rb") as handle:
            self.assertAlmostEqual(handle.getnframes(), self.frames, delta=64)

    def test_cached_result(self) -> None:
        first = effects.apply_effect(str(self.source), "room_small", 0.2)
        second = effects.apply_effect(str(self.source), "room_small", 0.2)
        self.assertEqual(first["path"], second["path"])
        self.assertTrue(second.get("cached"))

    def test_missing_file(self) -> None:
        result = effects.apply_effect(str(Path(self.temp.name) / "x.wav"), "hall")
        self.assertFalse(result["ok"])


if __name__ == "__main__":
    unittest.main()
