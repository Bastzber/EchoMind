# -*- coding: utf-8 -*-
"""自然语言查询解析（nl_query）的单元测试：不联网，只测降级和清洗。"""
from __future__ import annotations

import sys
import unittest
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
if str(REPO_ROOT / "backend") not in sys.path:
    sys.path.insert(0, str(REPO_ROOT / "backend"))

from core import nl_query  # noqa: E402


class ExtractJsonTests(unittest.TestCase):
    def test_plain_json(self):
        parsed = nl_query._extract_json('{"keywords": ["猪叫"]}')
        self.assertEqual(parsed["keywords"], ["猪叫"])

    def test_fenced_json(self):
        fence = chr(96) * 3
        text = fence + "json\n" + '{"keywords": ["蹄声"], "tags": ["低频"]}' + "\n" + fence
        parsed = nl_query._extract_json(text)
        self.assertEqual(parsed["tags"], ["低频"])

    def test_json_with_chatter_around_it(self):
        text = '好的，我理解如下：{"keywords": ["风声"]} 希望有用'
        parsed = nl_query._extract_json(text)
        self.assertEqual(parsed["keywords"], ["风声"])

    def test_garbage_returns_none(self):
        self.assertIsNone(nl_query._extract_json("我不知道"))
        self.assertIsNone(nl_query._extract_json(""))


class NormalizeTests(unittest.TestCase):
    def test_drops_bad_fields(self):
        parsed = nl_query.normalize({"keywords": ["  "], "tags": "低频", "channels": 7}, "短促的脚步声")
        self.assertEqual(parsed["keywords"], ["短促的脚步声"])  # 空关键词回退到原句
        self.assertEqual(parsed["tags"], ["低频"])  # 模型给了字符串也收下
        self.assertIsNone(parsed["channels"])
        self.assertFalse(parsed["degraded"])

    def test_duration_and_channels(self):
        parsed = nl_query.normalize({"keywords": ["脚步"], "min_duration": "0.5", "max_duration": 99999, "channels": "1"}, "脚步")
        self.assertEqual(parsed["min_duration"], 0.5)
        self.assertIsNone(parsed["max_duration"])  # 荒谬值丢掉
        self.assertEqual(parsed["channels"], 1)

    def test_fallback_marks_degraded(self):
        result = nl_query.fallback("低沉的猪哼", "AI 解析失败")
        self.assertTrue(result["degraded"])
        self.assertEqual(result["keywords"], ["低沉的猪哼"])
        self.assertIn("AI 解析失败", result["explain"])

    def test_build_query_string(self):
        interpreted = {"keywords": ["猪", "哼"], "tags": ["低频"]}
        self.assertEqual(nl_query.build_query_string(interpreted, "低沉的猪哼"), "猪 哼")
        self.assertEqual(nl_query.build_query_string({"keywords": []}, "原句"), "原句")


if __name__ == "__main__":
    unittest.main()
