# -*- coding: utf-8 -*-
"""知识包增量（A4）：除了新文件，也要带上「描述/标签变过」的条目。"""
from __future__ import annotations

import json
import sys
import tempfile
import unittest
import zipfile
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
if str(REPO_ROOT / "backend") not in sys.path:
    sys.path.insert(0, str(REPO_ROOT / "backend"))

from core import knowledge_pack  # noqa: E402


def _pack_line(sha, description, tags):
    """包里的格式：metadata.jsonl 每行 {sha256, rel, filename, description, tags}。"""
    return {
        "sha256": sha,
        "rel": "%s.wav" % sha[:6],
        "filename": "%s.wav" % sha[:6],
        "description": description,
        "tags": tags,
    }


def _db_row(sha, description, tags):
    """库里读出来的行：列名是 ai_description / tags(JSON 字符串)。"""
    return {
        "sha256": sha,
        "path": "F:/lib/%s.wav" % sha[:6],
        "filename": "%s.wav" % sha[:6],
        "ai_description": description,
        "tags": json.dumps(tags, ensure_ascii=False),
    }


class DeltaSelectionTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.pack = self.root / "base.zip"
        with zipfile.ZipFile(self.pack, "w") as zf:
            zf.writestr(
                "metadata.jsonl",
                "\n".join(
                    json.dumps(line, ensure_ascii=False)
                    for line in (
                        _pack_line("aa" * 32, "一头猪在叫", ["哼声"]),
                        _pack_line("bb" * 32, "风吹过草地", ["风声"]),
                    )
                )
                + "\n",
            )
            zf.writestr("manifest.json", json.dumps({"files": 2}))

    def tearDown(self):
        self.temp.cleanup()

    def test_reads_descriptions_and_tags_from_base_pack(self):
        meta = knowledge_pack._read_pack_meta(self.pack)
        self.assertEqual(len(meta), 2)
        self.assertEqual(meta["aa" * 32]["description"], "一头猪在叫")
        self.assertEqual(meta["aa" * 32]["tags"], ["哼声"])

    def test_unchanged_rows_are_excluded(self):
        rows = [
            _db_row("aa" * 32, "一头猪在叫", ["哼声"]),
            _db_row("bb" * 32, "风吹过草地", ["风声"]),
        ]
        new_rows, changed_rows = knowledge_pack._split_delta_rows(
            rows, knowledge_pack._read_pack_meta(self.pack)
        )
        self.assertEqual((len(new_rows), len(changed_rows)), (0, 0))

    def test_changed_description_and_tags_are_included(self):
        rows = [
            _db_row("aa" * 32, "一头成年猪在叫唤", ["哼声"]),
            _db_row("bb" * 32, "风吹过草地", ["风声", "大自然"]),
        ]
        new_rows, changed_rows = knowledge_pack._split_delta_rows(
            rows, knowledge_pack._read_pack_meta(self.pack)
        )
        self.assertEqual(len(new_rows), 0)
        self.assertEqual(len(changed_rows), 2)

    def test_new_file_is_counted_as_new_not_changed(self):
        rows = [_db_row("cc" * 32, "小猪尖叫", ["尖叫"])]
        new_rows, changed_rows = knowledge_pack._split_delta_rows(
            rows, knowledge_pack._read_pack_meta(self.pack)
        )
        self.assertEqual((len(new_rows), len(changed_rows)), (1, 0))

    def test_whitespace_is_not_a_change_but_tag_set_is(self):
        meta = knowledge_pack._read_pack_meta(self.pack)
        self.assertEqual(
            knowledge_pack._meta_signature("一头猪在叫", ["哼声"]),
            knowledge_pack._meta_signature("一头猪在叫 ", ["哼声"]),
            "首尾空白不算变更",
        )
        self.assertEqual(
            knowledge_pack._split_delta_rows([_db_row("aa" * 32, "一头猪在叫 ", ["哼声"])], meta)[1],
            [],
        )
        # 标签顺序不同也不算变更
        self.assertEqual(
            knowledge_pack._split_delta_rows([_db_row("bb" * 32, "风吹过草地", ["风声"])], meta)[1],
            [],
        )


if __name__ == "__main__":
    unittest.main()
