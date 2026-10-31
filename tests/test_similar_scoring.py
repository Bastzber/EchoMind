# -*- coding: utf-8 -*-
"""「找相似」打分口径的单元测试（不碰 Chroma，只测词命中和排序）。"""
from __future__ import annotations

import sys
import tempfile
import unittest
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
if str(REPO_ROOT / "backend") not in sys.path:
    sys.path.insert(0, str(REPO_ROOT / "backend"))

from core import similar  # noqa: E402
from core.database import AudioFileRecord, DatabaseManager  # noqa: E402


class TokenTests(unittest.TestCase):
    def test_cjk_single_chars_and_latin_words(self):
        tokens = similar._tokenize("猪 001.wav 一头猪在叫 BOAR2")
        self.assertIn("猪", tokens)
        self.assertIn("boar2", tokens)
        self.assertNotIn("001", tokens)  # 纯数字没有辨识度

    def test_parse_tags_supports_json_and_csv(self):
        self.assertEqual(similar._parse_tags('["a", "b"]'), ["a", "b"])
        self.assertEqual(similar._parse_tags("a，b;c"), ["a", "b", "c"])
        self.assertEqual(similar._parse_tags(None), [])


class RankingTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.db = DatabaseManager(str(self.root / "similar.db"))
        # 源：成年猪哼叫
        self.source_uuid = self._add("猪 001.wav", "一头猪在叫唤，发出哼哼声", ["哼声", "低频", "短尾"])
        # 同类：小猪（描述里也有「猪」）
        self.piglet_uuid = self._add("小猪尖叫.wav", "幼年猪发出的尖叫", ["尖叫", "高频", "短尾"])
        # 同类：野猪
        self.boar_uuid = self._add("BOAR.WAV", "野猪低沉的嚎叫", ["嚎叫", "低频"])
        # 无关：只是共享「低频/短尾」这种通用听感标签
        self.drum_uuid = self._add("鼓001.wav", "沉闷的大鼓敲击", ["低频", "短尾", "鼓声"])

    def tearDown(self):
        try:
            self.db.close()
        except Exception:
            pass
        self.temp.cleanup()

    def _add(self, filename: str, description: str, tags):
        import json

        path = self.root / filename
        path.write_bytes(b"RIFF")
        record = AudioFileRecord(path=str(path), filename=filename)
        file_uuid = self.db.upsert_file(record, "default")
        with self.db.get_cursor() as cursor:
            cursor.execute(
                "UPDATE files SET ai_description=?, tags=? WHERE file_uuid=?",
                (description, json.dumps(tags, ensure_ascii=False), file_uuid),
            )
            cursor.connection.commit()
        return file_uuid

    def test_pig_family_ranks_above_generic_acoustic_tags(self):
        source = similar._load_source(self.db, "default", self.source_uuid)
        df, total, postings = similar._term_index(self.db, "default")
        items = similar._term_matches(
            self.db, "default", source, df, total, postings, 20
        )
        ids = [item["file_uuid"] for item in items]
        self.assertIn(self.piglet_uuid, ids)
        self.assertIn(self.boar_uuid, ids)
        # 只共享「低频/短尾」的鼓不该排在猪家族前面
        if self.drum_uuid in ids:
            self.assertGreater(
                ids.index(self.piglet_uuid), -1
            )
            self.assertLess(
                ids.index(self.piglet_uuid), ids.index(self.drum_uuid)
            )

    def test_matched_terms_explain_the_hit(self):
        source = similar._load_source(self.db, "default", self.source_uuid)
        df, total, postings = similar._term_index(self.db, "default")
        items = similar._term_matches(
            self.db, "default", source, df, total, postings, 20
        )
        piglet = next(item for item in items if item["file_uuid"] == self.piglet_uuid)
        self.assertIn("猪", piglet["matched_terms"])


    def test_index_rebuilds_after_new_file_is_imported(self):
        source = similar._load_source(self.db, "default", self.source_uuid)
        df, total, postings = similar._term_index(self.db, "default")
        new_uuid = self._add("野猪2.wav", "野猪低沉的嚎叫", ["嚎叫"])
        df2, total2, postings2 = similar._term_index(self.db, "default")
        self.assertGreater(total2, total, "导入新文件后词表必须重建")
        items = similar._term_matches(
            self.db, "default", source, df2, total2, postings2, 20
        )
        self.assertIn(new_uuid, [item["file_uuid"] for item in items])

    def test_index_rebuilds_after_tag_edit(self):
        import json as _json

        similar._term_index(self.db, "default")
        with self.db.get_cursor() as cursor:
            cursor.execute(
                "UPDATE files SET tags=? WHERE file_uuid=?",
                (_json.dumps(["味觉测试"], ensure_ascii=False), self.piglet_uuid),
            )
            cursor.connection.commit()
        similar.invalidate("default")   # 与 update_tags 内部走的同一入口
        df, total, postings = similar._term_index(self.db, "default")
        self.assertIn("味", postings, "改标签后倒排里应出现新的字")
        self.assertIn(self.piglet_uuid, postings["味"])


if __name__ == "__main__":
    unittest.main()