# -*- coding: utf-8 -*-
"""P3：中文文本向量索引（BGE）。

独立于 CLAP：写入 Chroma 的 text_zh 集合，供长句语义检索使用。
"""
from __future__ import annotations

import logging
import threading
import time
from typing import Any, Dict, List, Optional

from core import zh_embedder

logger = logging.getLogger(__name__)

COLLECTION = "text_zh"
_state: Dict[str, Any] = {
    "running": False,
    "total": 0,
    "done": 0,
    "failed": 0,
    "started_at": None,
    "finished_at": None,
    "error": None,
    "limit": None,
}
_lock = threading.Lock()


def status() -> Dict[str, Any]:
    with _lock:
        return dict(_state)


_count_cache: Dict[str, Any] = {"value": 0, "at": 0.0}


def collection_count(ttl: float = 30.0) -> int:
    """text_zh 里现在有多少条。缺失时返回 0（不抛异常）。

    打开 Chroma 有几百毫秒开销，状态接口会被频繁轮询，所以带 30 秒缓存。
    """
    now = time.time()
    if now - float(_count_cache.get("at") or 0) < ttl:
        return int(_count_cache.get("value") or 0)
    value = 0
    try:
        from core.indexer import get_chroma_client, safe_project_chroma_path

        client = get_chroma_client(safe_project_chroma_path("default"))
        value = int(client.get_collection(COLLECTION).count())
    except Exception:
        value = 0
    _count_cache["value"] = value
    _count_cache["at"] = now
    return value


def _text_of(row: Dict[str, Any]) -> str:
    parts = [str(row.get("filename") or "")]
    desc = str(row.get("ai_description") or "").strip()
    if desc and not desc.startswith("[auto]"):
        parts.append(desc)
    tags = row.get("tags")
    if tags:
        try:
            import json

            parsed = json.loads(tags) if isinstance(tags, str) else tags
            if isinstance(parsed, list):
                parts.extend(str(t) for t in parsed)
        except Exception:
            pass
    return " ".join(p for p in parts if p).strip()


def rebuild(limit: Optional[int] = None, batch_size: int = 64) -> Dict[str, Any]:
    """重建全部文本向量。返回最终状态。"""
    with _lock:
        if _state["running"]:
            return dict(_state)
        _state.update(
            running=True, total=0, done=0, failed=0,
            started_at=time.time(), finished_at=None, error=None, limit=limit,
        )

    try:
        import chromadb
        from core.database import get_db_manager

        db = get_db_manager()
        rows = db.get_text_index_rows() if hasattr(db, "get_text_index_rows") else None
        if rows is None:
            with db.get_cursor() as cursor:
                rows = [
                    {"file_uuid": r[0], "filename": r[1], "ai_description": r[2], "tags": r[3]}
                    for r in cursor.execute(
                        "SELECT file_uuid, filename, ai_description, tags FROM files "
                        "WHERE project_id='default' ORDER BY file_uuid"
                    ).fetchall()
                ]
        if limit:
            rows = rows[:limit]

        with _lock:
            _state["total"] = len(rows)

        from core.indexer import get_chroma_client, safe_project_chroma_path

        client = get_chroma_client(safe_project_chroma_path("default"))
        try:
            client.delete_collection(COLLECTION)
        except Exception:
            pass
        collection = client.create_collection(COLLECTION, metadata={"hnsw:space": "cosine"})

        texts, ids = [], []
        for row in rows:
            text = _text_of(row)
            if not text:
                continue
            texts.append(text)
            ids.append(str(row.get("file_uuid")))

        for start in range(0, len(texts), batch_size):
            chunk_texts = texts[start:start + batch_size]
            chunk_ids = ids[start:start + batch_size]
            vectors = zh_embedder.encode(chunk_texts)
            if vectors is None:
                raise RuntimeError("BGE 模型不可用")
            collection.add(
                ids=chunk_ids,
                documents=chunk_texts,
                embeddings=[v.tolist() for v in vectors],
            )
            with _lock:
                _state["done"] = min(start + len(chunk_texts), len(texts))
        with _lock:
            _state["finished_at"] = time.time()
    except Exception as exc:
        logger.error("[Embed] 重建失败: %s", exc)
        with _lock:
            _state["error"] = str(exc)
            _state["finished_at"] = time.time()
    finally:
        with _lock:
            _state["running"] = False
        return status()


def search(query: str, limit: int = 60, min_score: float = 0.30) -> List[Dict[str, Any]]:
    """用 BGE 查中文语义；返回 [{file_uuid, score}]，模型/索引缺失返回 []。"""
    if not query or not query.strip():
        return []
    vector = zh_embedder.encode([query])
    if vector is None:
        return []
    try:
        from core.indexer import get_chroma_client, safe_project_chroma_path

        client = get_chroma_client(safe_project_chroma_path("default"))
        collection = client.get_collection(COLLECTION)
        result = collection.query(
            query_embeddings=[vector[0].tolist()], n_results=limit
        )
        ids = (result.get("ids") or [[]])[0]
        distances = (result.get("distances") or [[]])[0]
        hits = []
        for file_uuid, distance in zip(ids, distances):
            score = 1.0 - float(distance)
            if score >= min_score:
                hits.append({"file_uuid": file_uuid, "score": score})
        return hits
    except Exception as exc:
        logging.getLogger("soundmind").warning("[Embed] 文本检索失败: %r", exc)
        return []


def search_rows(query: str, limit: int = 60, min_score: float = 0.30) -> List[Dict[str, Any]]:
    """语义命中后补齐文件信息，供搜索引擎直接构造结果。"""
    hits = search(query, limit=limit, min_score=min_score)
    if not hits:
        return []
    from core.database import get_db_manager

    scores = {h["file_uuid"]: h["score"] for h in hits}
    ordered = [h["file_uuid"] for h in hits]
    db = get_db_manager()
    rows = []
    with db.get_cursor() as cursor:
        for start in range(0, len(ordered), 300):
            chunk = ordered[start:start + 300]
            marks = ",".join("?" * len(chunk))
            fetched = cursor.execute(
                f"SELECT file_uuid, path, filename, duration, file_size, tags, ai_description "
                f"FROM files WHERE project_id='default' AND file_uuid IN ({marks})",
                chunk,
            ).fetchall()
            for r in fetched:
                rows.append({
                    "file_uuid": r[0],
                    "path": r[1],
                    "filename": r[2],
                    "duration": r[3],
                    "size": r[4],
                    "tags": r[5],
                    "ai_description": r[6],
                    "score": scores.get(r[0], 0.0),
                })
    rows.sort(key=lambda item: item["score"], reverse=True)
    return rows


def start_async(limit: Optional[int] = None) -> Dict[str, Any]:
    if _state["running"]:
        return status()
    thread = threading.Thread(target=rebuild, kwargs={"limit": limit}, daemon=True)
    thread.start()
    return status()
