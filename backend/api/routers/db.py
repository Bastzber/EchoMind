# -*- coding: utf-8 -*-
"""db 域，从 main.py 拆出（AGENTS.md：新接口别继续堆那个文件）。
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

from fastapi import APIRouter, BackgroundTasks, Body, HTTPException, Path as PathParam, Query
from fastapi.responses import FileResponse, JSONResponse, Response, StreamingResponse
from pydantic import BaseModel, Field

from core.errors import SoundBotAPIError
from core.database import canonicalize_path, is_safe_project_id
from models import schemas

import tempfile
import sys
import uuid
from datetime import datetime
import config

from core.database import AudioFileRecord

from api.routers import _deps as _d

async def _clear_searcher_cache(project_id: str) -> None:
    """后台清搜索缓存：6.5 万条词表重建约 10 秒，不能卡在保存请求里。"""
    try:
        await _get_project_searcher(project_id).clear_cache()
    except Exception as exc:
        logger.debug("清理搜索缓存失败: %s", exc)


logger = logging.getLogger(__name__)


def get_ws_manager():
    return _d.call("get_ws_manager")


def _projects_deleting():
    return _d.attr("_projects_deleting")
router = APIRouter(tags=["db"])


def get_db_manager():
    return _d.call("get_db_manager")


def _cfg():
    return _d.attr("config")


def _assert_safe_delete_target(*a, **k):
    return _d.call("_assert_safe_delete_target", *a, **k)


def _cleanup_vectors_after_delete(*a, **k):
    return _d.call("_cleanup_vectors_after_delete", *a, **k)


def _duplicate_backup_root(*a, **k):
    return _d.call("_duplicate_backup_root", *a, **k)


def _get_active_audio_indexer(*a, **k):
    return _d.call("_get_active_audio_indexer", *a, **k)


def _get_active_text_indexer(*a, **k):
    return _d.call("_get_active_text_indexer", *a, **k)


def _get_project_index_lock(*a, **k):
    """同步函数：返回 asyncio.Lock（不是协程），调用方用 async with。"""
    return _d.call("_get_project_index_lock", *a, **k)


def _get_project_searcher(*a, **k):
    return _d.call("_get_project_searcher", *a, **k)


def _move_to_recycle_bin(*a, **k):
    return _d.call("_move_to_recycle_bin", *a, **k)


def _regenerate_file_description(*a, **k):
    return _d.call("_regenerate_file_description", *a, **k)


async def _repair_index_task(*a, **k):
    return await _d.call("_repair_index_task", *a, **k)


def _run_hash_backfill(*a, **k):
    return _d.call("_run_hash_backfill", *a, **k)


def _run_model_work(*a, **k):
    return _d.call("_run_model_work", *a, **k)


async def _start_index_job(*a, **k):
    return await _d.call("_start_index_job", *a, **k)


def _write_backup_manifest(*a, **k):
    return _d.call("_write_backup_manifest", *a, **k)


def delete_db_file(*a, **k):
    return _d.call("delete_db_file", *a, **k)


def folder_stats(*a, **k):
    return _d.call("folder_stats", *a, **k)


class ReviewMoveRequest(BaseModel):
    file_uuid: str
    target_dir: str


class BatchDeleteRequest(BaseModel):
    paths: List[str]
    delete_source: bool = False


class RetryFolderRequest(BaseModel):
    path_prefix: str
    kinds: List[str] = ["audio_vector", "text_vector"]
    start_job: bool = True


_rescan_state = {"running": False, "scanned": 0, "added": 0, "roots": [], "error": ""}


async def _run_library_rescan(project_id: str, roots: List[str]) -> None:
    """扫描库目录，把磁盘上有、库里没有的音频补录进来（回收站还原、手动拷贝）。"""
    import asyncio as _asyncio
    from pathlib import Path as _Path

    global _rescan_state
    _rescan_state = {"running": True, "scanned": 0, "added": 0, "roots": roots, "error": ""}
    try:
        audio_exts = {'.wav', '.mp3', '.aac', '.m4a', '.wma', '.ogg', '.aiff', '.aif', '.flac', '.opus', '.ape', '.caf'}
        db_manager = get_db_manager()
        known = set()
        with db_manager.get_cursor() as cursor:
            for (path,) in cursor.execute("SELECT path FROM files WHERE project_id=?", (project_id,)):
                if path:
                    known.add(canonicalize_path(str(path)))
        # 用户主动移除过的文件不再自动补录：否则「一键清理损坏文件」之后
        # 一重读目录又全冒出来，用户会以为是软件出了问题。
        excluded = {
            canonicalize_path(str(item))
            for item in db_manager.list_excluded_paths(project_id)
        }
        skipped = 0

        added = 0
        scanned = 0
        for root_dir in roots:
            base = _Path(root_dir)
            if not base.is_dir():
                continue
            for entry in base.rglob("*"):
                if not entry.is_file() or entry.suffix.lower() not in audio_exts:
                    continue
                scanned += 1
                _rescan_state["scanned"] = scanned
                try:
                    normalized = canonicalize_path(str(entry))
                    if normalized in known:
                        continue
                    if normalized in excluded:
                        skipped += 1
                        continue
                    stat = entry.stat()
                    record = AudioFileRecord(
                        path=str(entry),
                        filename=entry.name,
                        file_size=stat.st_size,
                    )
                    if db_manager.upsert_file(record, project_id):
                        added += 1
                        _rescan_state["added"] = added
                except Exception as exc:
                    logger.debug("补录失败 %s: %s", entry, exc)
                if scanned % 500 == 0:
                    await _asyncio.sleep(0.05)
        _rescan_state["skipped"] = skipped
        logger.info(
            "[Rescan] 扫描 %d 个音频，补录 %d 个，跳过 %d 个已移除文件",
            scanned, added, skipped,
        )
        if added:
            await _run_hash_backfill(project_id)
    except Exception as exc:
        logger.error("[Rescan] 失败: %s", exc)
        _rescan_state["error"] = str(exc)
    finally:
        _rescan_state["running"] = False


async def _broken_cleanup_task(job_id: str, project_id: str, entries: List[Dict[str, Any]]) -> None:
    """批量清理损坏文件（仅移除软件库记录，磁盘原文件不动）。

    两条关键改动：
    1. 按 file_uuid 批量删记录：原来按路径删，路径规范形式不一致（斜杠方向）会全部匹配失败；
    2. 不再逐个删 Chroma 向量：每个文件都要打开一次集合（实测 9.8s + 14.6s），200 个就是一小时。
       向量留着只是孤儿，不影响搜索（搜索按 DB 命中），需要时用重建流程统一回收。
    """
    db_manager = get_db_manager()
    ws_manager = get_ws_manager()
    db_manager.update_job(job_id, state="running", stage="rechecking")
    removed = 0
    failed = 0
    healed = 0
    try:
        # 先重探一遍：读得出来的文件不删，退回 pending 重新索引（F1/F2）
        from core import broken_files as _broken_files

        kept_uuids = set()
        for entry in entries:
            probe = await asyncio.to_thread(
                _broken_files.heal, db_manager, project_id, entry.get("path") or ""
            )
            if probe.get("ok"):
                kept_uuids.add(entry.get("file_uuid"))
                healed += 1
        if kept_uuids:
            entries = [e for e in entries if e.get("file_uuid") not in kept_uuids]
            logger.info("[Broken] 重探后保留 %d 个其实可读的文件（已退回 pending）", healed)
        db_manager.update_job(job_id, stage=f"removing healed={healed}")

        uuids = [str(entry.get("file_uuid") or "") for entry in entries]
        uuids = [u for u in uuids if u]
        job = db_manager.get_job(job_id)
        if (job and job["cancel_requested"]) or ws_manager.is_task_cancelled(job_id):
            db_manager.update_job(job_id, state="cancelled", stage="cancelled", processed=0)
            return
        for offset in range(0, len(uuids), 400):
            chunk = uuids[offset:offset + 400]
            removed += db_manager.delete_files_by_uuids(project_id, chunk)
            db_manager.update_job(job_id, processed=min(offset + len(chunk), len(uuids)))
        failed = max(0, len(uuids) - removed)
        logger.info("[Broken] 清理完成：删除记录 %d 条，未匹配 %d 条", removed, failed)
        db_manager.update_job(
            job_id,
            state="completed",
            stage=f"done removed={removed} failed={failed} healed={healed}",
            processed=len(uuids),
        )
    except Exception as exc:
        logger.error("损坏文件清理任务异常: %s", exc)
        db_manager.update_job(
            job_id, state="failed", stage=f"error removed={removed} failed={failed}"
        )
    try:
        asyncio.create_task(_clear_searcher_cache(project_id))
    except Exception as exc:
        logger.debug(f"清理搜索缓存失败: {exc}")
    except Exception as exc:
        logger.debug(f"清理搜索缓存失败: {exc}")


@router.get("/api/v1/db/files")
async def get_all_db_files(
    limit: int = Query(default=200, ge=1, le=500),
    cursor: Optional[int] = Query(default=None, ge=1),
):
    """
    从 SQLite 获取当前工程的所有文件列表（启动时加载）

    返回格式：
    {
        "total": 1000,
        "files": [
            {
                "path": "/path/to/file.wav",
                "filename": "file.wav",
                "duration": 12.5,
                "sample_rate": 48000,
                "channels": 2,
                "size": 1234567,
                "peaks": [0.1, 0.2, ...],  # 波形峰值数组
                "tags": ["标签1", "标签2"],
                "created_at": "2024-01-01T00:00:00"
            }
        ]
    }
    """
    try:
        db_manager = get_db_manager()
        current_project_id = getattr(config, 'CURRENT_PROJECT_ID', 'default')
        items, next_cursor = db_manager.get_files_cursor_page(
            current_project_id, limit=limit, before_id=cursor
        )
        for item in items:
            item["size"] = item.pop("file_size")
            # Compatibility marker: absence is null, never an empty truthy array.
            item["peaks"] = None
        return {
            "project_id": current_project_id,
            "total": db_manager.get_file_count(current_project_id),
            "files": items,
            "next_cursor": next_cursor,
        }
    except Exception as e:
        logger.error(f"获取文件列表失败: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/api/v1/db/file/{path:path}")
async def get_db_file(path: str):
    """
    获取单个文件详情

    - **path**: URL 编码的文件路径
    """
    file_path = path

    db_manager = get_db_manager()
    current_project_id = getattr(config, 'CURRENT_PROJECT_ID', 'default')
    record = db_manager.get_file(file_path, current_project_id)

    if not record:
        raise HTTPException(status_code=404, detail="文件不存在")

    return {
        "id": record.file_uuid,
        "path": record.path,
        "filename": record.filename,
        "duration": record.duration,
        "sample_rate": record.sample_rate,
        "channels": record.channels,
        "size": record.file_size,
        "peaks": record.get_peaks(),
        "tags": record.get_tags(),
        "created_at": record.created_at
    }


@router.put("/api/v1/db/file/{path:path}/tags")
async def update_file_tags(
    path: str,
    background_tasks: BackgroundTasks,
    payload: Any = Body(...),
):
    """更新文件标签。

    入参三种形态都收：
      ["环境", "紧张"]                      ← 只改系统标签（老前端）
      {"tags": [...], "custom": [...]}      ← 系统标签 + 我的标签，一次搞定
      {"tags": [...]}                        ← 只改系统标签

    为什么把「我的标签」也放这里：前端拿不到 file_uuid 时（列表里只有 path），
    原来会静默跳过自定义标签的写入 —— 提示保存成功、库里其实什么都没写
    （11-02 用户实测：输入「氛围音乐」，tags 表里查不到）。
    """
    from core import tag_layers

    file_path = path
    custom_tags: List[str] = []
    if isinstance(payload, dict):
        tags = payload.get("tags") or []
        raw_custom = payload.get("custom") or []
        if isinstance(raw_custom, list):
            custom_tags = [str(t).strip() for t in raw_custom if str(t).strip()]
    elif isinstance(payload, list):
        tags = payload
    else:
        tags = getattr(payload, "tags", []) or []

    db_manager = get_db_manager()
    current_project_id = getattr(config, 'CURRENT_PROJECT_ID', 'default')
    if current_project_id in _projects_deleting():
        raise SoundBotAPIError("project_deleting", "工程正在删除", status_code=409)
    async with _get_project_index_lock(current_project_id):
        success = db_manager.update_tags(file_path, tags, current_project_id)

        if not success:
            raise HTTPException(status_code=404, detail="文件不存在")

        # 我的标签：按路径反查 file_uuid，写 tags + file_tags 两层。
        custom_written = 0
        if custom_tags:
            record = db_manager.get_file(file_path, current_project_id)
            file_uuid = getattr(record, "file_uuid", None) if record else None
            if file_uuid:
                with db_manager.get_cursor() as cursor:
                    resolved: List[str] = []
                    for tag_name in custom_tags:
                        row = cursor.execute(
                            "SELECT id FROM tags WHERE project_id=? AND name=?",
                            (current_project_id, tag_name),
                        ).fetchone()
                        if row:
                            resolved.append(str(row[0]))
                        else:
                            new_id = uuid.uuid4().hex
                            cursor.execute(
                                "INSERT INTO tags (id, project_id, name, layer, created_at) "
                                "VALUES (?,?,?,?,?)",
                                (new_id, current_project_id, tag_name, "attr",
                                 datetime.now().isoformat()),
                            )
                            resolved.append(new_id)
                    try:
                        tag_layers.set_file_tags(
                            cursor, current_project_id, str(file_uuid), resolved
                        )
                        custom_written = len(resolved)
                    except Exception as exc:
                        logger.warning("[标签] 写入我的标签失败: %s", exc)
        try:
            asyncio.create_task(_clear_searcher_cache(current_project_id))
        except Exception as exc:
            logger.debug(f"清理搜索缓存失败: {exc}")
        job_id = db_manager.create_job(current_project_id, "text_metadata_refresh", 1)
        background_tasks.add_task(
            _repair_index_task,
            job_id,
            current_project_id,
            ["text_vector"],
            "reconcile",
        )
    return {
        "success": True,
        "message": "标签已更新",
        "job_id": job_id,
        "custom_written": custom_written,
    }


@router.get("/api/v1/db/tags")
async def list_tags():
    """列出工程内所有标签及使用次数（标签管理面板用）。"""
    db_manager = get_db_manager()
    current_project_id = getattr(config, 'CURRENT_PROJECT_ID', 'default')
    tags = db_manager.list_all_tags(current_project_id)
    return {"success": True, "tags": tags, "total": len(tags)}


@router.put("/api/v1/db/tags/batch")
async def batch_set_tags(
    payload: schemas.BatchTagsRequest,
    background_tasks: BackgroundTasks,
):
    """批量设置标签：同一组标签应用到多个文件路径。"""
    db_manager = get_db_manager()
    current_project_id = getattr(config, 'CURRENT_PROJECT_ID', 'default')
    if current_project_id in _projects_deleting():
        raise SoundBotAPIError("project_deleting", "工程正在删除", status_code=409)
    tags = [str(t).strip() for t in payload.tags if str(t).strip()]
    async with _get_project_index_lock(current_project_id):
        applied = 0
        for path in payload.paths:
            if db_manager.update_tags(path, tags, current_project_id):
                applied += 1
        try:
            asyncio.create_task(_clear_searcher_cache(current_project_id))
        except Exception as exc:
            logger.debug(f"清理搜索缓存失败: {exc}")
        job_id = db_manager.create_job(current_project_id, "text_metadata_refresh", 1)
        background_tasks.add_task(
            _repair_index_task,
            job_id,
            current_project_id,
            ["text_vector"],
            "reconcile",
        )
    return {"success": True, "message": f"已更新 {applied} 个文件标签", "applied": applied, "job_id": job_id}


@router.patch("/api/v1/db/tags")
async def rename_tag(
    payload: schemas.RenameTagRequest,
    background_tasks: BackgroundTasks,
):
    """全局重命名标签。"""
    db_manager = get_db_manager()
    current_project_id = getattr(config, 'CURRENT_PROJECT_ID', 'default')
    if current_project_id in _projects_deleting():
        raise SoundBotAPIError("project_deleting", "工程正在删除", status_code=409)
    async with _get_project_index_lock(current_project_id):
        affected_uuids = []
        try:
            with db_manager.get_cursor() as cursor:
                affected_uuids = [
                    row[0] for row in cursor.execute(
                        "SELECT file_uuid FROM files WHERE project_id=? AND tags LIKE ?",
                        (current_project_id, f'%"{payload.old}"%'),
                    ).fetchall()
                ]
        except Exception as exc:
            logger.debug(f"收集改名受影响的文件失败: {exc}")
        changed = db_manager.rename_tag(current_project_id, payload.old, payload.new)
        try:
            asyncio.create_task(_clear_searcher_cache(current_project_id))
        except Exception as exc:
            logger.debug(f"清理搜索缓存失败: {exc}")
        if changed > 0:
            job_id = db_manager.create_job(current_project_id, "text_metadata_refresh", 1)
            background_tasks.add_task(
                _repair_index_task,
                job_id,
                current_project_id,
                ["text_vector"],
                "reconcile",
            )
    return {"success": True, "message": f"已重命名标签，影响 {changed} 个文件", "changed": changed}


@router.delete("/api/v1/db/tags/{tag}")
async def delete_tag(tag: str, background_tasks: BackgroundTasks):
    """全局删除标签（从所有文件移除）。"""
    db_manager = get_db_manager()
    current_project_id = getattr(config, 'CURRENT_PROJECT_ID', 'default')
    if current_project_id in _projects_deleting():
        raise SoundBotAPIError("project_deleting", "工程正在删除", status_code=409)
    async with _get_project_index_lock(current_project_id):
        affected_uuids = []
        try:
            with db_manager.get_cursor() as cursor:
                affected_uuids = [
                    row[0] for row in cursor.execute(
                        "SELECT file_uuid FROM files WHERE project_id=? AND tags LIKE ?",
                        (current_project_id, f'%"{tag}"%'),
                    ).fetchall()
                ]
        except Exception as exc:
            logger.debug(f"收集删标签受影响的文件失败: {exc}")
        changed = db_manager.delete_tag(current_project_id, tag)
        try:
            asyncio.create_task(_clear_searcher_cache(current_project_id))
        except Exception as exc:
            logger.debug(f"清理搜索缓存失败: {exc}")
        if changed > 0:
            for file_uuid in affected_uuids:
                db_manager.sync_layers_from_files_tags(current_project_id, file_uuid=file_uuid)
            job_id = db_manager.create_job(current_project_id, "text_metadata_refresh", 1)
            background_tasks.add_task(
                _repair_index_task,
                job_id,
                current_project_id,
                ["text_vector"],
                "reconcile",
            )
    return {"success": True, "message": f"已删除标签，影响 {changed} 个文件", "changed": changed}


@router.post("/api/v1/db/file/{path:path}/rename")
async def rename_db_file(
    path: str,
    payload: schemas.RenameFileRequest,
    background_tasks: BackgroundTasks,
):
    """重命名文件记录（磁盘文件重命名由 Electron 主进程完成，此处同步数据库）。"""
    db_manager = get_db_manager()
    current_project_id = getattr(config, 'CURRENT_PROJECT_ID', 'default')
    if current_project_id in _projects_deleting():
        raise SoundBotAPIError("project_deleting", "工程正在删除", status_code=409)
    async with _get_project_index_lock(current_project_id):
        success = db_manager.rename_file(path, payload.new_name, current_project_id)
        if not success:
            raise HTTPException(status_code=404, detail="文件不存在")
        try:
            asyncio.create_task(_clear_searcher_cache(current_project_id))
        except Exception as exc:
            logger.debug(f"清理搜索缓存失败: {exc}")
        job_id = db_manager.create_job(current_project_id, "text_metadata_refresh", 1)
        background_tasks.add_task(
            _repair_index_task,
            job_id,
            current_project_id,
            ["text_vector"],
            "reconcile",
        )
    return {"success": True, "message": "文件已重命名", "job_id": job_id}


@router.post("/api/v1/db/file/{path:path}/reanalyze")
async def reanalyze_db_file(
    path: str,
    background_tasks: BackgroundTasks,
    scope: str = Query(default="all"),
):
    """重新分析单个素材。

    scope:
      all         重建波形 + 音频向量 + 文本向量（旧行为，默认）
      audio       只重建波形 + 音频向量（CLAP），不动描述/标签
      description 只重生成一句话描述，再重算这一个文件的文本向量
      tags        只重生成标签（当前没有独立入口，返回明确提示）
    """
    scope = (scope or "all").strip().lower()
    if scope not in {"all", "audio", "description", "tags"}:
        raise HTTPException(status_code=422, detail="scope 只能是 all / audio / description / tags")
    db_manager = get_db_manager()
    current_project_id = getattr(config, 'CURRENT_PROJECT_ID', 'default')
    if current_project_id in _projects_deleting():
        raise SoundBotAPIError("project_deleting", "工程正在删除", status_code=409)
    async with _get_project_index_lock(current_project_id):
        record = db_manager.get_file(path, current_project_id)
        if not record:
            raise HTTPException(status_code=404, detail="文件不存在")
        now = datetime.now().isoformat()

        if scope == "description":
            ok = await _regenerate_file_description(current_project_id, record)
            if not ok:
                raise SoundBotAPIError(
                    "description_failed",
                    "描述生成失败：请检查设置里的 LLM 配置",
                    status_code=503,
                )
            db_manager.mark_artifacts_stale_for_file(
                current_project_id, record.file_uuid, ["text_vector"], now
            )
            try:
                asyncio.create_task(_clear_searcher_cache(current_project_id))
            except Exception as exc:
                logger.debug(f"清理搜索缓存失败: {exc}")
            job_id = db_manager.create_job(current_project_id, "index_reconcile", 1)
            background_tasks.add_task(
                _repair_index_task, job_id, current_project_id, ["text_vector"], "reconcile",
            )
            return {"success": True, "scope": "description", "job_id": job_id,
                    "message": "已重生成描述，正在重算文本向量"}

        if scope == "tags":
            raise SoundBotAPIError(
                "tags_scope_unsupported",
                "标签还没有独立的重生成入口（会随「全部重新分析」一起刷新）",
                status_code=501,
            )

        kinds = ["waveform", "audio_vector"] if scope == "audio" else ["waveform", "audio_vector", "text_vector"]
        db_manager.mark_artifacts_stale_for_file(
            current_project_id, record.file_uuid, kinds, now
        )
        try:
            asyncio.create_task(_clear_searcher_cache(current_project_id))
        except Exception as exc:
            logger.debug(f"清理搜索缓存失败: {exc}")
        job_id = db_manager.create_job(current_project_id, "index_reconcile", 1)
        background_tasks.add_task(
            _repair_index_task,
            job_id,
            current_project_id,
            kinds,
            "reconcile",
        )
    return {"success": True, "scope": scope, "message": "已提交重新分析", "job_id": job_id}


@router.post("/api/v1/db/duplicates/resolve")
async def resolve_duplicates(payload: Dict[str, Any], project_id: str = Query(default="default")):
    """处理重复文件的"多余副本"。

    - backup：**复制**到备份目录（原文件与库记录都保留），并写一份可撤回的清单
    - records：只删库内记录，磁盘文件保留（重新导入即恢复）
    - source：源文件移入回收站并删记录（回收站可还原）

    判定重复用 sha256（字节级一致），所以留哪一份都不会丢内容。
    """
    import shutil
    from pathlib import Path

    paths = [str(item) for item in (payload.get("paths") or []) if str(item).strip()]
    action = str(payload.get("action") or "records").strip()
    target_dir = str(payload.get("target_dir") or "").strip()

    if not paths:
        raise HTTPException(status_code=422, detail="paths 不能为空")
    if action not in ("records", "source", "backup"):
        raise HTTPException(status_code=422, detail="action 只能是 records / source / backup")
    if action == "backup":
        if not target_dir:
            target_dir = str(_duplicate_backup_root() / "files")
        try:
            Path(target_dir).mkdir(parents=True, exist_ok=True)
        except Exception as exc:
            raise HTTPException(status_code=400, detail=f"无法创建备份目录: {exc}")

    db_manager = get_db_manager()
    moved = 0
    removed = 0
    failed = 0
    entries = []
    errors: List[str] = []

    for raw_path in paths:
        try:
            source = Path(raw_path)
            if action == "backup":
                if not source.exists():
                    errors.append(f"{raw_path}: 源文件不存在")
                    continue
                destination = Path(target_dir) / source.name
                index = 1
                while destination.exists():
                    destination = Path(target_dir) / f"{source.stem} ({index}){source.suffix}"
                    index += 1
                shutil.copy2(str(source), str(destination))
                entries.append({"original": raw_path, "backup": str(destination)})
                moved += 1
                continue

            if action == "source" and source.exists():
                _move_to_recycle_bin(source)
                moved += 1
            if db_manager.delete_file(raw_path, project_id):
                removed += 1
        except Exception as exc:
            failed += 1
            errors.append(f"{raw_path}: {exc}")
            logger.warning("处理重复文件失败 %s: %s", raw_path, exc)

    manifest_path = ""
    if action == "backup" and entries:
        manifest_path = str(_write_backup_manifest(entries, action, target_dir))

    try:
        asyncio.create_task(_clear_searcher_cache(project_id))
    except Exception as exc:
        logger.debug("清理搜索缓存失败: %s", exc)

    return {
        "success": True,
        "action": action,
        "requested": len(paths),
        "moved": moved,
        "removed": removed,
        "failed": failed,
        "errors": errors[:10],
        "target_dir": target_dir or None,
        "manifest": manifest_path,
    }


@router.post("/api/v1/db/folder/precheck")
async def precheck_folder_import(payload: Dict[str, Any], project_id: str = Query(default="default")):
    """导入前的重复预检：这个目录里有多少文件已经以"同名同大小"存在于库里。

    只看文件名 + 字节数，不读内容，所以很快；用来提醒"这个包可能已经导入过"。
    """
    from pathlib import Path

    folder = str(payload.get("path") or "").strip()
    if not folder:
        raise HTTPException(status_code=422, detail="path 不能为空")
    root = Path(folder)
    if not root.is_dir():
        raise HTTPException(status_code=404, detail="目录不存在")

    audio_exts = {'.wav', '.mp3', '.aac', '.m4a', '.wma', '.ogg', '.aiff', '.aif', '.flac', '.opus', '.ape', '.caf'}
    files = []
    try:
        for entry in root.rglob("*"):
            if not entry.is_file():
                continue
            if entry.suffix.lower() not in audio_exts:
                continue
            try:
                files.append((entry.name.lower(), entry.stat().st_size, str(entry)))
            except OSError:
                continue
            if len(files) >= 20000:
                break
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"读取目录失败: {exc}")

    if not files:
        return {"success": True, "total": 0, "existing": 0, "ratio": 0.0, "samples": [], "already_imported": False}

    db_manager = get_db_manager()
    names = sorted({name for name, _size, _path in files})
    existing_pairs = set()
    with db_manager.get_cursor() as cursor:
        for start in range(0, len(names), 400):
            chunk = names[start:start + 400]
            marks = ",".join("?" * len(chunk))
            rows = cursor.execute(
                f"SELECT LOWER(filename), COALESCE(file_size,0) FROM files "
                f"WHERE project_id=? AND LOWER(filename) IN ({marks})",
                (project_id, *chunk),
            ).fetchall()
            existing_pairs.update((str(row[0]), int(row[1] or 0)) for row in rows)

    matched = [path for name, size, path in files if (name, size) in existing_pairs]
    ratio = len(matched) / len(files)
    return {
        "success": True,
        "total": len(files),
        "existing": len(matched),
        "ratio": round(ratio, 3),
        "already_imported": ratio >= 0.9,
        "samples": matched[:5],
    }


@router.get("/api/v1/db/library/rescan")
async def rescan_status():
    return {"success": True, **_rescan_state}


@router.post("/api/v1/db/library/rescan")
async def start_library_rescan(payload: Dict[str, Any] = None, background_tasks: BackgroundTasks = None,
                               project_id: str = Query(default="default")):
    """扫描库目录，找回"磁盘上有、库里没有"的文件（比如从回收站还原的）。

    传 dry_run=true 只统计不写入。
    """
    from pathlib import Path as _Path

    payload = payload or {}
    dry_run = bool(payload.get("dry_run"))
    roots = [str(item) for item in (payload.get("roots") or []) if str(item).strip()]
    db_manager = get_db_manager()
    if not roots:
        roots = db_manager.list_library_roots(project_id)
    roots = [item for item in roots if _Path(item).is_dir()]
    if not roots:
        raise HTTPException(status_code=404, detail="没有可扫描的库目录")

    if dry_run:
        audio_exts = {'.wav', '.mp3', '.aac', '.m4a', '.wma', '.ogg', '.aiff', '.aif', '.flac', '.opus', '.ape', '.caf'}
        known = set()
        with db_manager.get_cursor() as cursor:
            for (path,) in cursor.execute("SELECT path FROM files WHERE project_id=?", (project_id,)):
                if path:
                    known.add(canonicalize_path(str(path)))
        missing_count = 0
        samples: List[str] = []
        scanned = 0
        for root_dir in roots:
            base = _Path(root_dir)
            if not base.is_dir():
                continue
            for entry in base.rglob("*"):
                if entry.is_file() and entry.suffix.lower() in audio_exts:
                    scanned += 1
                    if canonicalize_path(str(entry)) not in known:
                        missing_count += 1
                        if len(samples) < 20:
                            samples.append(str(entry))
        return {
            "success": True,
            "dry_run": True,
            "roots": roots,
            "scanned": scanned,
            "missing": missing_count,
            "missing_sample": samples,
        }

    if _rescan_state.get("running"):
        return {"success": True, "already_running": True}
    background_tasks.add_task(_run_library_rescan, project_id, roots)
    return {"success": True, "started": True, "roots": roots}


@router.get("/api/v1/db/review/targets")
async def review_targets(limit: int = Query(default=400, ge=1, le=1000), project_id: str = Query(default="default")):
    """归类目标目录候选：库里已有文件所在的目录（按文件数排序）。"""
    db_manager = get_db_manager()
    with db_manager.get_cursor() as cursor:
        rows = cursor.execute(
            "SELECT path FROM files WHERE project_id=?", (project_id,)
        ).fetchall()
    counts: dict = {}
    for (path,) in rows:
        parent = str(Path(path).parent)
        counts[parent] = counts.get(parent, 0) + 1
    items = [
        {"path": p, "count": n}
        for p, n in sorted(counts.items(), key=lambda kv: -kv[1])
        if "_转码" not in p and "_分轨" not in p and "_待删" not in p
    ][:limit]
    return {"success": True, "total": len(items), "items": items}


@router.get("/api/v1/db/review/unclassified")
async def review_unclassified(
    limit: int = Query(default=50, ge=1, le=200),
    offset: int = Query(default=0, ge=0),
    keyword: str = Query(default=""),
    project_id: str = Query(default="default"),
):
    """待归类文件列表（_待归类 / 待人工判断 目录下的文件）。"""
    db_manager = get_db_manager()
    where = "project_id=? AND (path LIKE '%_待归类%' OR path LIKE '%待人工判断%')"
    params: list = [project_id]
    if keyword.strip():
        where += " AND (filename LIKE ? OR COALESCE(ai_description,'') LIKE ?)"
        like = f"%{keyword.strip()}%"
        params += [like, like]
    with db_manager.get_cursor() as cursor:
        total = cursor.execute(f"SELECT COUNT(*) FROM files WHERE {where}", params).fetchone()[0]
        rows = cursor.execute(
            f"SELECT file_uuid, path, filename, COALESCE(duration,0), COALESCE(tags,'[]'), "
            f"COALESCE(ai_description,'') FROM files WHERE {where} ORDER BY path LIMIT ? OFFSET ?",
            (*params, limit, offset),
        ).fetchall()
    return {
        "success": True,
        "total": total,
        "items": [
            {
                "file_uuid": r[0], "path": r[1], "filename": r[2],
                "duration": float(r[3] or 0), "tags": r[4], "description": r[5],
            }
            for r in rows
        ],
    }


@router.post("/api/v1/db/review/move")
async def review_move_file(payload: ReviewMoveRequest):
    """把待归类文件移动到目标目录，并同步库内路径（file_uuid 不变，索引保留）。"""
    import shutil

    from core.database import canonicalize_path

    db_manager = get_db_manager()
    project_id = getattr(config, "CURRENT_PROJECT_ID", "default")
    with db_manager.get_cursor() as cursor:
        row = cursor.execute(
            "SELECT path, filename FROM files WHERE project_id=? AND file_uuid=?",
            (project_id, payload.file_uuid),
        ).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="文件记录不存在")
    source = Path(row[0])
    if not source.is_file():
        raise HTTPException(status_code=404, detail="源文件不存在")
    target_dir = Path(payload.target_dir)
    if not target_dir.is_dir():
        raise HTTPException(status_code=400, detail="目标目录不存在")
    target = target_dir / source.name
    if target.exists() and target.resolve() != source.resolve():
        raise HTTPException(status_code=409, detail="目标目录已有同名文件")
    try:
        if target.resolve() != source.resolve():
            shutil.move(str(source), str(target))
        with db_manager.get_cursor() as cursor:
            cursor.execute(
                "UPDATE files SET path=?, canonical_path=? WHERE project_id=? AND file_uuid=?",
                (str(target), canonicalize_path(str(target)), project_id, payload.file_uuid),
            )
    except Exception as exc:
        logger.warning("[归类] 移动失败 %s -> %s: %s", source, target, exc)
        raise SoundBotAPIError("move_failed", f"移动失败：{exc}", status_code=500)
    return {"success": True, "path": str(target), "filename": target.name}


@router.post("/api/v1/db/files/delete")
async def batch_delete_db_files(payload: BatchDeleteRequest):
    """批量删除文件记录。

    设计要点：
    - **记录立即删**（几十毫秒级），界面不会卡在"正在删除"；
    - 向量清理放后台任务（fire-and-forget），失败只记日志，不影响删除结果；
    - 源文件删除由 Electron 主进程送回收站，这里不碰磁盘。
    """
    if not payload.paths:
        raise HTTPException(status_code=422, detail="paths 不能为空")
    project_id = getattr(config, "CURRENT_PROJECT_ID", "default")
    if project_id in _projects_deleting():
        raise SoundBotAPIError("project_deleting", "工程正在删除", status_code=409)

    db_manager = get_db_manager()
    removed = 0
    failed = 0
    cleanup: list = []
    for raw_path in payload.paths:
        record = db_manager.get_file(str(raw_path), project_id)
        if not record:
            failed += 1
            continue
        try:
            with db_manager.get_cursor() as cursor:
                cursor.execute(
                    "DELETE FROM files WHERE project_id=? AND file_uuid=?",
                    (project_id, record.file_uuid),
                )
            removed += 1
            cleanup.append((record.path, record.file_uuid))
        except Exception as exc:
            logger.warning("[批量删除] 删除记录失败 %s: %s", record.path, exc)
            failed += 1

    if cleanup:
        asyncio.create_task(_cleanup_vectors_after_delete(project_id, cleanup))

    return {"success": True, "removed": removed, "failed": failed, "total": len(payload.paths)}


@router.get("/api/v1/db/library/folder-health")
async def library_folder_health(project_id: str = Query(default="default"), limit: int = 200):
    """检测库里的目录是否还存在于磁盘（改名/移动会导致不一致）。"""
    from core.library_health import folder_health

    db_manager = get_db_manager()
    with db_manager.get_cursor() as cursor:
        rows = cursor.execute(
            "SELECT path FROM files WHERE project_id=?", (project_id,)
        ).fetchall()
    paths = [row[0] for row in rows] if rows else []
    result = await asyncio.to_thread(folder_health, paths, limit)
    return {"success": True, **result}


@router.post("/api/v1/db/index/retry-folder")
async def retry_folder_index(payload: RetryFolderRequest, background_tasks: BackgroundTasks):
    """把某个文件夹下失败的产物重置为 pending，并立刻起一轮修复索引。

    用于「先按文件夹分批重试」：一次只跑一个目录，出问题的文件立刻能定位。
    """
    project_id = getattr(config, "CURRENT_PROJECT_ID", "default")
    prefix = str(payload.path_prefix or "").strip()
    if not prefix:
        raise HTTPException(status_code=422, detail="path_prefix 不能为空")

    db_manager = get_db_manager()
    kinds = [k for k in (payload.kinds or []) if k in ("audio_vector", "text_vector")]
    if not kinds:
        kinds = ["audio_vector", "text_vector"]

    with db_manager.get_cursor() as cursor:
        reset = cursor.execute(
            "UPDATE file_artifacts SET state='pending', error_code=NULL, error_message=NULL "
            "WHERE project_id=? AND kind IN (%s) AND state IN ('failed','stale') "
            "AND file_uuid IN (SELECT file_uuid FROM files WHERE project_id=? AND path LIKE ?)"
            % ",".join("?" * len(kinds)),
            (project_id, *kinds, project_id, prefix + "%"),
        ).rowcount

    job = None
    if reset and payload.start_job:
        job = await _start_index_job(project_id, kinds, "reconcile", background_tasks)
    return {"success": True, "reset": reset, "job": job, "kinds": kinds}


@router.post("/api/v1/db/library/repair-paths")
async def repair_library_paths(payload: Dict[str, Any] = Body(default={}), project_id: str = Query(default="default")):
    """磁盘上文件夹改名/移动后，把数据库里的旧路径按"同名同大小"修正回来。

    dry_run=True 只返回计划，不动数据库。
    """
    from core.database import canonicalize_path

    dry_run = bool(payload.get("dry_run", True))
    roots = payload.get("roots") or []
    db_manager = get_db_manager()

    with db_manager.get_cursor() as cursor:
        rows = cursor.execute(
            "SELECT file_uuid, path, filename, file_size FROM files WHERE project_id=?",
            (project_id,),
        ).fetchall()

    missing = []
    by_name_size = {}
    for file_uuid, path, filename, size in rows:
        if os.path.exists(path):
            by_name_size.setdefault((str(filename), int(size or 0)), []).append(path)
        else:
            missing.append((file_uuid, path, filename, size))

    # 磁盘扫描：在指定根目录（或旧路径的盘符根）下找同名同大小的文件
    search_roots = [str(item) for item in roots if item]
    if not search_roots:
        seen = set()
        for _uuid, path, _fn, _size in missing:
            drive = os.path.splitdrive(path)[0]
            if drive and drive not in seen:
                seen.add(drive)
                search_roots.append(drive + os.sep)

    disk_index = {}
    scanned = 0
    for search_root in search_roots:
        if not os.path.isdir(search_root):
            continue
        for dirpath, _dirnames, filenames in os.walk(search_root):
            for name in filenames:
                full = os.path.join(dirpath, name)
                try:
                    disk_index.setdefault((name, os.path.getsize(full)), []).append(full)
                except OSError:
                    continue
                scanned += 1
                if scanned % 20000 == 0:
                    logger.info("路径修复扫描中: %d", scanned)

    plan = []
    ambiguous = 0
    not_found = 0
    for file_uuid, path, filename, size in missing:
        candidates = disk_index.get((str(filename), int(size or 0)), [])
        if not candidates:
            not_found += 1
            continue
        if len(candidates) > 1:
            # 优先同盘
            same_drive = [c for c in candidates if os.path.splitdrive(c)[0] == os.path.splitdrive(path)[0]]
            candidates = same_drive or candidates
        if len(candidates) > 1:
            ambiguous += 1
            continue
        plan.append({"file_uuid": file_uuid, "old": path, "new": candidates[0]})

    if dry_run:
        return {
            "success": True,
            "dry_run": True,
            "missing": len(missing),
            "scanned": scanned,
            "fixable": len(plan),
            "ambiguous": ambiguous,
            "not_found": not_found,
            "samples": plan[:20],
        }

    updated = 0
    with db_manager.get_cursor() as cursor:
        for item in plan:
            cursor.execute(
                "UPDATE files SET path=?, canonical_path=?, updated_at=? WHERE file_uuid=?",
                (item["new"], canonicalize_path(item["new"]), datetime.now().isoformat(), item["file_uuid"]),
            )
            updated += cursor.rowcount
    return {
        "success": True,
        "dry_run": False,
        "missing": len(missing),
        "fixable": len(plan),
        "updated": updated,
        "ambiguous": ambiguous,
        "not_found": not_found,
    }


@router.get("/api/v1/db/duplicates/backups")
async def list_duplicate_backups(limit: int = Query(default=20, le=100)):
    """列出可撤回的备份清单（新的在前）。"""
    import json as _json

    root = _duplicate_backup_root() / "manifests"
    if not root.is_dir():
        return {"success": True, "manifests": []}
    manifests = []
    for item in sorted(root.glob("*.json"), key=lambda p: p.stat().st_mtime, reverse=True)[:limit]:
        try:
            data = _json.loads(item.read_text(encoding="utf-8"))
            manifests.append({
                "path": str(item),
                "created_at": data.get("created_at", ""),
                "action": data.get("action", ""),
                "target_dir": data.get("target_dir", ""),
                "count": len(data.get("entries") or []),
            })
        except Exception as exc:
            logger.debug("读取备份清单失败 %s: %s", item, exc)
    return {"success": True, "manifests": manifests}


@router.post("/api/v1/db/duplicates/restore")
async def restore_duplicate_backup(payload: Dict[str, Any], project_id: str = Query(default="default")):
    """按备份清单把副本还原回**原来的目录**（仅还原缺失的文件，不覆盖已有文件）。"""
    import json as _json
    import shutil
    from pathlib import Path

    manifest = str(payload.get("manifest") or "").strip()
    if not manifest:
        latest = sorted((_duplicate_backup_root() / "manifests").glob("*.json"),
                        key=lambda p: p.stat().st_mtime, reverse=True) if (_duplicate_backup_root() / "manifests").is_dir() else []
        if not latest:
            raise HTTPException(status_code=404, detail="没有可撤回的备份")
        manifest = str(latest[0])

    path = Path(manifest)
    if not path.is_file():
        raise HTTPException(status_code=404, detail="备份清单不存在")

    try:
        data = _json.loads(path.read_text(encoding="utf-8"))
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"备份清单损坏: {exc}")

    restored = 0
    skipped = 0
    failed = 0
    errors: List[str] = []
    for entry in data.get("entries") or []:
        original = Path(str(entry.get("original") or ""))
        backup = Path(str(entry.get("backup") or ""))
        try:
            if not backup.exists():
                skipped += 1
                continue
            if original.exists():
                skipped += 1
                continue
            original.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(str(backup), str(original))
            restored += 1
        except Exception as exc:
            failed += 1
            errors.append(f"{original}: {exc}")
            logger.warning("还原失败 %s: %s", original, exc)

    return {
        "success": True,
        "manifest": str(path),
        "restored": restored,
        "skipped": skipped,
        "failed": failed,
        "errors": errors[:10],
        "note": "文件已还原；库记录需要重新导入对应目录才会回来",
    }


@router.get("/api/v1/db/folder/stats")
async def folder_stats(path: str = Query(...), project_id: str = Query(default="default")):
    """目录统计：文件数 / 有描述数 / 有标签数 / 总大小。"""
    db_manager = get_db_manager()
    stats = db_manager.folder_stats(project_id, path)
    stats["path"] = path
    return {"success": True, **stats}


@router.post("/api/v1/db/folder/delete")
async def delete_folder_records(payload: Dict[str, Any], project_id: str = Query(default="default")):
    """删除目录下的文件记录。

    默认只删库内记录（描述、标签、索引一起删），保留磁盘源文件；
    delete_source=true 时同时删除磁盘文件（不可恢复，前端需二次确认）。
    """
    import shutil

    folder = str(payload.get("path") or "").strip()
    delete_source = bool(payload.get("delete_source"))
    if not folder:
        raise HTTPException(status_code=422, detail="path 不能为空")

    db_manager = get_db_manager()
    stats = db_manager.folder_stats(project_id, folder)
    removed = 0
    deleted_files = 0
    failed: List[str] = []

    if delete_source:
        target = _assert_safe_delete_target(folder, stats)
        try:
            _move_to_recycle_bin(target)
            deleted_files = stats.get("files", 0)
        except Exception as exc:
            logger.error("删除目录源文件失败 %s: %s", folder, exc)
            raise HTTPException(status_code=500, detail=f"删除源文件失败: {exc}")

    records = db_manager.delete_files_in_folder(project_id, folder)
    removed = len(records)
    # 顺带清掉「我的文件夹」里指向这个目录的映射，否则左侧还会挂着一个空目录
    mappings_removed = db_manager.remove_mappings_under(project_id, folder)
    try:
        asyncio.create_task(_clear_searcher_cache(project_id))
    except Exception as exc:
        logger.debug("清理搜索缓存失败: %s", exc)

    return {
        "success": True,
        "removed": removed,
        "deleted_source": delete_source,
        "deleted_files": deleted_files,
        "failed": failed,
        "mappings_removed": mappings_removed,
        "stats": stats,
    }


@router.delete("/api/v1/db/file/{path:path}")
async def delete_db_file(path: str):
    """
    从数据库删除文件记录

    - **path**: URL 编码的文件路径
    """
    file_path = path

    db_manager = get_db_manager()
    current_project_id = getattr(config, 'CURRENT_PROJECT_ID', 'default')
    if current_project_id in _projects_deleting():
        raise SoundBotAPIError("project_deleting", "工程正在删除", status_code=409)
    async with _get_project_index_lock(current_project_id):
        record = db_manager.get_file(file_path, current_project_id)
        if not record:
            raise HTTPException(status_code=404, detail="文件不存在")
        # 记住这个路径：以后「重读目录」不要再把它当新文件补录回来
        try:
            db_manager.add_excluded_paths(current_project_id, [file_path], reason="removed")
        except Exception as exc:
            logger.debug("[Delete] 记录排除路径失败: %s", exc)
        try:
            await _run_model_work(
                _get_active_audio_indexer(current_project_id).remove_audio,
                file_path,
                record.file_uuid,
            )
            await _run_model_work(
                _get_active_text_indexer(current_project_id).remove,
                file_id=record.file_uuid,
            )
        except Exception as exc:
            db_manager.set_artifact_state(
                current_project_id,
                record.file_uuid,
                "audio_vector",
                "stale",
                error_code="delete_sync_failed",
                error_message=str(exc),
            )
            db_manager.set_artifact_state(
                current_project_id,
                record.file_uuid,
                "text_vector",
                "stale",
                error_code="delete_sync_failed",
                error_message=str(exc),
            )
            raise SoundBotAPIError(
                "delete_sync_failed",
                "向量删除未完成，文件记录已保留，可重试",
                status_code=503,
                retryable=True,
            ) from exc

        success = db_manager.delete_file(file_path, current_project_id)
        if not success:
            for kind in ("audio_vector", "text_vector"):
                db_manager.set_artifact_state(
                    current_project_id,
                    record.file_uuid,
                    kind,
                    "stale",
                    error_code="delete_metadata_failed",
                    error_message="SQLite delete returned false after vector removal",
                )
            raise SoundBotAPIError(
                "delete_metadata_failed",
                "元数据删除失败；已删除的向量会由修复任务恢复",
                status_code=503,
                retryable=True,
            )

        for kind in ("audio_vector", "text_vector"):
            db_manager.upsert_index_manifest(
                current_project_id, kind, revision_increment=1
            )
        try:
            asyncio.create_task(_clear_searcher_cache(current_project_id))
        except Exception as exc:
            logger.debug(f"清理搜索缓存失败: {exc}")
    return {"success": True, "message": "文件已删除"}


@router.get("/api/v1/db/folder-stats")
async def get_folder_stats(project_id: str = Query(default="default")):
    """返回库内所有目录及其直接文件数，供左侧文件夹树构建。

    前端只拿到分页加载的文件，用它们反推目录树会得到不完整、不稳定的结果
    （实测只显示出 7/8/9 三个子目录）。这里直接返回全库聚合。
    """
    try:
        db_manager = get_db_manager()
        folders = db_manager.get_folder_counts(project_id)
        return {
            "success": True,
            "folders": [{"path": path, "count": count} for path, count in folders],
        }
    except Exception as exc:
        logger.error("获取文件夹统计失败: %s", exc)
        raise HTTPException(status_code=500, detail=str(exc))


@router.get("/api/v1/db/excluded")
async def list_excluded(project_id: str = Query(default="default")):
    """列出「已从库里移除、重读目录不会再补录」的文件。"""
    db_manager = get_db_manager()
    paths = db_manager.list_excluded_paths(project_id)
    return {"success": True, "count": len(paths), "paths": paths}


@router.delete("/api/v1/db/excluded")
async def clear_excluded(project_id: str = Query(default="default")):
    """清空排除列表：之后重读目录又会把这些文件补录回来。"""
    db_manager = get_db_manager()
    removed = db_manager.clear_excluded_paths(project_id)
    return {"success": True, "cleared": removed}


@router.get("/api/v1/db/broken-files")
async def list_broken_files():
    """列出所有损坏/无法索引的文件（仅从软件库移除，保留磁盘原文件）。"""
    db_manager = get_db_manager()
    current_project_id = getattr(config, "CURRENT_PROJECT_ID", "default")
    broken = db_manager.get_broken_files(current_project_id)
    return {
        "success": True,
        "count": len(broken),
        "files": broken,
        "note": "清理仅从软件库移除记录，保留磁盘上的原始文件",
    }


@router.delete("/api/v1/db/broken/{path:path}")
async def delete_broken_file(path: str, delete_source: bool = Query(default=False)):
    """清理单个损坏文件。

    - 默认只从软件库移除记录（保留磁盘原文件）
    - delete_source=true 时连磁盘上的文件一起删（给 0 字节/彻底损坏的文件用）
    """
    if not delete_source:
        return await delete_db_file(path)

    # 删源文件前先重探一次：能读出来的文件一律不删（F1 的兜底，
    # 面板可能是旧状态，别让误判把有效音频送进回收站）
    from core import broken_files as _broken_files

    _project = getattr(config, "CURRENT_PROJECT_ID", "default")
    _probe = await asyncio.to_thread(_broken_files.heal, get_db_manager(), _project, path)
    if _probe.get("ok"):
        raise HTTPException(
            status_code=409,
            detail=("这个文件其实能读出来（%.1f 秒），已重新排队索引，没有删除" % float(_probe.get("duration") or 0.0)),
        )

    source = Path(path)
    removed_source = False
    if source.is_file():
        # 优先丢回收站（用户还能找回），失败再直接删
        try:
            if os.name == "nt":
                import ctypes

                class _SHFILEOPSTRUCTW(ctypes.Structure):
                    _fields_ = [
                        ("hwnd", ctypes.c_void_p),
                        ("wFunc", ctypes.c_uint),
                        ("pFrom", ctypes.c_wchar_p),
                        ("pTo", ctypes.c_wchar_p),
                        ("fFlags", ctypes.c_ushort),
                        ("fAnyOperationsAborted", ctypes.c_bool),
                        ("hNameMappings", ctypes.c_void_p),
                        ("lpszProgressTitle", ctypes.c_wchar_p),
                    ]

                op = _SHFILEOPSTRUCTW(
                    None, 3, str(source) + "\0\0", None, 0x0040 | 0x0010, False, None, None
                )
                if ctypes.windll.shell32.SHFileOperationW(ctypes.byref(op)) == 0:
                    removed_source = True
            else:
                source.unlink()
                removed_source = True
        except Exception as exc:
            logger.warning("[Broken] 回收站失败，直接删除: %s", exc)
            try:
                source.unlink()
                removed_source = True
            except Exception as exc2:
                logger.error("[Broken] 删除源文件失败: %s", exc2)
    result = await delete_db_file(path)
    result["source_deleted"] = removed_source
    return result


@router.post("/api/v1/db/broken/recheck")
async def recheck_broken_file(path: str = Query(..., description="文件完整路径")):
    """重新探测一个「损坏文件」：读得出来就退回 pending 等索引，什么都不删。"""
    from core import broken_files as _broken_files

    project_id = getattr(config, "CURRENT_PROJECT_ID", "default")
    result = await asyncio.to_thread(
        _broken_files.heal, get_db_manager(), project_id, path
    )
    return {"success": bool(result.get("ok")), **result}


@router.post("/api/v1/db/broken/cleanup")
async def cleanup_broken_files(background_tasks: BackgroundTasks):
    """一键清理全部损坏文件：仅从软件库移除记录，保留磁盘原文件。

    后台任务执行（几万文件时也能稳定跑），返回 job_id 供轮询进度。
    """
    db_manager = get_db_manager()
    current_project_id = getattr(config, "CURRENT_PROJECT_ID", "default")
    broken = db_manager.get_broken_files(current_project_id)
    if not broken:
        return {"success": True, "job_id": None, "count": 0, "message": "没有损坏文件"}
    job_id = db_manager.create_job(current_project_id, "broken_cleanup", len(broken))
    entries = [
        {"path": b.get("path") or "", "file_uuid": b.get("file_uuid") or ""}
        for b in broken
    ]
    background_tasks.add_task(_broken_cleanup_task, job_id, current_project_id, entries)
    return {
        "success": True,
        "job_id": job_id,
        "count": len(broken),
        "message": f"已提交清理 {len(broken)} 个损坏文件",
    }


@router.get("/api/v1/db/stats")
async def get_db_stats():
    """
    获取数据库统计信息
    """
    try:
        db_manager = get_db_manager()
        current_project_id = getattr(config, 'CURRENT_PROJECT_ID', 'default')
        return {
            "project_id": current_project_id,
            "total_files": db_manager.get_file_count(current_project_id),
            "total_duration": db_manager.get_total_duration(current_project_id)
        }
    except Exception as e:
        logger.error(f"获取统计失败: {e}")
        raise HTTPException(status_code=500, detail=str(e))
