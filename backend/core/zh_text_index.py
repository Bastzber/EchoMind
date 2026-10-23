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

        try:
            import config as app_config

            persist = app_config.get_chroma_persist_dir() if hasattr(app_config, "get_chroma_persist_dir") else None
        except Exception:
            persist = None
        if persist is None:
            import os
            from pathlib import Path

            persist = Path(os.environ.get("APPDATA", ".")) / "EchoMind" / "chroma_projects" / "default"
        client = chromadb.PersistentClient(path=str(persist)) if persist else chromadb.PersistentClient()
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


def start_async(limit: Optional[int] = None) -> Dict[str, Any]:
    if _state["running"]:
        return status()
    thread = threading.Thread(target=rebuild, kwargs={"limit": limit}, daemon=True)
    thread.start()
    return status()
