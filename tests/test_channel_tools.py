# -*- coding: utf-8 -*-
"""多声道：峰值曲线数量与声道数一致；按声道混音只留选中声道。"""
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

from core import channel_tools


def write_multichannel(path: Path, channels: int, frames: int = 4000, rate: int = 22050) -> None:
    with wave.open(str(path), "wb") as handle:
        handle.setnchannels(channels)
        handle.setsampwidth(2)
        handle.setframerate(rate)
        for i in range(frames):
            values = []
            for ch in range(channels):
                amp = 2000 * (ch + 1)
                values.append(int(amp * math.sin(2 * math.pi * (100 + ch * 100) * i / rate)))
            handle.writeframes(struct.pack("<" + "h" * channels, *values))


class ChannelToolTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.stereo = Path(self.temp.name) / "stereo.wav"
        write_multichannel(self.stereo, 2)
        self.surround = Path(self.temp.name) / "surround.wav"
        write_multichannel(self.surround, 6)

    def tearDown(self) -> None:
        self.temp.cleanup()

    def test_peaks_per_channel(self) -> None:
        result = channel_tools.channel_peaks(str(self.stereo), points=100)
        self.assertTrue(result["ok"], result.get("error"))
        self.assertEqual(result["channels"], 2)
        self.assertEqual(len(result["peaks"]), 2)
        self.assertGreater(len(result["peaks"][0]), 10)

    def test_surround_has_six_channels(self) -> None:
        result = channel_tools.channel_peaks(str(self.surround), points=100)
        self.assertTrue(result["ok"], result.get("error"))
        self.assertEqual(result["channels"], 6)
        self.assertEqual(len(result["peaks"]), 6)

    def test_mix_keeps_selected_channel(self) -> None:
        result = channel_tools.render_channel_mix(str(self.stereo), [1])
        self.assertTrue(result["ok"], result.get("error"))
        target = Path(result["path"])
        self.assertTrue(target.is_file())
        with wave.open(str(target), "rb") as handle:
            self.assertEqual(handle.getnchannels(), 2)
            self.assertGreater(handle.getnframes(), 0)

    def test_mix_is_cached(self) -> None:
        first = channel_tools.render_channel_mix(str(self.stereo), [2])
        second = channel_tools.render_channel_mix(str(self.stereo), [2])
        self.assertEqual(first["path"], second["path"])
        self.assertTrue(second.get("cached"))


if __name__ == "__main__":
    unittest.main()
