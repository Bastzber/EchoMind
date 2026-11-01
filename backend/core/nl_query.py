# -*- coding: utf-8 -*-
"""自然语言 → 检索条件（给 PR 面板 / MCP 用）。

一句话（"低沉的、像猪哼的，最好短一点"）拆成结构化条件：
关键词、标签提示、时长区间、声道；再交给现有的混合搜索去跑。

刻意做得「可降级」：LLM 不可用、超时、返回不是 JSON 时，直接把原句当关键词，
面板上会标注「已降级为关键词搜索」，不会因为 DeepSeek 抖一下就搜不了。
"""
from __future__ import annotations

import json
import logging
import re
from typing import Any, Dict, List, Optional

logger = logging.getLogger(__name__)

# 常见听感标签，给模型当锚点（不追求全，够它把「短促」映射到「短尾」即可）
TAG_HINTS = [
    "低频", "高频", "短尾", "长尾", "连续", "尖锐", "低沉", "清脆", "沉重",
    "浑厚", "柔和", "环境音", "电子质感", "鸣叫", "吼叫", "嘶鸣", "脚步",
    "撞击", "风声", "水声", "机械", "人群", "音乐", "武器", "魔法", "生物",
]

SYSTEM_PROMPT = (
    "你是音效库的查询解析器。把用户的一句话变成检索条件，只输出 JSON，"
    "不要解释、不要代码块、不要多余文字。\n"
    "字段：\n"
    "  keywords: 字符串数组，1~4 个。用于语义+关键词检索，保留声音本身的名词、"
    "拟声词、情绪、材质；去掉「找」「帮我」「一些」「那种」这类空词。\n"
    "  tags: 字符串数组，0~3 个。只能从下面的标签表里挑，对不上就给空数组。\n"
    "  min_duration: 数字（秒）或 null。「短促/短」约 2，「一秒左右」约 1。\n"
    "  max_duration: 数字（秒）或 null。「长/悠长」约 5。\n"
    "  channels: 1 或 2 或 null（「单声道」=1，「立体声」=2）。\n"
    "  explain: 一句中文，说明你把它理解成了什么（给用户看，20 字以内）。\n"
    "标签表：" + "、".join(TAG_HINTS)
)

_FENCE = chr(96) * 3
_JSON_BLOCK = re.compile(_FENCE + r"(?:json)?\s*([\s\S]*?)" + _FENCE, re.MULTILINE)


def _extract_json(text: str) -> Optional[Dict[str, Any]]:
    """从模型输出里抠出第一个 JSON 对象（容忍代码块包裹和前后废话）。"""
    if not text:
        return None
    candidates: List[str] = []
    match = _JSON_BLOCK.search(text)
    if match:
        candidates.append(match.group(1))
    candidates.append(text)
    for candidate in candidates:
        start = candidate.find("{")
        end = candidate.rfind("}")
        if start < 0 or end <= start:
            continue
        try:
            parsed = json.loads(candidate[start : end + 1])
        except Exception:
            continue
        if isinstance(parsed, dict):
            return parsed
    return None


def _as_float(value: Any) -> Optional[float]:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    if number <= 0 or number > 3600:
        return None
    return round(number, 3)


def normalize(raw: Dict[str, Any], text: str) -> Dict[str, Any]:
    """把模型输出收拾成稳定结构（字段缺失/类型不对都不会炸）。"""
    raw_keywords = raw.get("keywords")
    raw_tags = raw.get("tags")
    if isinstance(raw_keywords, str):
        raw_keywords = [raw_keywords]
    if isinstance(raw_tags, str):
        raw_tags = [raw_tags]
    keywords = [str(k).strip() for k in (raw_keywords or []) if str(k).strip()]
    tags = [str(t).strip() for t in (raw_tags or []) if str(t).strip()]
    channels = raw.get("channels")
    try:
        channels = int(channels) if channels is not None else None
    except (TypeError, ValueError):
        channels = None
    if channels not in (1, 2):
        channels = None
    return {
        "keywords": keywords[:4] or [text.strip()],
        "tags": tags[:3],
        "min_duration": _as_float(raw.get("min_duration")),
        "max_duration": _as_float(raw.get("max_duration")),
        "channels": channels,
        "explain": str(raw.get("explain") or "").strip()[:40],
        "raw_query": text,
        "degraded": False,
    }


def fallback(text: str, reason: str = "") -> Dict[str, Any]:
    """LLM 不可用时的解析结果：原句当关键词。"""
    return {
        "keywords": [text.strip()],
        "tags": [],
        "min_duration": None,
        "max_duration": None,
        "channels": None,
        "explain": "按关键词搜索" + (f"（{reason}）" if reason else ""),
        "raw_query": text,
        "degraded": True,
    }


def build_query_string(interpreted: Dict[str, Any], text: str) -> str:
    """拼成给 /api/v1/search 的 query。"""
    keywords = interpreted.get("keywords") or []
    joined = " ".join(str(k) for k in keywords if str(k).strip())
    return joined or text
