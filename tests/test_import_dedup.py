# -*- coding: utf-8 -*-
"""导入去重：按文件名+大小过滤，路径不同也算重复。"""
from __future__ import annotations

import sys
import tempfile
import unittest
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
if str(REPO_ROOT / "backend") not in sys.path:
    sys.path.insert(0, str(REPO_ROOT / "backend"))

import main  # noqa: E402


class FilterDuplicateTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.dup = self.root / "dup.wav"
        self.new = self.root / "new.wav"
        self.dup.write_bytes(b"x" * 100)
        self.new.write_bytes(b"y" * 50)

    def tearDown(self) -> None:
        self.temp.cleanup()

    def test_keeps_only_new(self) -> None:
        pairs = {("dup.wav", 100)}
        kept, skipped = main._filter_duplicate_paths([self.dup, self.new], pairs)
        self.assertEqual([p.name for p in kept], ["new.wav"])
        self.assertEqual(skipped, 1)

    def test_same_name_different_size_kept(self) -> None:
        pairs = {("dup.wav", 999)}
        kept, skipped = main._filter_duplicate_paths([self.dup], pairs)
        self.assertEqual(len(kept), 1)
        self.assertEqual(skipped, 0)

    def test_empty_pairs_keeps_all(self) -> None:
        kept, skipped = main._filter_duplicate_paths([self.dup, self.new], set())
        self.assertEqual(len(kept), 2)
        self.assertEqual(skipped, 0)


if __name__ == "__main__":
    unittest.main()
