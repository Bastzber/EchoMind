# -*- coding: utf-8 -*-
"""files 域，从 main.py 拆出（AGENTS.md：新接口别继续堆那个文件）。
"""
from __future__ import annotations

import os
import json
import time
import math
import asyncio
import logging
from pathlib import Path
from typing import Optional, List, Dict, Any, Mapping, Sequence, Tuple

from fastapi import APIRouter, BackgroundTasks, HTTPException, Path as PathParam, Query
from fastapi.responses import FileResponse, JSONResponse, Response, StreamingResponse
from pydantic import BaseModel, Field

from api.routers import _deps as _d

logger = logging.getLogger(__name__)
router = APIRouter(tags=["files"])


def get_db_manager():
    return _d.call("get_db_manager")


def _cfg():
    return _d.attr("config")


async def _deferred_reconcile(*a, **k):
    return await _d.call("_deferred_reconcile", *a, **k)


async def _run_audio_work(*a, **k):
    return await _d.call("_run_audio_work", *a, **k)


async def _waveform_payload(*a, **k):
    return await _d.call("_waveform_payload", *a, **k)


class FileCopyRequest(BaseModel):
    source: str
    destination: str
    overwrite: bool = False


class FileMetaRequest(BaseModel):
    ids: List[str]


@router.post("/api/v1/files/rename")
async def batch_rename(
    payload: Dict[str, Any],
    background_tasks: BackgroundTasks,
    project_id: str = Query(default="default"),
):
    """批量重命名：先 dry_run 预览，确认后再动磁盘。"""
    import os as _os

    items = payload.get("items") or []
    dry_run = bool(payload.get("dry_run", True))
    if not isinstance(items, list) or not items:
        raise HTTPException(status_code=422, detail="items 不能为空")

    db_manager = get_db_manager()
    results = []
    seen_targets = set()

    for item in items:
        file_uuid = str(item.get("file_uuid") or "").strip()
        new_name = str(item.get("new_name") or "").strip()
        entry = {"file_uuid": file_uuid, "new_name": new_name, "ok": False, "message": ""}

        if not file_uuid or not new_name:
            entry["message"] = "参数缺失"
            results.append(entry)
            continue
        if any(ch in new_name for ch in '\\/:*?"<>|'):
            entry["message"] = "文件名包含非法字符"
            results.append(entry)
            continue

        with db_manager.get_cursor() as cursor:
            row = cursor.execute(
                "SELECT path, filename FROM files WHERE project_id=? AND file_uuid=?",
                (project_id, file_uuid),
            ).fetchone()
        if not row:
            entry["message"] = "文件不存在"
            results.append(entry)
            continue

        old_path = row[0]
        folder = _os.path.dirname(old_path)
        old_name = row[1] or _os.path.basename(old_path)
        ext = _os.path.splitext(old_name)[1]
        if not _os.path.splitext(new_name)[1]:
            new_name = new_name + ext
        new_path = _os.path.join(folder, new_name)
        entry["old_path"] = old_path
        entry["new_path"] = new_path

        if _os.path.normcase(new_path) in seen_targets:
            entry["message"] = "目标文件名重复"
            results.append(entry)
            continue
        seen_targets.add(_os.path.normcase(new_path))

        if _os.path.exists(new_path) and _os.path.normcase(new_path) != _os.path.normcase(old_path):
            entry["message"] = "目标文件已存在"
            results.append(entry)
            continue

        if dry_run:
            entry["ok"] = True
            entry["message"] = "可重命名"
            results.append(entry)
            continue

        try:
            _os.rename(old_path, new_path)
        except Exception as exc:
            entry["message"] = "磁盘重命名失败: " + str(exc)
            results.append(entry)
            continue

        try:
            with db_manager.get_cursor() as cursor:
                cursor.execute(
                    "UPDATE files SET path=?, filename=? WHERE project_id=? AND file_uuid=?",
                    (new_path, new_name, project_id, file_uuid),
                )
                cursor.connection.commit()
            db_manager.update_fts_row(file_uuid, project_id)
            # 文件名是文本向量的输入之一，改名后这条要重算
            db_manager.mark_artifacts_stale_for_file(project_id, file_uuid, ["text_vector"])
            entry["ok"] = True
            entry["message"] = "已重命名"
        except Exception as exc:
            entry["message"] = "数据库更新失败（文件已改名）: " + str(exc)
        results.append(entry)

    reindex_queued = False
    if not dry_run and any(r["ok"] for r in results):
        background_tasks.add_task(_deferred_reconcile, project_id, ["text_vector"], "rename")
        reindex_queued = True

    return {
        "success": all(r["ok"] for r in results),
        "dry_run": dry_run,
        "total": len(results),
        "done": sum(1 for r in results if r["ok"]),
        "results": results,
        "reindex_queued": reindex_queued,
    }


@router.post("/api/v1/files/{file_uuid}/favorite")
async def set_favorite(file_uuid: str, payload: Dict[str, Any], project_id: str = Query(default="default")):
    db_manager = get_db_manager()
    value = bool(payload.get("favorite", True))
    ok = db_manager.set_favorite(project_id, file_uuid, value)
    return {"success": ok, "favorite": value}


@router.post("/api/v1/files/meta")
async def files_meta_endpoint(payload: FileMetaRequest):
    """按 id 批量取描述和标签：搜索结果只有文件名和分数，界面要补这两项。"""
    import json as _json

    ids = [str(item) for item in (payload.ids or []) if item][:500]
    if not ids:
        return {"success": True, "items": []}
    db_manager = get_db_manager()
    placeholders = ",".join("?" for _ in ids)
    with db_manager.get_cursor() as cursor:
        rows = cursor.execute(
            f"SELECT file_uuid, filename, ai_description, tags FROM files WHERE file_uuid IN ({placeholders})",
            tuple(ids),
        ).fetchall()
    items = []
    for row in rows:
        raw_tags = row["tags"]
        try:
            tags = _json.loads(raw_tags) if isinstance(raw_tags, str) else (raw_tags or [])
        except Exception:
            tags = [part for part in str(raw_tags or "").split(",") if part.strip()]
        description = str(row["ai_description"] or "")
        if description.startswith("[auto]"):
            description = description[len("[auto]"):].strip()
        items.append({
            "id": row["file_uuid"],
            "filename": row["filename"],
            "ai_description": description,
            "tags": [str(tag) for tag in (tags or []) if str(tag).strip()],
        })
    return {"success": True, "items": items}


@router.post("/api/v1/files/copy")
async def files_copy_endpoint(payload: FileCopyRequest):
    """把生成的语音等文件另存到用户指定位置。"""
    import shutil

    src = Path(payload.source)
    dest = Path(payload.destination)
    if not src.is_file():
        raise HTTPException(status_code=404, detail="源文件不存在")
    if not dest.parent.is_dir():
        raise HTTPException(status_code=400, detail="目标文件夹不存在")
    if dest.exists() and not payload.overwrite:
        raise HTTPException(status_code=409, detail="目标文件已存在")
    try:
        if dest.resolve() != src.resolve():
            shutil.copy2(str(src), str(dest))
    except Exception as exc:
        raise SoundBotAPIError("copy_failed", f"保存失败：{exc}", status_code=500)
    return {"success": True, "path": str(dest), "size": dest.stat().st_size}


@router.post("/api/v1/files/{file_uuid}/description")
async def set_file_description(
    file_uuid: str,
    payload: Dict[str, Any],
    background_tasks: BackgroundTasks,
    project_id: str = Query(default="default"),
):
    """单条改「一句话描述」：写库 + 同步 FTS，并把这条的文本向量标脏。"""
    description = str(payload.get("description") or "").strip()[:500]
    db_manager = get_db_manager()
    record = db_manager.get_file_by_uuid(file_uuid, project_id)
    if not record:
        raise HTTPException(status_code=404, detail="文件不存在")
    path = getattr(record, "path", None) or getattr(record, "file_path", None)
    if not path:
        raise HTTPException(status_code=500, detail="文件路径缺失")
    if not db_manager.update_ai_description(path, description, project_id, file_uuid=file_uuid):
        raise HTTPException(status_code=500, detail="写入描述失败")
    # 描述变了，这一行的 text_vector 已经被标脏。关键词搜索（FTS）当场就更新了，
    # 但语义检索用的是向量，得让增量对账把这一条重新算一遍 —— 只跑 stale 的行，
    # 不是全库重建。同一工程并发触发会自动合并成一个任务。
    background_tasks.add_task(_deferred_reconcile, project_id, ["text_vector"], "description")
    return {"success": True, "description": description, "reindex_queued": True}


@router.get("/api/v1/files/{file_uuid}/user-tags")
async def get_file_user_tags(file_uuid: str, project_id: str = Query(default="default")):
    """读取某个文件的「我的标签」（用户自定义，和 6 维系统标签分开）。"""
    from core import tag_layers

    db_manager = get_db_manager()
    with db_manager.get_cursor() as cursor:
        names = tag_layers.file_tag_names(cursor, project_id, file_uuid)
    return {"success": True, "names": names}


@router.post("/api/v1/files/{file_uuid}/tags")
async def set_file_tags(
    file_uuid: str,
    payload: Dict[str, Any],
    background_tasks: BackgroundTasks,
    project_id: str = Query(default="default"),
):
    from core import tag_layers

    tag_ids = payload.get("tag_ids") or []
    names = payload.get("names")
    if not isinstance(tag_ids, list):
        raise HTTPException(status_code=422, detail="tag_ids 必须是数组")
    db_manager = get_db_manager()
    with db_manager.get_cursor() as cursor:
        # 允许前端直接传名字：不存在的标签自动建（attr 层）
        if isinstance(names, list):
            resolved = []
            for raw in names:
                name = str(raw or "").strip()
                if not name:
                    continue
                row = cursor.execute(
                    "SELECT id FROM tags WHERE project_id=? AND name=?", (project_id, name)
                ).fetchone()
                if row:
                    resolved.append(str(row[0]))
                else:
                    tag_id = uuid.uuid4().hex
                    cursor.execute(
                        "INSERT INTO tags (id, project_id, name, layer, created_at) VALUES (?,?,?,?,?)",
                        (tag_id, project_id, name, "attr", datetime.now().isoformat()),
                    )
                    resolved.append(tag_id)
            tag_ids = resolved
        try:
            tag_layers.set_file_tags(cursor, project_id, file_uuid, [str(t) for t in tag_ids])
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

    # 改完用户标签：刷新这一行的 FTS（关键词搜索能命中），并把文本向量标脏
    try:
        db_manager.update_fts_row(project_id, file_uuid)
    except Exception as exc:
        logger.debug("刷新 FTS 失败: %s", exc)
    try:
        with db_manager.get_cursor() as cursor:
            cursor.execute(
                "UPDATE file_artifacts SET state='stale' WHERE kind='text_vector' AND file_uuid=?",
                (file_uuid,),
            )
    except Exception:
        pass
    background_tasks.add_task(_deferred_reconcile, project_id, ["text_vector"], "user_tags")
    return {"success": True, "reindex_queued": True}


@router.get("/api/v1/files/{file_id}/waveform")
async def get_file_waveform(file_id: str, project_id: Optional[str] = None):
    effective_project = project_id or getattr(config, 'CURRENT_PROJECT_ID', 'default')
    record = get_db_manager().get_file_by_uuid(file_id, effective_project)
    if not record:
        raise SoundBotAPIError("file_not_found", "文件不存在", status_code=404)
    return await _waveform_payload(record.path, effective_project)


@router.get("/api/v1/files/{file_id}/playback-source")
async def get_playback_source(file_id: str, project_id: Optional[str] = None):
    """Return an original path or a cached PCM WAV for Chromium-incompatible files."""
    from core.audio_service import get_audio_service, AudioServiceError

    effective_project = project_id or getattr(config, 'CURRENT_PROJECT_ID', 'default')
    record = get_db_manager().get_file_by_uuid(file_id, effective_project)
    if not record:
        raise SoundBotAPIError("file_not_found", "文件不存在", status_code=404)
    service = get_audio_service()
    try:
        if service.requires_playback_transcode(record.path):
            source = await _run_audio_work(service.prepare_playback_wav, record.path)
            mode = "transcoded_wav"
        else:
            source = Path(record.path)
            mode = "original"
        return {
            "file_id": file_id,
            "path": str(source),
            "mode": mode,
            "source_fingerprint": (
                await _run_audio_work(service.fingerprint, record.path)
            ).source_key,
        }
    except AudioServiceError as exc:
        raise SoundBotAPIError(
            exc.code,
            exc.message,
            status_code=422,
            retryable=exc.retryable,
            details=exc.details,
        )
