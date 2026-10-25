# -*- coding: utf-8 -*-
"""AI 分轨：输出四轨 + 伴奏，且不依赖外部 ffmpeg。

依赖 demucs 与模型；模型缺失时跳过（不阻塞常规测试）。
"""
from __future__ import annotations

import math
import os
import struct
import sys
import tempfile
import unittest
import wave
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
if str(REPO_ROOT / "backend") not in sys.path:
    sys.path.insert(0, str(REPO_ROOT / "backend"))

try:
    import demucs  # noqa: F401
    HAS_DEMUCS = True
except Exception:
    HAS_DEMUCS = False

from core import separation


def write_stereo(path: Path, seconds: float = 1.0, rate: int = 44100) -> None:
    frames = int(rate * seconds)
    with wave.open(str(path), "wb") as handle:
        handle.setnchannels(2)
        handle.setsampwidth(2)
        handle.setframerate(rate)
        for i in range(frames):
            left = int(7000 * math.sin(2 * math.pi * 110 * i / rate))
            right = int(7000 * math.sin(2 * math.pi * 330 * i / rate))
            handle.writeframes(struct.pack("<hh", left, right))


@unittest.skipUnless(HAS_DEMUCS, "未安装 demucs")
class SeparationTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.temp_dir = tempfile.TemporaryDirectory()
        cls.root = Path(cls.temp_dir.name)

    @classmethod
    def tearDownClass(cls) -> None:
        cls.temp_dir.cleanup()

    def test_separate_produces_four_stems_and_instrumental(self) -> None:
        source = self.root / "song.wav"
        write_stereo(source)
        out_dir = self.root / "stems"
        result = separation.separate(str(source), str(out_dir), model_name="htdemucs")
        self.assertTrue(result["ok"], result.get("error"))
        stems = result["stems"]
        for name in ("vocals", "drums", "bass", "other"):
            self.assertIn(name, stems, "缺 %s 轨" % name)
            self.assertTrue(Path(stems[name]).exists())
            with wave.open(stems[name], "rb") as handle:
                self.assertGreater(handle.getnframes(), 0)
        self.assertTrue(Path(result["instrumental"]).exists(), "缺伴奏")

    def test_only_requested_stems(self) -> None:
        source = self.root / "song2.wav"
        write_stereo(source, seconds=0.6)
        out_dir = self.root / "stems2"
        result = separation.separate(str(source), str(out_dir), model_name="htdemucs", stems=["vocals"])
        self.assertTrue(result["ok"], result.get("error"))
        self.assertEqual(list(result["stems"].keys()), ["vocals"])

    def test_missing_source(self) -> None:
        result = separation.separate(str(self.root / "nope.wav"), str(self.root / "x"))
        self.assertFalse(result["ok"])
        self.assertIn("不存在", result["error"])


if __name__ == "__main__":
    unittest.main()
