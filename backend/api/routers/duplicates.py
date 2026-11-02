# -*- coding: utf-8 -*-
"""duplicates 域，从 main.py 拆出（AGENTS.md：新接口别继续堆那个文件）。
"""
from __future__ import annotations

import logging
from typing import Any, Dict, List, Optional

import os
import json
import time
import math
import asyncio
from pathlib import Path
from typing import Optional, List, Dict, Any, Mapping, Sequence, Tuple

from fastapi import APIRouter, BackgroundTasks, HTTPException, Path as PathParam, Query
from fastapi.responses import FileResponse, JSONResponse, Response, StreamingResponse
from pydantic import BaseModel, Field
from pydantic import BaseModel, Field

from api.routers import _deps as _d

logger = logging.getLogger(__name__)
router = APIRouter(tags=["duplicates"])


def get_db_manager():
    return _d.call("get_db_manager")


def _folder_tag_name(*a, **k):
    return _d.call("_folder_tag_name", *a, **k)


def _get_project_searcher(*a, **k):
    return _d.call("_get_project_searcher", *a, **k)


def _move_to_recycle_bin(*a, **k):
    return _d.call("_move_to_recycle_bin", *a, **k)


@router.get("/api/v1/duplicates")
async def list_duplicates(project_id: str = Query(default="default"), limit: int = Query(default=20000, le=20000)):
    db_manager = get_db_manager()
    groups = db_manager.duplicate_groups(project_id, limit=limit)
    total_files = sum(g["count"] for g in groups)
    return {
        "success": True,
        "groups": groups,
        "group_count": len(groups),
        "file_count": total_files,
        "wasted_bytes": sum(
            (len(g["files"]) - 1) * int(g["files"][0].get("size") or 0) for g in groups
        ),
    }


@router.post("/api/v1/duplicates/merge-tags")
async def merge_duplicates_into_tags(payload: Dict[str, Any], project_id: str = Query(default="default")):
    """把"副本所在目录名"变成保留文件的标签，然后删掉副本。

    这样一个音效只留一份物理文件，多分类归属靠标签表达，不再占双倍空间。
    """
    import json as _json
    from pathlib import Path as _Path

    keep_path = str(payload.get("keep_path") or "").strip()
    remove_paths = [str(item) for item in (payload.get("paths") or []) if str(item).strip()]
    delete_source = payload.get("delete_source", True) is not False
    extra_tags = [str(t).strip() for t in (payload.get("tags") or []) if str(t).strip()]

    if not keep_path or not remove_paths:
        raise HTTPException(status_code=422, detail="keep_path 和 paths 都不能为空")

    db_manager = get_db_manager()

    derived = []
    for path in remove_paths:
        name = _folder_tag_name(path)
        if name and name not in derived:
            derived.append(name)
    for tag in extra_tags:
        if tag not in derived:
            derived.append(tag)

    merged_tags = []
    with db_manager.get_cursor() as cursor:
        row = cursor.execute(
            "SELECT tags FROM files WHERE project_id=? AND canonical_path=?",
            (project_id, canonicalize_path(keep_path)),
        ).fetchone()
        try:
            merged_tags = [str(t) for t in (_json.loads(row[0]) if row and row[0] else []) if str(t).strip()]
        except Exception:
            merged_tags = []
    for tag in derived:
        if tag not in merged_tags:
            merged_tags.append(tag)

    if merged_tags:
        db_manager.update_tags(keep_path, merged_tags, project_id)

    moved = 0
    removed = 0
    failed = 0
    for path in remove_paths:
        try:
            source = _Path(path)
            if delete_source and source.exists():
                _move_to_recycle_bin(source)
                moved += 1
            if db_manager.delete_file(path, project_id):
                removed += 1
        except Exception as exc:
            failed += 1
            logger.warning("合并标签后删除失败 %s: %s", path, exc)

    try:
        await _get_project_searcher(project_id).clear_cache()
    except Exception:
        pass

    return {
        "success": True,
        "keep_path": keep_path,
        "tags_added": derived,
        "tags_total": merged_tags,
        "moved": moved,
        "removed": removed,
        "failed": failed,
    }


@router.get("/api/v1/duplicates/ignored")
async def list_ignored_duplicates(project_id: str = Query(default="default")):
    """被标记为"有意保留多个分类副本"的组。"""
    db_manager = get_db_manager()
    return {"success": True, "groups": db_manager.list_ignored_duplicate_groups(project_id)}


@router.post("/api/v1/duplicates/ignore")
async def ignore_duplicate(payload: Dict[str, Any], project_id: str = Query(default="default")):
    """忽略一组重复：同一个音效本来就要归到多个分类时用。"""
    sha = str(payload.get("sha256") or "").strip()
    if not sha:
        raise HTTPException(status_code=422, detail="sha256 不能为空")
    note = str(payload.get("note") or "").strip()[:200]
    db_manager = get_db_manager()
    db_manager.ignore_duplicate_group(project_id, sha, note)
    return {"success": True, "sha256": sha}


@router.delete("/api/v1/duplicates/ignore/{sha256}")
async def unignore_duplicate(sha256: str, project_id: str = Query(default="default")):
    db_manager = get_db_manager()
    removed = db_manager.unignore_duplicate_group(project_id, sha256)
    return {"success": True, "removed": removed}
