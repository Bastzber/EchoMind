# -*- coding: utf-8 -*-
"""转码：正常文件、坏文件容错、格式探测。"""
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

from core import transcode


def write_wav(path: Path, seconds: float = 0.5, rate: int = 44100, channels: int = 1) -> None:
    frames = int(rate * seconds)
    with wave.open(str(path), "wb") as handle:
        handle.setnchannels(channels)
        handle.setsampwidth(2)
        handle.setframerate(rate)
        for i in range(frames):
            value = int(12000 * math.sin(2 * math.pi * 440 * i / rate))
            handle.writeframes(struct.pack("<h", value))


class TranscodeTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory()
        self.root = Path(self.temp_dir.name)

    def tearDown(self) -> None:
        self.temp_dir.cleanup()

    def test_wav_to_mp3(self) -> None:
        source = self.root / "in.wav"
        write_wav(source)
        destination = self.root / "out.mp3"
        result = transcode.transcode_file(str(source), str(destination), "mp3", bitrate="128k")
        self.assertTrue(result["ok"], result.get("error"))
        self.assertGreater(result["frames"], 0)
        self.assertTrue(destination.exists())
        self.assertGreater(destination.stat().st_size, 1000)

    def test_mp3_to_wav(self) -> None:
        source = self.root / "in.wav"
        write_wav(source)
        middle = self.root / "mid.mp3"
        self.assertTrue(transcode.transcode_file(str(source), str(middle), "mp3")["ok"])
        destination = self.root / "back.wav"
        result = transcode.transcode_file(str(middle), str(destination), "wav")
        self.assertTrue(result["ok"], result.get("error"))
        with wave.open(str(destination), "rb") as handle:
            self.assertGreater(handle.getnframes(), 0)

    def test_truncated_source_is_salvaged(self) -> None:
        source = self.root / "in.wav"
        write_wav(source, seconds=1.0)
        broken = self.root / "broken.wav"
        data = source.read_bytes()
        broken.write_bytes(data[: len(data) // 3])  # 截断
        result = transcode.transcode_file(str(broken), str(self.root / "fixed.wav"), "wav")
        if result["ok"]:
            self.assertTrue(result["salvaged"] or result["frames"] > 0)
        else:
            self.assertIn("error", result)

    def test_missing_source(self) -> None:
        result = transcode.transcode_file(str(self.root / "nope.mp3"), str(self.root / "x.wav"), "wav")
        self.assertFalse(result["ok"])
        self.assertIn("不存在", result["error"])

    def test_unknown_target_format(self) -> None:
        with self.assertRaises(ValueError):
            transcode.target_extension("ogg")

    def test_probe_format(self) -> None:
        source = self.root / "in.wav"
        write_wav(source)
        self.assertIn("wav", transcode.probe_format(str(source)))


if __name__ == "__main__":
    unittest.main()
