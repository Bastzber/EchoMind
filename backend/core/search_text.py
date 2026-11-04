# -*- coding: utf-8 -*-
# SoundBot - AI 音效管理器
# Copyright (C) 2026 Nagisa_Huckrick (胡杨)
#
# This program is free software: you can redistribute it and/or modify
# it under the terms of the GNU General Public License as published by
# the Free Software Foundation, either version 3 of the License, or
# (at your option) any later version.
#
# This program is distributed in the hope that it will be useful,
# but WITHOUT ANY WARRANTY; without even the implied warranty of
# MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
# GNU General Public License for more details.
#
# You should have received a copy of the GNU General Public License
# along with this program.  If not, see <https://www.gnu.org/licenses/>.
"""
优化后的语义搜索引擎

特性：
1. 三层搜索架构：精确关键词 -> 分词扩展 -> 语义搜索
2. 查询缓存 - 缓存常用查询的 embedding 和结果
3. 异步搜索 - 支持 WebSocket 进度推送
4. 自适应评分 - 根据匹配类型自动调整分数
5. 中文优化 - 支持中文分词和拼音匹配
"""

import os
import re
import time
import logging
import asyncio
import numpy as np
import json
from typing import List, Optional, Dict, Any, Tuple, Callable
from dataclasses import dataclass, field
from functools import lru_cache

# 关键词搜索的文件快照缓存：5 万条从 SQLite 重建要 ~10s，命中后只剩内存匹配。
# 键里带文件数，导入/删除后自动失效；另有 TTL 兜底。
_FILES_SNAPSHOT_CACHE: Dict[tuple, tuple] = {}
_FILES_SNAPSHOT_TTL = 300.0

# 查询结果缓存必须跨 searcher 实例共享：索引 revision 一变，上层就会新建
# searcher，实例级缓存随之清零，导致同样的查询每次都重跑全链路。
_GLOBAL_QUERY_CACHE = None
import hashlib
import threading
from pathlib import Path

import config
from core.embedder import (
    peek_embedder,
    get_embedder_fingerprint,
    get_text_embedding_config_fingerprint,
)
from core.indexer import get_collection_revision, safe_project_chroma_path
from core.query_translator import contains_chinese, translate_query_to_english
from core.query_lexicon import translate_to_english as translate_with_lexicon
from core.searcher import (
    SearchResult,
    AudioSearcher,
    MetadataTextSearcher,
    build_chroma_where,
    cosine_similarity_from_distance,
)

logger = logging.getLogger(__name__)


class ChineseTextProcessor:
    """中文文本处理器 - 使用 UCS 关键词库 + jieba 分词"""

    def __init__(self):
        # 惰性加载 UCS 关键词
        from core.ucs_keywords import UCSKeywordProcessor
        self._ucs_processor = UCSKeywordProcessor()

    def extract_keywords(self, text: str) -> List[str]:
        """提取关键词（使用 UCS 库）"""
        return self._ucs_processor.extract_keywords(text)

    def expand_query(self, query: str) -> List[str]:
        """扩展查询（使用 UCS 库 + 中文分词）"""
        return self._ucs_processor.expand_query_with_tokenization(query)

    def tokenize(self, text: str) -> List[str]:
        """中文分词"""
        return self._ucs_processor.tokenize(text)

