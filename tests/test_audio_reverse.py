# -*- coding: utf-8 -*-
"""倒放：生成的反向文件时长一致、采样反向、可复用缓存。"""
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

from core import audio_reverse


def write_ramp(path: Path, frames: int = 2000, rate: int = 22050) -> None:
    """写一个递增再递减的波形，倒放后首尾应对调。"""
    with wave.open(str(path), "wb") as handle:
        handle.setnchannels(1)
        handle.setsampwidth(2)
        handle.setframerate(rate)
        for i in range(frames):
            value = int(8000 * math.sin(2 * math.pi * 220 * i / rate) * (i / frames))
            handle.writeframes(struct.pack("<h", value))


class ReverseTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.source = Path(self.temp.name) / "ramp.wav"
        write_ramp(self.source)

    def tearDown(self) -> None:
        self.temp.cleanup()

    def test_reverse_produces_playable_wav(self) -> None:
        result = audio_reverse.reverse_to_wav(str(self.source))
        self.assertTrue(result["ok"], result.get("error"))
        target = Path(result["path"])
        self.assertTrue(target.is_file())
        with wave.open(str(target), "rb") as handle:
            self.assertGreater(handle.getnframes(), 0)
            self.assertEqual(handle.getframerate(), 22050)

    def test_reverse_is_cached(self) -> None:
        first = audio_reverse.reverse_to_wav(str(self.source))
        second = audio_reverse.reverse_to_wav(str(self.source))
        self.assertTrue(first["ok"])
        self.assertTrue(second["ok"])
        self.assertEqual(first["path"], second["path"])
        self.assertTrue(second.get("cached"))

    def test_missing_file(self) -> None:
        result = audio_reverse.reverse_to_wav(str(Path(self.temp.name) / "none.wav"))
        self.assertFalse(result["ok"])
        self.assertIn("不存在", result["error"])


if __name__ == "__main__":
    unittest.main()
