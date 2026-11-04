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


class FileSnapshotMixin:
    """文件快照 + 关键词检索相关的方法。由 search_engine.py 拆出，靠 mixin 组回主类。"""
    def _get_all_files(
        self,
        filters: Optional[Dict[str, Any]] = None
    ) -> List[Dict[str, Any]]:
        """获取所有文件用于关键词搜索（从 SQLite 数据库获取，支持未索引的文件）。

        5 万条文件每次搜索都从 SQLite 重新构造对象要 9~11 秒，是搜索慢的主因。
        这里按（工程 / 文件数 / 过滤条件）缓存快照，5 分钟过期；导入或索引
        变化会改变文件数，从而自动失效。
        """
        try:
            from core.database import get_db_manager
            db_for_count = get_db_manager()
            try:
                file_count = int(db_for_count.get_file_count(self.project_id))
            except Exception:
                file_count = -1
            cache_key = (
                self.project_id,
                file_count,
                json.dumps(filters or {}, sort_keys=True, default=str),
            )
            now = time.time()
            cached = _FILES_SNAPSHOT_CACHE.get(cache_key)
            if cached and (now - cached[0]) < _FILES_SNAPSHOT_TTL:
                logging.getLogger("soundmind").info(
                    "[SearchTiming] snapshot_hit age=%.0fs files=%d searcher=%s",
                    now - cached[0], len(cached[1]), id(self),
                )
                return cached[1]
            logging.getLogger("soundmind").info(
                "[SearchTiming] snapshot_miss key=(%s,%s,%s) searcher=%s",
                cache_key[0], cache_key[1], cache_key[2], id(self),
            )
        except Exception:
            cache_key = None

        try:
            # 从 SQLite 数据库获取文件列表，而不是 ChromaDB
            # 这样可以搜索到未索引的文件（只有元数据，没有向量）
            from core.database import get_db_manager
            db_manager = get_db_manager()
            
            # 轻量元组查询：5 万条不再逐条构造 AudioFileRecord（省 ~9 秒）
            try:
                rows = db_manager.get_search_rows(self.project_id)
                # 明确物化成列表：调用方若被 mock 成返回 Mock，迭代时才报错，
                # 这里提前触发以便回退到下面的慢路径。
                rows = list(rows) if rows is not None else None
            except Exception as _rows_exc:
                rows = None
                logging.getLogger("soundmind").warning(
                    "[SearchTiming] get_search_rows 失败，回退慢路径: %r", _rows_exc
                )

            all_files = []
            if rows is not None:
                for file_uuid, path, filename, duration, file_size, sample_rate, channels, tags, ai_description in rows:
                    filename = filename or ""
                    file_ext = filename.split('.')[-1].lower() if '.' in filename else ""
                    _fn_lower = filename.lower()
                    metadata = {
                        "file_id": file_uuid,
                        "file_path": path,
                        "filename": filename,
                        "duration": duration,
                        "format": file_ext,
                        "size": file_size,
                        "sample_rate": sample_rate,
                        "channels": channels,
                        "folder_path": "",
                        "parsed_name": "",
                        "name_description": "",
                        "metadata_tags": tags,
                        "_filename_lower": _fn_lower,
                        "_filename_base": _fn_lower.rsplit(".", 1)[0] if "." in _fn_lower else _fn_lower,
                        "_haystack": (filename + "|" + path + "|" + str(tags or "")
                                      + "|" + str(ai_description or "")).lower(),
                    }
                    if filters:
                        skip = False
                        for key, condition in filters.items():
                            if key == "duration":
                                value = metadata.get("duration", 0) or 0
                                if isinstance(condition, dict):
                                    if "$gte" in condition and value < condition["$gte"]:
                                        skip = True
                                        break
                                    if "$lte" in condition and value > condition["$lte"]:
                                        skip = True
                                        break
                                elif value != condition:
                                    skip = True
                                    break
                            elif key in ("sample_rate", "channels"):
                                if metadata.get(key) != condition:
                                    skip = True
                                    break
                            elif key == "format":
                                if str(metadata.get("format", "")).lower() != str(condition).lower():
                                    skip = True
                                    break
                        if skip:
                            continue
                    all_files.append(metadata)
                logging.getLogger("soundmind").info(
                    "[SearchTiming] snapshot_build_fast files=%d", len(all_files)
                )
                try:
                    if cache_key is not None:
                        _FILES_SNAPSHOT_CACHE[cache_key] = (time.time(), all_files)
                        if len(_FILES_SNAPSHOT_CACHE) > 8:
                            oldest = min(
                                _FILES_SNAPSHOT_CACHE,
                                key=lambda k: _FILES_SNAPSHOT_CACHE[k][0],
                            )
                            _FILES_SNAPSHOT_CACHE.pop(oldest, None)
                except Exception:
                    pass
                return all_files

            # 回退：旧路径（逐条构造记录）
            all_records = db_manager.get_files_by_project(self.project_id)

            # 转换为与 ChromaDB 元数据兼容的格式
            for record in all_records:
                # 从 filename 提取格式（扩展名）
                filename = record.filename
                file_ext = filename.split('.')[-1].lower() if '.' in filename else ""

                metadata = {
                    "file_id": record.file_uuid,
                    "file_path": record.path,
                    "filename": filename,
                    "duration": record.duration,
                    "format": file_ext,
                    "size": record.file_size,
                    "sample_rate": record.sample_rate,
                    "channels": record.channels,
                    "folder_path": "",  # SQLite 中没有这个字段
                    "parsed_name": "",  # SQLite 中没有这个字段
                    "name_description": "",  # SQLite 中没有这个字段
                    "metadata_tags": record.tags,  # 使用 tags 字段
                }
                
                # 应用过滤条件
                if filters:
                    skip = False
                    for key, condition in filters.items():
                        if key == "duration":
                            # 处理 $gte, $lte 等条件
                            if isinstance(condition, dict):
                                if "$gte" in condition and metadata.get("duration", 0) < condition["$gte"]:
                                    skip = True
                                    break
                                if "$lte" in condition and metadata.get("duration", 0) > condition["$lte"]:
                                    skip = True
                                    break
                            elif metadata.get("duration") != condition:
                                skip = True
                                break
                        elif key in ["sample_rate", "channels"]:
                            if metadata.get(key) != condition:
                                skip = True
                                break
                        elif key == "format":
                            if metadata.get("format", "").lower() != condition.lower():
                                skip = True
                                break
                    
                    if skip:
                        continue
                
                all_files.append(metadata)
            
            logging.getLogger("soundmind").warning(
                "[SearchTiming] snapshot_build_slow(records) files=%d", len(all_files)
            )
            try:
                if cache_key is not None:
                    _FILES_SNAPSHOT_CACHE[cache_key] = (time.time(), all_files)
                    if len(_FILES_SNAPSHOT_CACHE) > 8:
                        oldest = min(
                            _FILES_SNAPSHOT_CACHE,
                            key=lambda k: _FILES_SNAPSHOT_CACHE[k][0],
                        )
                        _FILES_SNAPSHOT_CACHE.pop(oldest, None)
            except Exception:
                pass
            return all_files
            
        except Exception as e:
            logger.warning(f"从 SQLite 获取文件列表失败: {e}")
            # 如果 SQLite 获取失败，回退到 ChromaDB
            try:
                all_files = []
                offset = 0
                batch_size = 10000
                
                while True:
                    results = self.collection.get(
                        limit=batch_size,
                        offset=offset,
                        where=build_chroma_where(filters)
                    )
                    
                    if not results or not results.get("ids"):
                        break
                    
                    for i, file_id in enumerate(results["ids"]):
                        metadata = dict(results["metadatas"][i] or {})
                        metadata["file_id"] = str(file_id)
                        all_files.append(metadata)
                    
                    if len(results["ids"]) < batch_size:
                        break
                    
                    offset += batch_size
                    
                    if offset > 1000000:
                        logger.warning(f"文件数量超过100万，停止获取更多文件")
                        break
                
                logger.info(f"从 ChromaDB 获取文件列表完成: {len(all_files)} 个文件")
                return all_files
            except Exception as e2:
                logger.error(f"从 ChromaDB 获取文件列表也失败: {e2}")
                return []
    def _exact_keyword_search(
        self,
        query: str,
        filters: Optional[Dict[str, Any]] = None,
        files_snapshot: Optional[List[Dict[str, Any]]] = None,
    ) -> List[SearchResult]:
        """
        第1层：精确关键词搜索

        匹配规则：
        - 文件名完全包含查询词
        - 标签包含查询词
        - 文件夹路径包含查询词
        """
        if not query or not query.strip():
            return []

        all_files = files_snapshot if files_snapshot is not None else self._get_all_files(filters)
        results = []
        _prefilter_term = query.lower().strip()

        for metadata in all_files:
            if _prefilter_term and not self._haystack_hit(metadata, _prefilter_term):
                continue
            filename = metadata.get("filename", "")
            keyword_score, match_level = self._keyword_match_score(query, filename, metadata)

            # 放宽匹配要求：包含 weak 匹配，同时降低分数阈值到 0.3
            if match_level in ("exact", "partial", "weak") and keyword_score >= 0.3:
                final_score = self._compute_adaptive_score(
                    keyword_score, 0.0, match_level
                )

                results.append(SearchResult(
                    file_path=metadata.get("file_path", ""),
                    filename=filename,
                    similarity=final_score,
                    duration=metadata.get("duration", 0.0),
                    format=metadata.get("format", "") or "",
                    metadata={
                        **metadata,
                        "match_level": match_level,
                        "keyword_score": keyword_score,
                        "semantic_score": 0.0,
                        "search_layer": 1
                    }
                ))

        # 按分数排序
        results.sort(key=lambda x: x.similarity, reverse=True)
        return results
    def _expanded_keyword_search(
        self,
        query: str,
        filters: Optional[Dict[str, Any]] = None,
        files_snapshot: Optional[List[Dict[str, Any]]] = None,
        expanded_queries: Optional[List[str]] = None,
    ) -> List[SearchResult]:
        """
        第2层：分词扩展搜索

        使用中文分词 + UCS 关键词扩展进行多路召回
        """
        if not query or not query.strip():
            return []

        # 获取扩展查询词
        expanded_queries = list(
            expanded_queries
            if expanded_queries is not None
            else self._text_processor.expand_query(query)
        )

        # 如果扩展结果很少（只有原始查询），也尝试使用扩展词本身
        # 这样可以搜索文件名包含查询词的文件
        if len(expanded_queries) <= 1:
            # 尝试使用原始查询的分词结果进行搜索
            tokens = self._text_processor.tokenize(query)
            if tokens and len(tokens) > 1:
                expanded_queries.extend(tokens)
            # 不再直接返回空列表，而是继续使用原始查询进行搜索

        # 查询自身的分词（如「雨滴」「窗户」）比 UCS 同义词更贴近原意，
        # 排序时要高于同义词扩展。
        try:
            query_tokens = {
                token.lower()
                for token in self._text_processor.tokenize(query)
                if token and len(token) >= 2
            }
        except Exception:
            query_tokens = set()
        _GENERIC_TOKENS = {"声音", "音效", "声响", "声音效果"}

        all_files = files_snapshot if files_snapshot is not None else self._get_all_files(filters)
        results = []

        # 使用集合跟踪已处理的文件，避免重复
        processed_paths = set()

        for expanded_query in expanded_queries:
            # 对于英文单词等没有扩展的查询，也需要搜索原始查询
            is_original = expanded_query.lower() == query.lower()
            
            # 不再跳过原始查询，确保原始查询的精确匹配结果被包含
            # 即使与第1层有重复，后续会去重并保留最高分数

            _exp_term = expanded_query.lower().strip()
            for metadata in all_files:
                file_path = metadata.get("file_path", "")

                # 避免重复处理同一文件
                if file_path in processed_paths:
                    continue

                if _exp_term and not self._haystack_hit(metadata, _exp_term):
                    continue

                filename = metadata.get("filename", "")
                keyword_score, match_level = self._keyword_match_score(
                    expanded_query, filename, metadata
                )

                # 对于无扩展的查询，降低匹配要求
                min_score = 0.3 if len(expanded_queries) <= 1 else 0.5
                if match_level in ("exact", "partial", "weak") and keyword_score >= min_score:
                    processed_paths.add(file_path)
                    final_score = self._compute_adaptive_score(
                        keyword_score, 0.0, match_level
                    )
                    if not is_original:
                        term_lower = expanded_query.lower().strip()
                        if term_lower in _GENERIC_TOKENS:
                            continue
                        if term_lower in query_tokens:
                            # 原查询自身的分词（如「雨滴」「窗户」）接近原意
                            final_score = min(0.65, 0.45 + 0.20 * keyword_score)
                        else:
                            # 同义词扩展只用于召回，排序让位给原查询与语义命中。
                            # 否则 DRIP.wav、砂纸、车床这类会被顶到第一位。
                            final_score = min(0.40, 0.25 + 0.15 * keyword_score)

                    results.append(SearchResult(
                        file_path=file_path,
                        filename=filename,
                        similarity=final_score,
                        duration=metadata.get("duration", 0.0),
                        format=metadata.get("format", "") or "",
                        metadata={
                            **metadata,
                            "match_level": match_level,
                            # 合并阶段读的是 metadata 里的 keyword_score，
                            # 必须放加权后的分数，否则扩展词原始高分（1.0）会
                            # 绕过封顶，又把 DRIP.wav 顶回第一位。
                            "keyword_score": final_score,
                            "raw_keyword_score": keyword_score,
                            "semantic_score": 0.0,
                            "search_layer": 2,
                            "matched_query": expanded_query
                        }
                    ))

        # 按分数排序
        results.sort(key=lambda x: x.similarity, reverse=True)
        return results
    def _fts_keyword_search(
        self,
        query: str,
        filters: Optional[Dict[str, Any]] = None,
        limit: int = 200,
    ) -> List[SearchResult]:
        """FTS5 + BM25：中文短查询的主通道。"""
        from core.database import get_db_manager

        rows = get_db_manager().fts_search(self.project_id, query, limit=limit)
        if not rows:
            return []
        results: List[SearchResult] = []
        for index, row in enumerate(rows):
            filename = str(row.get("filename") or "")
            score = max(0.35, 0.95 - index * 0.01)
            metadata = {
                "file_id": row.get("file_id"),
                "file_path": row.get("file_path"),
                "filename": filename,
                "duration": row.get("duration") or 0.0,
                "size": row.get("size") or 0,
                "sample_rate": row.get("sample_rate"),
                "channels": row.get("channels"),
                "tags": row.get("tags"),
                "ai_description": row.get("ai_description") or "",
                "format": filename.rsplit(".", 1)[-1].lower() if "." in filename else "",
                "match_level": "fts",
                "keyword_score": score,
                "semantic_score": 0.0,
                "search_layer": 0,
            }
            results.append(
                SearchResult(
                    file_path=str(row.get("file_path") or ""),
                    filename=filename,
                    similarity=score,
                    duration=float(row.get("duration") or 0.0),
                    format=metadata["format"],
                    metadata=metadata,
                )
            )
        return results
    def _keyword_search_from_snapshot(
        self,
        query: str,
        filters: Optional[Dict[str, Any]] = None,
    ) -> Tuple[List[str], List[SearchResult], List[SearchResult]]:
        """Expand and match a query against one immutable metadata snapshot.

        The caller may run this entire method in a worker thread so both the
        SQLite read and O(files × expanded terms) matching stay off the event
        loop.  Exact and expanded branches intentionally share the same list.
        """
        expanded_queries = list(self._text_processor.expand_query(query))
        if query not in expanded_queries:
            expanded_queries.insert(0, query)
        # 丢掉"声音/音效"这类泛词扩展：它们会让任何带"声音"的文件拿到 kw=0.95，
        # 把真正相关的结果挤出前列（实测"下雨的声音"第 2 条是混响音乐）。
        _generic = {"声音", "音效", "声", "声响", "声音效果", "sound", "audio"}
        expanded_queries = [
            q for q in expanded_queries
            if q == query or (q.strip() and q.strip().lower() not in _generic)
        ]
        # 第一优先：FTS5 二元组检索（中文短查询又快又准）
        try:
            fts_results = self._fts_keyword_search(query, filters)
        except Exception as exc:
            logger.debug("FTS 检索不可用，回退旧通道: %s", exc)
            fts_results = []
        if len(fts_results) >= 5:
            return expanded_queries, fts_results, []

        files_snapshot = self._get_all_files(filters)
        exact_results = self._exact_keyword_search(
            query, filters, files_snapshot=files_snapshot
        )
        if fts_results:
            seen = {r.file_path for r in fts_results}
            exact_results = fts_results + [
                r for r in exact_results if r.file_path not in seen
            ]
        # 精确层已经够用时就跳过扩展层：扩展要对 5 万条再扫一遍，
        # 是关键词阶段的主要开销之一。
        if len(exact_results) >= 50:
            return expanded_queries, exact_results, []
        expanded_results = self._expanded_keyword_search(
            query,
            filters,
            files_snapshot=files_snapshot,
            expanded_queries=expanded_queries,
        )
        return expanded_queries, exact_results, expanded_results
    def get_all_indexed_files(self) -> List[Dict[str, Any]]:
        """获取所有已索引的文件"""
        try:
            files = []
            total = int(self.collection.count())
            batch = 1000
            offset = 0
            while offset < total:
                results = self.collection.get(
                    limit=batch, offset=offset, include=["metadatas"]
                )
                if not results or not results.get("metadatas"):
                    break
                for metadata in results["metadatas"]:
                    files.append(metadata)
                if not results.get("ids"):
                    break
                offset += len(results["ids"])
            return files
        except Exception as e:
            logger.error(f"获取索引文件列表失败: {e}")
            return []
