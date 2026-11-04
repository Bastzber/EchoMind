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


@dataclass
class SearchCacheEntry:
    """搜索结果缓存条目"""
    query_hash: str
    results: List[SearchResult]
    timestamp: float
    total_count: int


class QueryCache:
    """查询缓存管理器"""

    def __init__(self, max_size: int = 100, ttl: float = 3600):
        """
        初始化缓存

        Args:
            max_size: 最大缓存条目数
            ttl: 缓存过期时间（秒）
        """
        self._cache: Dict[str, SearchCacheEntry] = {}
        self._max_size = max_size
        self._ttl = ttl
        self._lock = asyncio.Lock()

    def _hash_query(self, query: str, **kwargs) -> str:
        """生成查询的哈希值"""
        # JSON canonicalisation keeps nested filters stable regardless of dict
        # insertion order.  Project/revision/model context is supplied by the
        # caller and therefore participates in every key.
        payload = {"query": query, **kwargs}
        key = json.dumps(payload, ensure_ascii=False, sort_keys=True, default=str)
        return hashlib.sha256(key.encode("utf-8")).hexdigest()

    async def get(self, query: str, **kwargs) -> Optional[SearchCacheEntry]:
        """获取缓存结果"""
        async with self._lock:
            query_hash = self._hash_query(query, **kwargs)
            entry = self._cache.get(query_hash)

            if entry is None:
                return None

            # 检查是否过期
            if time.time() - entry.timestamp > self._ttl:
                del self._cache[query_hash]
                return None

            return entry

    async def set(self, query: str, results: List[SearchResult], total_count: int, **kwargs):
        """设置缓存结果"""
        async with self._lock:
            query_hash = self._hash_query(query, **kwargs)

            # 清理过期条目
            current_time = time.time()
            expired_keys = [
                k for k, v in self._cache.items()
                if current_time - v.timestamp > self._ttl
            ]
            for k in expired_keys:
                del self._cache[k]

            # 如果缓存满了，删除最旧的条目
            if len(self._cache) >= self._max_size:
                oldest_key = min(self._cache.keys(), key=lambda k: self._cache[k].timestamp)
                del self._cache[oldest_key]

            self._cache[query_hash] = SearchCacheEntry(
                query_hash=query_hash,
                results=results,
                timestamp=current_time,
                total_count=total_count
            )

    async def clear(self):
        """清空缓存"""
        async with self._lock:
            self._cache.clear()

    def get_stats(self) -> Dict[str, Any]:
        """获取缓存统计"""
        return {
            "size": len(self._cache),
            "max_size": self._max_size,
            "ttl": self._ttl
        }

