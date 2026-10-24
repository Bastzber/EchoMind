# -*- coding: utf-8 -*-
"""老标签入口（files.tags）→ 分层标签（tags/file_tags）的反向同步。

背景：右键「添加/编辑标签」走的是老接口，只写 files.tags；而左侧标签树和
「按标签筛选」读的是 tags/file_tags。不同步的话，用老入口打的标签在侧栏里看不到。
"""
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


class TagLayerSyncTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory()
        self.root = Path(self.temp_dir.name)
        self.manager = DatabaseManager(str(self.root / "tags.db"))
        self.audio = self.root / "rain 01.wav"
        self.audio.write_bytes(b"RIFF-test")
        record = AudioFileRecord(path=str(self.audio), filename=self.audio.name)
        self.file_uuid = self.manager.upsert_file(record, "default")
        self.assertIsNotNone(self.file_uuid)

    def tearDown(self) -> None:
        self.temp_dir.cleanup()

    def _tag_names(self) -> list:
        with self.manager.get_cursor() as cursor:
            rows = cursor.execute(
                "SELECT t.name FROM file_tags ft JOIN tags t ON t.id = ft.tag_id "
                "WHERE ft.project_id='default' AND ft.file_uuid=? ORDER BY t.name",
                (self.file_uuid,),
            ).fetchall()
        return [row[0] for row in rows]

    def test_legacy_tags_are_mirrored_into_layers(self) -> None:
        self.manager.update_tags(str(self.audio), ["雨", "环境"], "default")
        linked = self.manager.sync_layers_from_files_tags("default", path=str(self.audio))
        self.assertEqual(linked, 2)
        self.assertEqual(self._tag_names(), ["环境", "雨"])

    def test_removed_tags_disappear_from_layers(self) -> None:
        self.manager.update_tags(str(self.audio), ["雨", "环境"], "default")
        self.manager.sync_layers_from_files_tags("default", path=str(self.audio))
        self.manager.update_tags(str(self.audio), ["雨"], "default")
        self.manager.sync_layers_from_files_tags("default", path=str(self.audio))
        self.assertEqual(self._tag_names(), ["雨"], "删掉的标签应该从 file_tags 里消失")

    def test_existing_scene_tag_is_reused_not_downgraded(self) -> None:
        with self.manager.get_cursor() as cursor:
            cursor.execute(
                "INSERT INTO tags (id, project_id, name, layer, sort_order, created_at) "
                "VALUES (?,?,?,?,?,?)",
                ("tag_scene1", "default", "雨夜", "scene", 0, "2026-01-01T00:00:00"),
            )
        self.manager.update_tags(str(self.audio), ["雨夜"], "default")
        self.manager.sync_layers_from_files_tags("default", path=str(self.audio))
        with self.manager.get_cursor() as cursor:
            layer = cursor.execute(
                "SELECT layer FROM tags WHERE project_id='default' AND name='雨夜'"
            ).fetchone()[0]
        self.assertEqual(layer, "scene", "同名标签不能被降级成 attr")
        self.assertEqual(self._tag_names(), ["雨夜"])

    def test_duplicate_names_are_ignored(self) -> None:
        self.manager.update_tags(str(self.audio), ["雨", "雨"], "default")
        linked = self.manager.sync_layers_from_files_tags("default", path=str(self.audio))
        self.assertEqual(linked, 2, "重复名字按两次写入算，但关联只能有一条")
        self.assertEqual(self._tag_names(), ["雨"])

    def test_unknown_path_is_a_noop(self) -> None:
        linked = self.manager.sync_layers_from_files_tags("default", path=str(self.root / "nope.wav"))
        self.assertEqual(linked, 0)

    def test_can_sync_by_uuid(self) -> None:
        self.manager.update_tags(str(self.audio), ["雨"], "default")
        linked = self.manager.sync_layers_from_files_tags("default", file_uuid=self.file_uuid)
        self.assertEqual(linked, 1)
        self.assertEqual(self._tag_names(), ["雨"])


if __name__ == "__main__":
    unittest.main()
