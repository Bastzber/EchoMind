# -*- coding: utf-8 -*-
"""皮肤：白名单变量、危险 CSS 过滤、导入/删除、内置不可删。"""
from __future__ import annotations

import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

REPO_ROOT = Path(__file__).resolve().parents[1]
if str(REPO_ROOT / "backend") not in sys.path:
    sys.path.insert(0, str(REPO_ROOT / "backend"))

from core import skins


class SkinTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.env = mock.patch.dict("os.environ", {"APPDATA": self.temp.name})
        self.env.start()

    def tearDown(self) -> None:
        self.env.stop()
        self.temp.cleanup()

    def test_builtin_skins_present(self) -> None:
        items = skins.list_skins()
        ids = {item["id"] for item in items}
        self.assertIn("default", ids)
        self.assertIn("midnight", ids)
        self.assertTrue(all(item["builtin"] for item in items))

    def test_import_and_load_custom_skin(self) -> None:
        folder = Path(self.temp.name) / "myskin"
        folder.mkdir()
        (folder / "theme.json").write_text(json.dumps({
            "id": "myskin", "name": "我的皮肤", "author": "cj", "version": "1.0",
            "colors": {"--bg-primary": "#101010", "--unknown-var": "#fff"},
        }), encoding="utf-8")
        skin = skins.import_skin(str(folder))
        self.assertEqual(skin["id"], "myskin")
        self.assertEqual(skin["colors"].get("--bg-primary"), "#101010")
        self.assertNotIn("--unknown-var", skin["colors"])
        self.assertIn("myskin", {item["id"] for item in skins.list_skins()})

    def test_dangerous_css_rejected(self) -> None:
        with self.assertRaises(ValueError):
            skins._sanitize_css("@import url('http://evil/x.css');")
        with self.assertRaises(ValueError):
            skins._sanitize_css(".a{background:url(https://evil/x.png)}")
        self.assertEqual(skins._sanitize_css(".a{color:red}"), ".a{color:red}")

    def test_cannot_delete_builtin(self) -> None:
        with self.assertRaises(ValueError):
            skins.delete_skin("midnight")

    def test_delete_custom_skin(self) -> None:
        folder = Path(self.temp.name) / "tmp-skin"
        folder.mkdir()
        (folder / "theme.json").write_text(json.dumps({"id": "tmp-skin", "name": "T"}), encoding="utf-8")
        skins.import_skin(str(folder))
        self.assertTrue(skins.delete_skin("tmp-skin"))
        self.assertIsNone(skins.find_skin("tmp-skin"))

    def test_missing_manifest_rejected(self) -> None:
        folder = Path(self.temp.name) / "empty"
        folder.mkdir()
        with self.assertRaises(ValueError):
            skins.import_skin(str(folder))


if __name__ == "__main__":
    unittest.main()
