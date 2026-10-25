# -*- coding: utf-8 -*-
"""去人声：立体声能被处理、单声道被拒绝、输出可解码。"""
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

from core import vocals


def write_stereo(path: Path, seconds: float = 0.4, rate: int = 44100) -> None:
    """左声道 440Hz，右声道 660Hz —— 两声道不同，模拟乐器分居两侧。"""
    frames = int(rate * seconds)
    with wave.open(str(path), "wb") as handle:
        handle.setnchannels(2)
        handle.setsampwidth(2)
        handle.setframerate(rate)
        for i in range(frames):
            left = int(12000 * math.sin(2 * math.pi * 440 * i / rate))
            right = int(12000 * math.sin(2 * math.pi * 660 * i / rate))
            handle.writeframes(struct.pack("<hh", left, right))


def write_mono(path: Path, seconds: float = 0.3, rate: int = 44100) -> None:
    frames = int(rate * seconds)
    with wave.open(str(path), "wb") as handle:
        handle.setnchannels(1)
        handle.setsampwidth(2)
        handle.setframerate(rate)
        for i in range(frames):
            handle.writeframes(struct.pack("<h", int(9000 * math.sin(2 * math.pi * 300 * i / rate))))


class VocalRemovalTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory()
        self.root = Path(self.temp_dir.name)

    def tearDown(self) -> None:
        self.temp_dir.cleanup()

    def test_stereo_produces_output(self) -> None:
        source = self.root / "song.wav"
        write_stereo(source)
        result = vocals.remove_vocals(str(source), str(self.root / "instrumental.wav"))
        self.assertTrue(result["ok"], result.get("error"))
        self.assertGreater(result["samples"], 0)
        with wave.open(str(self.root / "instrumental.wav"), "rb") as handle:
            self.assertEqual(handle.getnchannels(), 2)
            self.assertGreater(handle.getnframes(), 0)

    def test_mono_is_rejected(self) -> None:
        source = self.root / "mono.wav"
        write_mono(source)
        result = vocals.remove_vocals(str(source), str(self.root / "out.wav"))
        self.assertFalse(result["ok"])
        self.assertIn("立体声", result["error"])

    def test_missing_source(self) -> None:
        result = vocals.remove_vocals(str(self.root / "nope.wav"), str(self.root / "out.wav"))
        self.assertFalse(result["ok"])
        self.assertIn("不存在", result["error"])

    def test_identical_channels_are_silenced(self) -> None:
        """左右完全相同的音频（人声居中）相减后应接近静音。"""
        source = self.root / "centered.wav"
        frames = 4096
        with wave.open(str(source), "wb") as handle:
            handle.setnchannels(2)
            handle.setsampwidth(2)
            handle.setframerate(44100)
            for i in range(frames):
                value = int(8000 * math.sin(2 * math.pi * 200 * i / 44100))
                handle.writeframes(struct.pack("<hh", value, value))
        result = vocals.remove_vocals(str(source), str(self.root / "out.wav"))
        self.assertTrue(result["ok"], result.get("error"))
        with wave.open(str(self.root / "out.wav"), "rb") as handle:
            data = handle.readframes(min(handle.getnframes(), 1024))
        peak = max(abs(v) for v in struct.unpack("<" + "h" * (len(data) // 2), data)) if data else 0
        self.assertLess(peak, 50, "居中的相同声道没有被抵消")


if __name__ == "__main__":
    unittest.main()
