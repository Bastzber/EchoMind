# -*- coding: utf-8 -*-
# SoundBot - AI 音效管理器
# 中文查询 → 英文查询翻译器（接入豆包 Doubao-Seed-2.1-Lite）

"""Translate spoken-style Chinese queries into English CLAP keywords.

CLAP is trained on English text; a raw Chinese query produces almost no
signal in the audio-embedding space (verified: "教堂钟声" → 0 relevant hits,
"church bell" → bell sounds ranked top).  This module rewrites a Chinese
query into a compact English keyword phrase via the configured LLM, keeping
the original query untouched for the keyword/文件名 layers.
"""

from __future__ import annotations

import asyncio
import logging
import re
from typing import Dict, Optional

logger = logging.getLogger(__name__)

_CJK_RE = re.compile(r"[\u4e00-\u9fff\u3400-\u4dbf]")

# 简单进程内缓存：同义查询不重复调用 LLM
_translation_cache: Dict[str, str] = {}

_SYSTEM_PROMPT = (
    "You are a sound-effect search assistant. Translate the user's query into "
    "short English keyword phrases suitable for searching a sound effects "
    "library. Keep sound vocabulary precise (e.g. 'bell', 'whoosh', 'rain', "
    "'footsteps'). Output ONLY the translated English phrase, no quotes, no "
    "explanations, no punctuation beyond what the phrase needs."
)


def contains_chinese(text: str) -> bool:
    """Return True when the query contains any CJK character."""
    return bool(_CJK_RE.search(text or ""))


def get_translation_cache() -> Dict[str, str]:
    return _translation_cache


def clear_translation_cache() -> None:
    _translation_cache.clear()


async def translate_query_to_english(
    query: str,
    *,
    timeout: float = 20.0,
) -> str:
    """Translate a Chinese query to English; return the original on failure.

    Only queries containing CJK are sent to the LLM.  Pure-English queries
    pass through untouched (no latency, no cost).
    """
    query = str(query or "").strip()
    if not query:
        return query
    if not contains_chinese(query):
        return query

    cached = _translation_cache.get(query)
    if cached is not None:
        return cached

    try:
        from core.llm_client import get_llm_client
        from core.llm_config_manager import get_llm_config_manager

        manager = get_llm_config_manager()
        # 未配置可用的 LLM 时直接回退原文，不阻塞搜索
        if not manager.get_llm_provider() or not manager.get_current_llm_config().base_url:
            logger.debug("LLM 未配置，中文查询跳过翻译: %s", query)
            return query

        client = get_llm_client()
        if not client.is_available:
            logger.debug("LLM 不可用，中文查询跳过翻译: %s", query)
            return query

        chunks: list = []
        async for chunk in client.chat_simple(
            message=query,
            system_prompt=_SYSTEM_PROMPT,
            temperature=0.0,
            stream=False,
        ):
            chunks.append(chunk)
        translated = "".join(chunks).strip().strip('"').strip("'")
        if not translated or contains_chinese(translated):
            # 翻译失败/仍然中文 → 回退原文
            logger.warning("中文查询翻译结果无效，回退原文: %r -> %r", query, translated)
            return query
        # 合并多词短语为单个查询串（保留空格让 CLAP 更好理解）
        translated = re.sub(r"\s+", " ", translated)
        _translation_cache[query] = translated
        logger.info("中文查询翻译: %r -> %r", query, translated)
        return translated
    except Exception as exc:
        logger.warning("中文查询翻译失败，回退原文 %r: %s", query, exc)
        return query
