# -*- coding: utf-8 -*-
"""声音克隆：档案增删查、时长校验、缺 Key 时给出明确提示。"""
from __future__ import annotations

import os
import sys
import tempfile
import unittest
import wave
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
if str(REPO_ROOT / "backend") not in sys.path:
    sys.path.insert(0, str(REPO_ROOT / "backend"))


class VoiceCloneTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        os.environ["APPDATA"] = self.temp.name
        import importlib
        from core import voice_clone

        importlib.reload(voice_clone)
        self.module = voice_clone
        self.sample = Path(self.temp.name) / "sample.wav"
        with wave.open(str(self.sample), "wb") as handle:
            handle.setnchannels(1)
            handle.setsampwidth(2)
            handle.setframerate(22050)
            handle.writeframes(b"\x00\x00" * 22050)

    def tearDown(self) -> None:
        self.temp.cleanup()

    def test_profile_crud(self) -> None:
        entry = self.module.add_profile("测试音色", "spk_1", str(self.sample), 10.0)
        self.assertTrue(entry["id"])
        items = self.module.load_profiles()
        self.assertEqual(len(items), 1)
        self.assertEqual(items[0]["speaker_id"], "spk_1")
        self.assertTrue(self.module.delete_profile(entry["id"]))
        self.assertEqual(self.module.load_profiles(), [])

    def test_short_sample_rejected(self) -> None:
        result = self.module.clone_voice(str(self.sample), "太短", duration=2.0)
        self.assertFalse(result["ok"])
        self.assertIn("时长", result["error"])

    def test_missing_sample(self) -> None:
        result = self.module.clone_voice(str(Path(self.temp.name) / "none.wav"), "x", 15.0)
        self.assertFalse(result["ok"])

    def test_missing_key_is_explicit(self) -> None:
        self.module._api_key = lambda: ""
        result = self.module.clone_voice(str(self.sample), "没钥匙", duration=15.0)
        self.assertFalse(result["ok"])
        self.assertIn("API Key", result["error"])


if __name__ == "__main__":
    unittest.main()
