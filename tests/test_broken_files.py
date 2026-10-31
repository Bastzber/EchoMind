# -*- coding: utf-8 -*-
"""「损坏文件」自愈：重探能读出来的文件，把误判的工件退回 pending。"""
from __future__ import annotations

import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

REPO_ROOT = Path(__file__).resolve().parents[1]
if str(REPO_ROOT / "backend") not in sys.path:
    sys.path.insert(0, str(REPO_ROOT / "backend"))

from core import broken_files  # noqa: E402
from core.audio_service import AudioMetadata  # noqa: E402
from core.database import AudioFileRecord, DatabaseManager  # noqa: E402


class BrokenFileHealTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.db = DatabaseManager(str(self.root / "broken.db"))
        self.audio = self.root / "tone.mp3"
        self.audio.write_bytes(b"ID3-fake")
        self.record = AudioFileRecord(path=str(self.audio), filename=self.audio.name)
        self.file_uuid = self.db.upsert_file(self.record, "default")
        # 模拟"被判损坏"：音频向量 failed
        self.db.set_artifact_state(
            "default", self.file_uuid, "audio_vector", "failed",
            error_code="audio_decode_failed", error_message="batch encode produced nothing",
        )

    def tearDown(self):
        try:
            self.db.close()
        except Exception:
            pass
        self.temp.cleanup()

    def _artifact(self):
        return self.db.get_artifact("default", self.file_uuid, "audio_vector")

    def test_failed_probe_leaves_artifacts_alone(self):
        service = mock.Mock()
        service.probe.side_effect = RuntimeError("still broken")
        with mock.patch("core.audio_service.get_audio_service", return_value=service):
            result = broken_files.heal(self.db, "default", str(self.audio))
        self.assertFalse(result["ok"])
        self.assertEqual(result["healed"], 0)
        self.assertEqual(self._artifact()["state"], "failed")

    def test_successful_probe_resets_failed_artifacts_to_pending(self):
        service = mock.Mock()
        service.probe.return_value = AudioMetadata(
            duration=79.78, sample_rate=44100, channels=2, format="mp3", codec="mp3"
        )
        with mock.patch("core.audio_service.get_audio_service", return_value=service):
            result = broken_files.heal(self.db, "default", str(self.audio))
        self.assertTrue(result["ok"])
        self.assertAlmostEqual(result["duration"], 79.78, places=2)
        self.assertEqual(result["healed"], 1)
        artifact = self._artifact()
        self.assertEqual(artifact["state"], "pending")
        self.assertIsNone(artifact["error_code"])

    def test_audio_file_itself_is_never_touched(self):
        service = mock.Mock()
        service.probe.return_value = AudioMetadata(
            duration=1.0, sample_rate=44100, channels=1, format="mp3", codec="mp3"
        )
        before = self.audio.stat().st_size
        with mock.patch("core.audio_service.get_audio_service", return_value=service):
            broken_files.heal(self.db, "default", str(self.audio))
        self.assertTrue(self.audio.is_file(), "自愈不能删磁盘文件")
        self.assertEqual(self.audio.stat().st_size, before)


if __name__ == "__main__":
    unittest.main()
