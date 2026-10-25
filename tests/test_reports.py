# -*- coding: utf-8 -*-
"""导入报告：未匹配清单能落盘、带 BOM、字段正确。"""
from __future__ import annotations

import csv
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

REPO_ROOT = Path(__file__).resolve().parents[1]
if str(REPO_ROOT / "backend") not in sys.path:
    sys.path.insert(0, str(REPO_ROOT / "backend"))

from core import reports


class UnmatchedCsvTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.env = mock.patch.dict("os.environ", {"APPDATA": self.temp.name})
        self.env.start()

    def tearDown(self) -> None:
        self.env.stop()
        self.temp.cleanup()

    def test_writes_csv_with_bom_and_rows(self) -> None:
        rows = [
            {"rel": "A\\a.wav", "filename": "a.wav", "reason": "no_match", "description": "描述一"},
            {"rel": "B\\b.wav", "filename": "b.wav", "reason": "ambiguous", "description": "描述二"},
        ]
        path = reports.write_unmatched_csv(rows)
        self.assertTrue(Path(path).exists())
        raw = Path(path).read_bytes()
        self.assertTrue(raw.startswith(b"\xef\xbb\xbf"), "CSV 应带 UTF-8 BOM")
        with open(path, encoding="utf-8-sig", newline="") as handle:
            data = list(csv.reader(handle))
        self.assertEqual(data[0], reports.CSV_HEADERS)
        self.assertEqual(len(data), 3)
        self.assertEqual(data[1][2], "no_match")

    def test_reports_dir_created(self) -> None:
        directory = reports.reports_dir()
        self.assertTrue(directory.is_dir())
        self.assertIn("reports", str(directory))

    def test_empty_rows_still_writes_header(self) -> None:
        path = reports.write_unmatched_csv([])
        with open(path, encoding="utf-8-sig", newline="") as handle:
            data = list(csv.reader(handle))
        self.assertEqual(data, [reports.CSV_HEADERS])


if __name__ == "__main__":
    unittest.main()
