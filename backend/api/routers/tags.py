# -*- coding: utf-8 -*-
"""标签管理：自动备份、使用统计、重命名/删除/合并。

从 main.py 拆出（AGENTS.md：新接口别继续堆那个文件）。
"""
from __future__ import annotations

import logging

from fastapi import APIRouter, HTTPException, Query, BackgroundTasks

logger = logging.getLogger(__name__)
router = APIRouter(tags=["tags"])
from typing import Any, Dict, List, Optional  # noqa: E402
from fastapi import BackgroundTasks, Query  # noqa: E402

from api.routers import _deps as _d  # noqa: E402


# ---- 主模块里还没搬过来的东西：运行时取，避免循环 import ----
def get_db_manager():
    return _d.call("get_db_manager")


async def _deferred_reconcile(*args: Any, **kwargs: Any):
    return _d.call("_deferred_reconcile", *args, **kwargs)


async def _repair_index_task(*args: Any, **kwargs: Any):
    return _d.call("_repair_index_task", *args, **kwargs)


def _get_project_searcher(*args: Any, **kwargs: Any):
    return _d.call("_get_project_searcher", *args, **kwargs)


def _detect_library_root(*args: Any, **kwargs: Any):
    return _d.call("_detect_library_root", *args, **kwargs)


def _relative_to_root(*args: Any, **kwargs: Any):
    return _d.call("_relative_to_root", *args, **kwargs)


def _get_current_project_id() -> str:
    return str(getattr(_d.attr("config"), "CURRENT_PROJECT_ID", "default"))




@router.get("/api/v1/tags/auto-backup")
async def tag_auto_backup_stats(project_id: str = Query(default="default")):
    """查看自动补全标签的备份情况（支持撤销的依据）。"""
    db_manager = get_db_manager()
    with db_manager.get_cursor() as cursor:
        try:
            row = cursor.execute(
                "SELECT COUNT(*), COUNT(DISTINCT batch), MIN(created_at), MAX(created_at) FROM tag_auto_backup"
            ).fetchone()
        except Exception:
            return {"success": True, "count": 0, "batches": 0}
    return {
        "success": True,
        "count": int(row[0] or 0),
        "batches": int(row[1] or 0),
        "first": row[2],
        "last": row[3],
    }


@router.post("/api/v1/tags/auto-undo")
async def tag_auto_undo(payload: TagAutoUndoRequest, project_id: str = Query(default="default")):
    """撤销自动补全：把 files.tags 还原成补全前的样子。"""
    db_manager = get_db_manager()
    restored = 0
    with db_manager.get_cursor() as cursor:
        try:
            if payload.batch:
                rows = cursor.execute(
                    "SELECT file_uuid, old_tags FROM tag_auto_backup WHERE batch=?", (payload.batch,)
                ).fetchall()
            else:
                rows = cursor.execute("SELECT file_uuid, old_tags FROM tag_auto_backup").fetchall()
        except Exception:
            return {"success": True, "restored": 0}
        for file_uuid, old_tags in rows:
            cursor.execute(
                "UPDATE files SET tags=?, updated_at=? WHERE file_uuid=?",
                (old_tags, datetime.now().isoformat(), file_uuid),
            )
            restored += 1
        if payload.batch:
            cursor.execute("DELETE FROM tag_auto_backup WHERE batch=?", (payload.batch,))
        else:
            cursor.execute("DELETE FROM tag_auto_backup")
        cursor.connection.commit()

    if restored:
        try:
            db_manager.mark_project_artifacts(project_id, ["text_vector"], "stale")
        except Exception:
            pass
    return {"success": True, "restored": restored}


@router.get("/api/v1/tags/usage")
async def get_tag_usage(project_id: str = Query(default="default")):
    """标签 + 使用次数（标签管理面板用）。"""
    db_manager = get_db_manager()
    return {"success": True, "tags": db_manager.list_tag_usage(project_id)}


@router.post("/api/v1/tags/rename")
async def rename_tag(payload: Dict[str, Any], project_id: str = Query(default="default")):
    """按名字改名；新名字已存在则自动合并。"""
    old_name = str(payload.get("old") or "").strip()
    new_name = str(payload.get("new") or "").strip()
    if not old_name or not new_name:
        raise HTTPException(status_code=422, detail="old / new 都不能为空")
    if old_name == new_name:
        return {"success": True, "renamed": 0, "merged": 0, "files": 0}
    db_manager = get_db_manager()
    result = db_manager.rename_tag_by_name(project_id, old_name, new_name)
    try:
        await _get_project_searcher(project_id).clear_cache()
    except Exception:
        pass
    return {"success": True, **result, "old": old_name, "new": new_name}


@router.post("/api/v1/tags/delete")
async def delete_tag_batch(payload: Dict[str, Any], project_id: str = Query(default="default")):
    """删除标签（含文件关联），同步 files.tags。"""
    name = str(payload.get("name") or "").strip()
    if not name:
        raise HTTPException(status_code=422, detail="name 不能为空")
    db_manager = get_db_manager()
    result = db_manager.delete_tag_by_name(project_id, name)
    try:
        await _get_project_searcher(project_id).clear_cache()
    except Exception:
        pass
    return {"success": True, **result, "name": name}


@router.post("/api/v1/tags/merge")
async def merge_tags(payload: Dict[str, Any], project_id: str = Query(default="default")):
    """把多个标签合并到一个（旧的都并进 target）。"""
    target = str(payload.get("target") or "").strip()
    sources = [str(item).strip() for item in (payload.get("sources") or []) if str(item).strip()]
    if not target or not sources:
        raise HTTPException(status_code=422, detail="target / sources 不能为空")
    db_manager = get_db_manager()
    merged = 0
    files = 0
    for name in sources:
        if name == target:
            continue
        result = db_manager.rename_tag_by_name(project_id, name, target)
        merged += result.get("merged", 0) + result.get("renamed", 0)
        files += result.get("files", 0)
    try:
        await _get_project_searcher(project_id).clear_cache()
    except Exception:
        pass
    return {"success": True, "target": target, "merged": merged, "files": files}


@router.get("/api/v1/tags")
async def list_tags(project_id: str = Query(default="default")):
    from core import tag_layers

    db_manager = get_db_manager()
    with db_manager.get_cursor() as cursor:
        tags = tag_layers.list_tags(cursor, project_id)
    return {
        "success": True,
        "scene": [t for t in tags if t["layer"] == "scene"],
        "attr": [t for t in tags if t["layer"] == "attr"],
        "total": len(tags),
    }


@router.post("/api/v1/tags")
async def create_tag(payload: Dict[str, Any], project_id: str = Query(default="default")):
    import uuid as _uuid

    from core import tag_layers

    name = str(payload.get("name") or "").strip()
    layer = str(payload.get("layer") or tag_layers.LAYER_ATTR)
    if not name:
        raise HTTPException(status_code=422, detail="标签名不能为空")
    if layer not in tag_layers.VALID_LAYERS:
        raise HTTPException(status_code=422, detail="layer 只能是 scene 或 attr")
    db_manager = get_db_manager()
    tag_id = "tag_" + _uuid.uuid4().hex[:10]
    with db_manager.get_cursor() as cursor:
        try:
            cursor.execute(
                "INSERT INTO tags (id, project_id, name, layer, sort_order, created_at) "
                "VALUES (?,?,?,?,?,?)",
                (tag_id, project_id, name, layer, 0, datetime.now().isoformat()),
            )
            cursor.connection.commit()
        except Exception as exc:
            raise HTTPException(status_code=409, detail=f"标签已存在: {exc}") from exc
    return {"success": True, "id": tag_id, "name": name, "layer": layer}


@router.patch("/api/v1/tags/{tag_id}")
async def update_tag(
    tag_id: str,
    payload: Dict[str, Any],
    background_tasks: BackgroundTasks,
    project_id: str = Query(default="default"),
):
    from core import tag_layers

    db_manager = get_db_manager()
    affected = db_manager.list_file_uuids_by_tag(project_id, tag_id)
    with db_manager.get_cursor() as cursor:
        ok = True
        named = payload.get("name") is not None
        if named:
            ok = tag_layers.rename_tag(cursor, project_id, tag_id, payload["name"]) and ok
        if payload.get("layer") is not None:
            ok = tag_layers.set_layer(cursor, project_id, tag_id, payload["layer"]) and ok
        cursor.connection.commit()
    if ok and named:
        # 只改「我的标签」，不动音效自带的 6 维标签
        background_tasks.add_task(_deferred_reconcile, project_id, ["text_vector"], "tags")
    return {"success": ok}


@router.delete("/api/v1/tags/{tag_id}")
async def delete_tag(
    tag_id: str,
    background_tasks: BackgroundTasks,
    project_id: str = Query(default="default"),
):
    from core import tag_layers

    db_manager = get_db_manager()
    affected = db_manager.list_file_uuids_by_tag(project_id, tag_id)
    with db_manager.get_cursor() as cursor:
        ok = tag_layers.delete_tag(cursor, project_id, tag_id)
        cursor.connection.commit()
    if ok:
        # 只删「我的标签」，不影响 files.tags
        background_tasks.add_task(_deferred_reconcile, project_id, ["text_vector"], "tags")
    return {"success": ok}
