# -*- coding: utf-8 -*-
"""把磁盘上已经存在的向量"接管"回 SQLite 的工件状态，不重新编码。

背景：collection 和 manifest 都还在（state=ready），但 file_artifacts 里大量行
停在 stale / pending。reconcile 看到这些行就会把整库重新编码 —— 6.5 万条一次性
跑会把内存打爆（历史上真的把机器搞崩过）。

正确做法：以 collection 里实际存在的 id 和它自带的 source_fingerprint 为准，
指纹一致的行直接标回 ready；不一致的留给后面的增量重建。
"""
from __future__ import annotations

import logging
from datetime import datetime
from typing import Any, Dict, List, Optional

from core.database import DatabaseManager

logger = logging.getLogger(__name__)


def _collection_batches(indexer: Any, batch_size: int, limit: Optional[int]):
    """按批读 collection 的 id + metadata，不加载向量本身。"""
    total = int(indexer.collection.count())
    if limit:
        total = min(total, int(limit))
    offset = 0
    while offset < total:
        take = min(batch_size, total - offset)
        part = indexer.collection.get(limit=take, offset=offset, include=["metadatas"])
        ids = [str(value) for value in (part.get("ids") or [])]
        metadatas = part.get("metadatas") or []
        batch: Dict[str, Dict[str, Any]] = {}
        for position, file_id in enumerate(ids):
            meta = metadatas[position] if position < len(metadatas) else None
            batch[file_id] = dict(meta or {})
        if not batch:
            break
        yield batch
        offset += len(batch)


def adopt_existing_vectors(
    db_manager: DatabaseManager,
    indexer: Any,
    project_id: str,
    kind: str,
    *,
    batch_size: int = 1000,
    limit: Optional[int] = None,
    dry_run: bool = False,
) -> Dict[str, Any]:
    """把 collection 里已有的向量接管回 file_artifacts（不重新编码）。"""
    if kind not in ("audio_vector", "text_vector"):
        raise ValueError("kind 必须是 audio_vector 或 text_vector")

    manifest = db_manager.get_index_manifest(project_id, kind) or {}
    engine_fingerprint = str(manifest.get("engine_fingerprint") or "")
    manifest_collection = str(manifest.get("collection_name") or "")
    actual_collection = str(getattr(indexer, "collection_name", "") or "")
    if manifest_collection and actual_collection and manifest_collection != actual_collection:
        raise RuntimeError(
            "collection 不匹配：manifest=%s indexer=%s" % (manifest_collection, actual_collection)
        )

    scanned = adopted = kept_stale = missing_row = no_source = would_adopt = 0
    now = datetime.now().isoformat()

    for batch in _collection_batches(indexer, batch_size, limit):
        scanned += len(batch)
        states = db_manager.get_artifact_states(project_id, kind, list(batch.keys()))
        ready_ids: List[str] = []
        for file_id, meta in batch.items():
            row = states.get(file_id)
            if not row:
                missing_row += 1
                continue
            if row.get("state") == "ready":
                continue
            stored_source = row.get("source_fingerprint")
            meta_source = meta.get("source_fingerprint")
            if stored_source and meta_source and stored_source == meta_source:
                ready_ids.append(file_id)
            elif not stored_source and not meta_source:
                ready_ids.append(file_id)
            elif not stored_source:
                no_source += 1
                ready_ids.append(file_id)
            else:
                kept_stale += 1
        if dry_run:
            would_adopt += len(ready_ids)
            continue
        if not ready_ids:
            continue
        for start in range(0, len(ready_ids), 500):
            chunk = ready_ids[start:start + 500]
            db_manager.set_artifacts_ready(
                project_id, kind, chunk,
                engine_fingerprint=engine_fingerprint or None, now=now,
            )
        adopted += len(ready_ids)

    result = {
        "kind": kind,
        "collection": actual_collection or manifest_collection,
        "engine_fingerprint": engine_fingerprint,
        "scanned": scanned,
        "adopted": adopted if not dry_run else would_adopt,
        "kept_stale": kept_stale,
        "missing_artifact_row": missing_row,
        "no_source_fingerprint": no_source,
        "dry_run": dry_run,
    }
    logger.info("[Adopt] %s: %s", kind, result)
    return result