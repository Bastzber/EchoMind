# -*- coding: utf-8 -*-
"""标签批量操作：改名、合并同义、删除空标签。"""
from __future__ import annotations

import sys
import tempfile
import unittest
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
BACKEND_DIR = REPO_ROOT / "backend"
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

from core.database import AudioFileRecord, DatabaseManager


class TagBatchOpsTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory()
        self.root = Path(self.temp_dir.name)
        self.manager = DatabaseManager(str(self.root / "tags.db"))
        self.audios = []
        for index in range(3):
            audio = self.root / f"tone {index}.wav"
            audio.write_bytes(b"RIFF-test")
            record = AudioFileRecord(path=str(audio), filename=audio.name)
            self.manager.upsert_file(record, "default")
            self.audios.append(audio)

    def tearDown(self) -> None:
        self.temp_dir.cleanup()

    def _names(self) -> list:
        return sorted(t["name"] for t in self.manager.list_tag_usage("default"))

    def _usage(self, name: str) -> int:
        for tag in self.manager.list_tag_usage("default"):
            if tag["name"] == name:
                return tag["usage"]
        return 0

    def _files_tags(self, path) -> list:
        with self.manager.get_cursor() as cursor:
            row = cursor.execute(
                "SELECT tags FROM files WHERE project_id='default' AND canonical_path LIKE ?",
                (f"%{Path(path).name}",),
            ).fetchone()
        import json
        return json.loads(row[0]) if row and row[0] else []

    def test_rename_moves_files_but_keeps_file_tags(self) -> None:
        self.manager.update_tags(str(self.audios[0]), ["7-情节搭设"], "default")
        self.manager.sync_layers_from_files_tags("default", path=str(self.audios[0]))

        result = self.manager.rename_tag_by_name("default", "7-情节搭设", "情节搭设")
        self.assertEqual(result["renamed"], 1)
        self.assertIn("情节搭设", self._names())
        self.assertNotIn("7-情节搭设", self._names())
        self.assertEqual(
            self._files_tags(self.audios[0]), ["7-情节搭设"],
            "files.tags 不该被「我的标签」的改名影响",
        )

    def test_merge_into_existing_tag(self) -> None:
        for audio, tag in ((self.audios[0], "配乐"), (self.audios[1], "短配乐")):
            self.manager.update_tags(str(audio), [tag], "default")
            self.manager.sync_layers_from_files_tags("default", path=str(audio))

        result = self.manager.rename_tag_by_name("default", "短配乐", "配乐")
        self.assertEqual(result["merged"], 1)
        self.assertEqual(result["files"], 1)
        self.assertEqual(self._usage("配乐"), 2, "两个文件都应该挂在「配乐」下")
        self.assertNotIn("短配乐", self._names())

    def test_delete_tag_removes_links_but_keeps_file_tags(self) -> None:
        """「我的标签」和 files.tags 是两套：删前者不该动后者。"""
        self.manager.update_tags(str(self.audios[0]), ["临时标签", "保留"], "default")
        self.manager.sync_layers_from_files_tags("default", path=str(self.audios[0]))

        result = self.manager.delete_tag_by_name("default", "临时标签")
        self.assertEqual(result["deleted"], 1)
        self.assertNotIn("临时标签", self._names(), "分层表里应删掉")
        self.assertEqual(
            self._files_tags(self.audios[0]), ["临时标签", "保留"],
            "files.tags（音效自带标签）不应被改动",
        )

    def test_usage_counts(self) -> None:
        for audio in self.audios:
            self.manager.update_tags(str(audio), ["常用"], "default")
            self.manager.sync_layers_from_files_tags("default", path=str(audio))
        self.assertEqual(self._usage("常用"), 3)

    def test_unknown_tag_is_noop(self) -> None:
        self.assertEqual(self.manager.rename_tag_by_name("default", "不存在", "新名")["renamed"], 0)
        self.assertEqual(self.manager.delete_tag_by_name("default", "不存在")["deleted"], 0)


if __name__ == "__main__":
    unittest.main()
