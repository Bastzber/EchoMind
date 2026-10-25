# -*- coding: utf-8 -*-
"""目录健康检查：识别改名/删除的目录，推导库根。"""
from __future__ import annotations

import sys
import tempfile
import unittest
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
if str(REPO_ROOT / "backend") not in sys.path:
    sys.path.insert(0, str(REPO_ROOT / "backend"))

from core import library_health


class FolderHealthTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        (self.root / "A").mkdir()
        (self.root / "A" / "a.wav").write_bytes(b"x")
        (self.root / "B").mkdir()
        (self.root / "B" / "b.wav").write_bytes(b"yy")

    def tearDown(self) -> None:
        self.temp.cleanup()

    def test_healthy_library(self) -> None:
        paths = [str(self.root / "A" / "a.wav"), str(self.root / "B" / "b.wav")]
        result = library_health.folder_health(paths)
        self.assertTrue(result["healthy"])
        self.assertEqual(result["total_dirs"], 2)
        self.assertEqual(result["missing_count"], 0)

    def test_detects_renamed_directory(self) -> None:
        paths = [str(self.root / "A" / "a.wav"), str(self.root / "Gone" / "c.wav")]
        result = library_health.folder_health(paths)
        self.assertFalse(result["healthy"])
        self.assertEqual(result["missing_count"], 1)
        self.assertEqual(result["missing"][0]["path"], str(self.root / "Gone"))
        self.assertEqual(result["missing_files"], 1)

    def test_missing_sorted_by_file_count(self) -> None:
        paths = [str(self.root / "X" / f"{i}.wav") for i in range(5)]
        paths += [str(self.root / "Y" / "one.wav")]
        result = library_health.folder_health(paths)
        self.assertEqual([item["path"] for item in result["missing"]],
                         [str(self.root / "X"), str(self.root / "Y")])

    def test_limit_applies_but_counts_keep_full(self) -> None:
        paths = [str(self.root / "M" / f"{i}.wav") for i in range(3)]
        paths += [str(self.root / "N" / "n.wav")]
        result = library_health.folder_health(paths, limit=1)
        self.assertEqual(len(result["missing"]), 1)
        self.assertEqual(result["missing_count"], 2)
        self.assertEqual(result["missing_files"], 4)

    def test_common_root(self) -> None:
        paths = [str(self.root / "A" / "a.wav"), str(self.root / "B" / "b.wav")]
        self.assertEqual(library_health.common_root(paths).lower(), str(self.root).lower())


if __name__ == "__main__":
    unittest.main()
