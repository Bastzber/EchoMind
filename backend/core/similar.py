# -*- coding: utf-8 -*-
"""「找相似」：按「标签 + 描述 + 音频向量」给一条音效找邻居。

排序口径（用户 2026-11-01 确认）：

1. **标签/描述匹配段**（同类）永远排在前面：先看标签交集，再看描述词重叠，
   最后用文本元数据索引的语义分做同分内的次序；
2. **音频向量段**（听起来像）接在后面：CLAP 余弦 ≥ 阈值才收，按相似度降序；
3. 两段不混排，总数默认 100；不把「自定义文件夹 / 系统分类」算作同类依据。
"""
from __future__ import annotations

import json
import logging
import re
from typing import Any, Dict, Iterable, List, Optional, Tuple

logger = logging.getLogger(__name__)

DEFAULT_LIMIT = 100
DEFAULT_AUDIO_THRESHOLD = 0.55
DEFAULT_AUDIO_LIMIT = 50

_CJK = re.compile(r"[\u3400-\u9fff]")
_WORD = re.compile(r"[a-z0-9]+")


def _parse_tags(raw: Any) -> List[str]:
    if raw is None:
        return []
    if isinstance(raw, (list, tuple, set)):
        return [str(item).strip() for item in raw if str(item).strip()]
    text = str(raw).strip()
    if not text:
        return []
    if text[0] in "[{":
        try:
            parsed = json.loads(text)
            if isinstance(parsed, list):
                return [str(item).strip() for item in parsed if str(item).strip()]
        except ValueError:
            pass
    return [part.strip() for part in re.split(r"[,，;；|]", text) if part.strip()]


def _descriptor_terms(text: str) -> set:
    """描述拆片：中文 2-gram + 英文/数字词。"""
    value = str(text or "").strip().lower()
    if not value:
        return set()
    terms = set(_WORD.findall(value))
    cjk = "".join(_CJK.findall(value))
    for index in range(len(cjk) - 1):
        terms.add(cjk[index:index + 2])
    return terms


def _overlap(left: Iterable[str], right: Iterable[str]) -> Tuple[int, List[str]]:
    left_set = {str(item).strip() for item in left if str(item).strip()}
    right_set = {str(item).strip() for item in right if str(item).strip()}
    shared = sorted(left_set & right_set)
    return len(shared), shared


def _cosine_from_distance(distance: Any) -> float:
    try:
        value = 1.0 - float(distance)
    except (TypeError, ValueError):
        return 0.0
    if value != value:  # NaN
        return 0.0
    return max(0.0, min(1.0, value))


def _load_source(db_manager: Any, project_id: str, file_uuid: str) -> Dict[str, Any]:
    """取源文件的标签 / 描述 / 文件名。

    不能走 AudioFileRecord：那个 dataclass 没有 ai_description 字段
    （2026-11-01 实测 AttributeError），这里直接查列。
    """
    with db_manager.get_cursor() as cursor:
        row = cursor.execute(
            "SELECT file_uuid, path, filename, tags, ai_description "
            "FROM files WHERE file_uuid=? AND project_id=?",
            (file_uuid, project_id),
        ).fetchone()
    if not row:
        raise LookupError("文件不存在")
    return {
        "file_uuid": str(row["file_uuid"]),
        "path": str(row["path"] or ""),
        "filename": str(row["filename"] or ""),
        "tags": _parse_tags(row["tags"]),
        "ai_description": str(row["ai_description"] or ""),
    }


def _active_text_collection(db_manager: Any, project_id: str) -> str:
    try:
        manifest = db_manager.get_index_manifest(project_id, "text_vector") or {}
    except Exception:  # pragma: no cover
        manifest = {}
    return str(manifest.get("collection_name") or "text_metadata_embeddings")


def _query_text_neighbours(
    db_manager: Any, project_id: str, file_uuid: str, limit: int
) -> Tuple[List[Dict[str, Any]], bool]:
    """用**已经存好的**文本向量找邻居，不重新编码。

    早先的实现是把「标签+描述」拼成一句再调 CLAP 文本塔 embedding，问题有两个：
    1. 需要父进程重新加载 CLAP 文本塔（音频索引会 release_gpu），单次要 15~25 秒；
    2. 模型没就绪时异常发生在后台线程里，join 超时后静默返回空，界面上就成了
       「同类 0 条」还不给任何提示。

    直接读这条文件已入库的文本向量去查余弦邻居，零模型开销、结果也更一致。
    """
    from core.indexer import safe_project_chroma_path
    from core.searcher import MetadataTextSearcher

    collection_name = _active_text_collection(db_manager, project_id)
    searcher = MetadataTextSearcher(
        persist_directory=str(safe_project_chroma_path(project_id)),
        collection_name=collection_name,
        project_id=project_id,
    )
    collection = searcher.collection
    stored = collection.get(ids=[file_uuid], include=["embeddings"])
    embeddings = (stored or {}).get("embeddings")
    if embeddings is None or len(embeddings) == 0:
        return [], False
    vector = [float(value) for value in embeddings[0]]
    total = int(collection.count())
    if total <= 0:
        return [], False
    raw = collection.query(
        query_embeddings=[vector],
        n_results=max(1, min(int(limit) + 1, total)),
        include=["metadatas", "distances"],
    )
    ids = (raw.get("ids") or [[]])[0]
    distances = (raw.get("distances") or [[]])[0]
    metadatas = (raw.get("metadatas") or [[]])[0]
    items: List[Dict[str, Any]] = []
    for index, candidate_id in enumerate(ids):
        items.append(
            {
                "file_id": str(candidate_id or ""),
                "score": _cosine_from_distance(distances[index]),
                "metadata": dict(metadatas[index] or {}),
            }
        )
    return items, True

def find_similar(
    db_manager: Any,
    project_id: str,
    file_uuid: str,
    *,
    limit: int = DEFAULT_LIMIT,
    audio_threshold: float = DEFAULT_AUDIO_THRESHOLD,
    audio_limit: int = DEFAULT_AUDIO_LIMIT,
) -> Dict[str, Any]:
    """返回 {source, items, counts, audio_ready, warnings}。

    items 顺序即界面顺序：同类段在前、听感段在后。
    """
    from core.index_lifecycle import get_active_audio_indexer
    from core.indexer import build_metadata_text, safe_project_chroma_path

    source = _load_source(db_manager, project_id, file_uuid)
    source_tags = source["tags"]
    source_desc = source["ai_description"]
    source_text = build_metadata_text(
        {
            "filename": source["filename"],
            "tags": source_tags,
            "ai_description": source_desc,
        }
    ) or source_desc or source["filename"]

    limit = max(1, min(int(limit), 500))
    audio_limit = max(1, min(int(audio_limit), 200))
    audio_threshold = max(0.0, min(float(audio_threshold), 1.0))

    warnings: List[str] = []

    # ---- 第一段：标签 / 描述 / 文件名 的「词命中」----
    # 用 IDF 加权：低频/高频/短尾/连续 这类通用听感标签几乎每个文件都有，不该算"同类"；
    # 猪、家养动物、BOAR 这类稀有的词才是真信号。
    same: List[Dict[str, Any]] = []
    seen: set = set()
    try:
        df, total_files, postings = _term_index(db_manager, project_id)
        same = _term_matches(
            db_manager, project_id, source, df, total_files, postings, limit
        )
        seen.update(item["file_uuid"] for item in same)
    except Exception as exc:
        logger.warning("[相似] 同类检索失败: %s", exc)
        warnings.append("同类检索失败，只按音频向量找相似")
    # ---- 第二段：音频向量 ----
    audio_items: List[Dict[str, Any]] = []
    audio_ready = False
    try:
        audio_indexer = get_active_audio_indexer(db_manager, project_id)
        collection = audio_indexer.collection
        stored = collection.get(ids=[file_uuid], include=["embeddings"])
        embeddings = (stored or {}).get("embeddings")
        vector = None
        if embeddings is not None and len(embeddings) > 0:
            vector = [float(value) for value in embeddings[0]]
        if vector and int(collection.count()) > 0:
            audio_ready = True
            raw = collection.query(
                query_embeddings=[vector],
                n_results=max(1, min(audio_limit + len(same) + 1, int(collection.count()))),
                include=["metadatas", "distances"],
            )
            ids = (raw.get("ids") or [[]])[0]
            distances = (raw.get("distances") or [[]])[0]
            metadatas = (raw.get("metadatas") or [[]])[0]
            for index, candidate_id in enumerate(ids):
                candidate_id = str(candidate_id)
                if not candidate_id or candidate_id == file_uuid or candidate_id in seen:
                    continue
                similarity = _cosine_from_distance(distances[index])
                if similarity < audio_threshold:
                    continue
                metadata = dict(metadatas[index] or {})
                audio_items.append(
                    {
                        "file_uuid": candidate_id,
                        "path": str(metadata.get("file_path") or ""),
                        "filename": str(metadata.get("filename") or ""),
                        "duration": float(metadata.get("duration") or 0.0),
                        "tags": _parse_tags(metadata.get("tags")),
                        "ai_description": str(metadata.get("ai_description") or ""),
                        "match": "audio",
                        "score": round(0.50 * similarity, 4),
                        "text_score": None,
                        "tag_overlap": [],
                        "audio_score": round(similarity, 4),
                    }
                )
                seen.add(candidate_id)
        else:
            warnings.append("该文件音频向量未就绪，只按标签/描述找相似")
    except Exception as exc:
        logger.warning("[相似] 音频向量检索失败: %s", exc)
        warnings.append("音频向量检索失败，只按标签/描述找相似")

    audio_items.sort(key=lambda row: row["audio_score"] or 0.0, reverse=True)

    items = same[:limit]
    remaining = limit - len(items)
    if remaining > 0:
        items.extend(audio_items[:remaining])

    return {
        "project_id": project_id,
        "source": source,
        "items": items,
        "counts": {"same": len(same), "audio": len(audio_items)},
        "audio_ready": audio_ready,
        "warnings": warnings,
        "limit": limit,
    }

# ==================== 同类：词命中 + IDF 倒排 ====================

_INDEX_CACHE: Dict[str, Any] = {}
_INDEX_TTL_SECONDS = 600.0
# 太常见的词（低频/高频/短尾/连续…）不进倒排表：既占内存，也不说明"同类"
_COMMON_TOKEN_RATIO = 0.15
# 倒排表里每个词最多挂多少个文件（再多的词本来就没辨识度）
_POSTING_CAP = 3000


def _tokenize(text: str) -> set:
    """词表：中文单字 + 英文/数字词（长度 ≥ 2，纯数字不算）。

    中文用单字而不是 2-gram：「小猪连续叫」和「一头猪在叫」共享的是「猪」，
    2-gram 会把它们拆成完全不相交的碎片。
    """
    value = str(text or "").lower()
    if not value:
        return set()
    tokens = set(_CJK.findall(value))
    tokens.update(
        word for word in _WORD.findall(value)
        if len(word) >= 2 and not word.isdigit()
    )
    return tokens


def _term_index(db_manager: Any, project_id: str) -> Tuple[Dict[str, int], int, Dict[str, List[str]]]:
    """(词 DF, 文件总数, 稀有词倒排表)。10 分钟缓存。

    倒排表让「找相似」变成几次集合取并，而不是每点一次就全表 LIKE 扫 64k 行
    （2026-11-01 实测：LIKE 预筛要 5 秒以上，用户右键等不起）。
    """
    import time

    # 缓存键必须带库路径：测试里多个临时库共用 project_id=default，
    # 只按 project_id 缓存会把上一个库的倒排表喂给下一个库。
    cache_key = (str(getattr(db_manager, "db_path", "") or ""), project_id)
    cached = _INDEX_CACHE.get(cache_key)
    now = time.time()
    if cached and now - cached[0] < _INDEX_TTL_SECONDS:
        return cached[1], cached[2], cached[3]

    total = 0
    df: Dict[str, int] = {}
    postings: Dict[str, List[str]] = {}
    with db_manager.get_cursor() as cursor:
        stream = cursor.execute(
            "SELECT file_uuid, tags, ai_description, filename FROM files WHERE project_id=?",
            (project_id,),
        )
        for row in stream:
            total += 1
            file_uuid = str(row["file_uuid"])
            # 一次拼串再分词：64k 行 × 3 次正则 → 1 次，冷启动从 10s 降到 3s 级
            blob = (
                str(row["tags"] or "") + "\n"
                + str(row["ai_description"] or "") + "\n"
                + str(row["filename"] or "")
            )
            tokens = _tokenize(blob)
            for token in tokens:
                df[token] = df.get(token, 0) + 1
                bucket = postings.get(token)
                if bucket is None:
                    postings[token] = [file_uuid]
                elif len(bucket) < _POSTING_CAP:
                    bucket.append(file_uuid)
    common_ceiling = max(5, int(total * _COMMON_TOKEN_RATIO))
    postings = {
        token: bucket for token, bucket in postings.items()
        if df.get(token, 0) <= common_ceiling
    }
    _INDEX_CACHE[cache_key] = (now, df, total, postings)
    return df, total, postings


def _all_file_rows(db_manager: Any, project_id: str) -> List[Tuple[Any, ...]]:
    with db_manager.get_cursor() as cursor:
        return [
            (
                str(row["file_uuid"]),
                str(row["path"] or ""),
                str(row["filename"] or ""),
                float(row["duration"] or 0.0),
                row["tags"],
                str(row["ai_description"] or ""),
            )
            for row in cursor.execute(
                "SELECT file_uuid, path, filename, duration, tags, ai_description "
                "FROM files WHERE project_id=?",
                (project_id,),
            ).fetchall()
        ]


def _term_matches(
    db_manager: Any,
    project_id: str,
    source: Dict[str, Any],
    df: Dict[str, int],
    total_files: int,
    postings: Dict[str, List[str]],
    limit: int,
) -> List[Dict[str, Any]]:
    """按 IDF 加权的词重合度找同类。"""
    import math

    if total_files <= 0:
        return []
    source_tokens = _tokenize(source["filename"])
    source_tokens |= _tokenize(source["ai_description"])
    source_tokens |= {str(tag) for tag in source["tags"]}
    informative = [token for token in source_tokens if token in postings]
    if not informative:
        return []

    def idf(token: str) -> float:
        return math.log((total_files + 1) / (df.get(token, 0) + 1)) + 1.0

    source_weight = sum(idf(token) for token in informative) or 1.0

    # 倒排表取并：每个候选累加共享词的 IDF
    hits: Dict[str, float] = {}
    matched: Dict[str, List[str]] = {}
    for token in informative:
        weight = idf(token)
        for file_uuid in postings[token]:
            hits[file_uuid] = hits.get(file_uuid, 0.0) + weight
            matched.setdefault(file_uuid, []).append(token)

    if not hits:
        return []
    ranked = sorted(hits.items(), key=lambda item: -item[1])[: max(limit * 3, 120)]
    ranked = [(file_uuid, weight) for file_uuid, weight in ranked if file_uuid != source["file_uuid"]]
    if not ranked:
        return []
    # 相对阈值：与本次最高分比，低于 25% 的丢掉。
    # 绝对阈值在大小库之间会失衡：小库里所有词都「稀有」，单个共同字也能刷出高分。
    top_weight = ranked[0][1] or 1.0
    ranked = [(file_uuid, weight) for file_uuid, weight in ranked if weight >= top_weight * 0.25]
    rows = _rows_by_ids(db_manager, [file_uuid for file_uuid, _weight in ranked])

    source_tag_set = {str(tag) for tag in source["tags"]}
    results: List[Dict[str, Any]] = []
    for file_uuid, weight in ranked:
        if file_uuid == source["file_uuid"]:
            continue
        row = rows.get(file_uuid)
        if row is None:
            continue
        path, filename, duration, tags, description = row
        shared = sorted(matched.get(file_uuid, []), key=lambda token: -idf(token))
        score = weight / source_weight
        tag_hits = [token for token in shared if token in source_tag_set]
        if tag_hits:
            match = "tags"
        elif any(token in _tokenize(description) for token in shared):
            match = "description"
        else:
            match = "name"
        results.append(
            {
                "file_uuid": file_uuid,
                "path": path,
                "filename": filename,
                "duration": duration,
                "tags": _parse_tags(tags),
                "ai_description": description,
                "match": match,
                "score": round(min(1.0, score), 4),
                "text_score": None,
                "tag_overlap": tag_hits[:6],
                "matched_terms": shared[:6],
                "audio_score": None,
            }
        )
    results.sort(key=lambda row: (-row["score"], row["filename"]))
    return results[:limit]

def _rows_by_ids(db_manager: Any, ids: List[str]) -> Dict[str, Tuple[str, str, float, Any, str]]:
    """按 file_uuid 批量取元数据（只取命中的那几百条，不扫全表）。"""
    result: Dict[str, Tuple[str, str, float, Any, str]] = {}
    for start in range(0, len(ids), 400):
        chunk = ids[start:start + 400]
        if not chunk:
            continue
        marks = ",".join("?" for _ in chunk)
        with db_manager.get_cursor() as cursor:
            rows = cursor.execute(
                f"SELECT file_uuid, path, filename, duration, tags, ai_description "
                f"FROM files WHERE file_uuid IN ({marks})",
                tuple(chunk),
            ).fetchall()
        for row in rows:
            result[str(row["file_uuid"])] = (
                str(row["path"] or ""),
                str(row["filename"] or ""),
                float(row["duration"] or 0.0),
                row["tags"],
                str(row["ai_description"] or ""),
            )
    return result

def warm_index(db_manager: Any, project_id: str) -> None:
    """后台预建词表倒排（首次点「找相似」要 3 秒，预热后就只剩几十毫秒）。"""
    try:
        _term_index(db_manager, project_id)
    except Exception as exc:  # pragma: no cover - 预热失败不影响功能
        logger.debug("[相似] 预热失败: %s", exc)
