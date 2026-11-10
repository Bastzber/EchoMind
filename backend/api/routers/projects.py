# -*- coding: utf-8 -*-
"""projects 域，从 main.py 拆出（AGENTS.md：新接口别继续堆那个文件）。
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
from core.database import is_safe_project_id
from models import schemas

import config

import tempfile
import sys
import uuid
from datetime import datetime

from api.routers import _deps as _d

logger = logging.getLogger(__name__)
router = APIRouter(tags=["projects"])


def get_db_manager():
    return _d.call("get_db_manager")


def _cfg():
    return _d.attr("config")


def _find_mapping_by_path(*a, **k):
    return _d.call("_find_mapping_by_path", *a, **k)


def _get_active_audio_indexer(*a, **k):
    return _d.call("_get_active_audio_indexer", *a, **k)


def _get_active_text_indexer(*a, **k):
    return _d.call("_get_active_text_indexer", *a, **k)


def _get_project_index_lock(*a, **k):
    """同步函数：返回 asyncio.Lock（不是协程），调用方用 async with。"""
    return _d.call("_get_project_index_lock", *a, **k)




def _soft_index_lock(*a, **k):
    return _d.call("_soft_index_lock", *a, **k)
def _projects_deleting():
    """正在删除的工程集合（主模块持有，这里取引用）。"""
    return _d.attr("_projects_deleting")


def _index_progress():
    """主模块里的 _index_progress() 是 dict（不是函数），要取对象本身。"""
    return _d.attr("_index_progress")


def _invalidate_text_metadata_for_paths_locked(*a, **k):
    return _d.call("_invalidate_text_metadata_for_paths_locked", *a, **k)


def _run_model_work(*a, **k):
    return _d.call("_run_model_work", *a, **k)


async def _start_folder_import(*a, **k):
    return await _d.call("_start_folder_import", *a, **k)


async def _start_index_job(*a, **k):
    return await _d.call("_start_index_job", *a, **k)


def _zh_text_status(*a, **k):
    return _d.call("_zh_text_status", *a, **k)


async def create_project(*a, **k):
    return await _d.call("create_project", *a, **k)


async def get_imported_folder_mappings(*a, **k):
    return await _d.call("get_imported_folder_mappings", *a, **k)



async def get_user_folders(*a, **k):
    return await _d.call("get_user_folders", *a, **k)


async def import_selected_files(*a, **k):
    return await _d.call("import_selected_files", *a, **k)


class CreateFolderRequest(BaseModel):
    name: str
    description: Optional[str] = None
    color: Optional[str] = '#3b82f6'


class UpdateFolderRequest(BaseModel):
    name: Optional[str] = None
    description: Optional[str] = None
    color: Optional[str] = None
    sort_order: Optional[int] = None


@router.post("/api/v1/projects/{project_id}/imports")
async def import_project_files(
    project_id: str,
    request: schemas.ProjectImportRequest,
    background_tasks: BackgroundTasks,
):
    """Import exactly one folder or file list into the path-scoped project."""
    if request.folder_path is not None:
        return await _start_folder_import(
            project_id,
            request.folder_path,
            request.recursive,
            request.client_id or "default",
            background_tasks,
            skip_existing=bool(getattr(request, "skip_existing", False)),
        )
    payload = schemas.ImportFilesRequest(
        file_paths=request.file_paths or [],
        client_id=request.client_id,
        project_id=project_id,
    )
    return await import_selected_files(payload, background_tasks)


@router.get("/api/v1/projects/{project_id}/index/status")
async def get_project_index_status(project_id: str):
    db_manager = get_db_manager()
    if not is_safe_project_id(project_id) or not db_manager.get_project(project_id):
        raise SoundBotAPIError("project_not_found", "工程不存在", status_code=404)
    if project_id in _projects_deleting():
        raise SoundBotAPIError("project_deleting", "工程正在删除", status_code=409)
    # 当前正在跑的索引任务（前端用来显示 已处理/总数，实时看到进度）
    active_job = None
    try:
        with db_manager.get_cursor() as cursor:
            row = cursor.execute(
                "SELECT kind, state, processed, total, stage FROM jobs "
                "WHERE project_id=? AND state IN ('running','pending') "
                "ORDER BY created_at DESC LIMIT 1",
                (project_id,),
            ).fetchone()
        if row:
            active_job = {
                "kind": row[0], "state": row[1], "processed": int(row[2] or 0),
                "total": int(row[3] or 0), "stage": row[4],
            }
    except Exception as exc:
        logger.debug("读取活跃索引任务失败: %s", exc)

    # 这几处都是同步数据库调用：全表 JOIN 一次实测 3.5 秒，直接 await 在事件循环上，
    # 界面上的每次轮询都会把整个后端按住（日志里的「[Loop] 事件循环卡顿 3.5s」）。
    # 全部丢线程池，循环该干嘛干嘛。
    total_files = await asyncio.to_thread(db_manager.get_file_count, project_id)
    artifact_counts = await asyncio.to_thread(db_manager.get_artifact_counts, project_id)

    return {
        "project_id": project_id,
        "total_files": total_files,
        "artifacts": artifact_counts,
        "active_job": active_job,
        "progress": {**_index_progress(), **(lambda: __import__("core.index_progress", fromlist=["stats"]).stats())()},
        "manifests": {
            kind: db_manager.get_index_manifest(project_id, kind) or {}
            for kind in ("audio_vector", "text_vector")
        },
        # 中文语义（BGE / text_zh）是否真的可用：缺失时搜索结果只剩关键词分，
        # 界面上要能看见「语义检索未建立」而不是静默降级（B15）。
        "zh_text": _zh_text_status(),
    }


@router.post("/api/v1/projects/{project_id}/index/adopt")
async def adopt_project_index(
    project_id: str,
    kind: str = "text_vector",
    dry_run: bool = False,
):
    """把磁盘上已有的向量接管回 SQLite 工件状态，不重新编码。

    典型场景：collection 和 manifest 都在，但 file_artifacts 全停在 stale，
    reconcile 会据此把整库重编码（6.5 万条一次跑会打爆内存）。这里只翻状态。
    """
    from core import index_adopt

    db_manager = get_db_manager()
    if not is_safe_project_id(project_id) or not db_manager.get_project(project_id):
        raise SoundBotAPIError("project_not_found", "工程不存在", status_code=404)
    if kind not in ("audio_vector", "text_vector"):
        raise SoundBotAPIError("invalid_kind", "kind 必须是 audio_vector 或 text_vector", status_code=422)
    if kind == "audio_vector":
        indexer = _get_active_audio_indexer(project_id)
    else:
        indexer = _get_active_text_indexer(project_id)
    result = await asyncio.to_thread(
        index_adopt.adopt_existing_vectors,
        db_manager, indexer, project_id, kind, dry_run=dry_run,
    )
    return {"success": True, **result, "counts": db_manager.get_artifact_counts(project_id).get(kind)}


@router.post("/api/v1/projects/{project_id}/index/reconcile")
async def reconcile_project_index(
    project_id: str,
    request: schemas.IndexActionRequest,
    background_tasks: BackgroundTasks,
):
    # 同一工程只允许一个索引任务：已经在跑就直接复用，别新建一个把它打断
    # （之前就是这个「新建即取消旧任务」导致 processing 反复卡住）。
    current = _automatic_index_tasks().get(project_id)
    if current and not current["task"].done():
        logger.info(
            "[Index] %s 已有任务 %s 在跑，复用而不是新建",
            project_id, str(current.get("job_id"))[:8],
        )
        return {
            "job_id": str(current["job_id"]),
            "project_id": project_id,
            "state": "running",
            "reused": True,
        }
    return await _start_index_job(project_id, request.kinds, "reconcile", background_tasks)


@router.post("/api/v1/projects/{project_id}/index/rebuild")
async def rebuild_project_index(
    project_id: str,
    request: schemas.IndexActionRequest,
    background_tasks: BackgroundTasks,
):
    return await _start_index_job(project_id, request.kinds, "rebuild", background_tasks)


@router.post("/api/v1/projects")
async def create_project(request: schemas.CreateProjectRequest):
    """
    创建新工程

    - **name**: 工程名称
    - **description**: 工程描述
    - **temp_dir**: 工程特定的临时文件目录
    """
    try:
        import uuid
        project_id = str(uuid.uuid4())

        db_manager = get_db_manager()
        success = db_manager.create_project(
            project_id=project_id,
            name=request.name,
            description=request.description,
            temp_dir=request.temp_dir
        )

        if not success:
            raise SoundBotAPIError("project_create_failed", "创建工程失败")

        return {
            "success": True,
            "project_id": project_id,
            "message": f"工程 '{request.name}' 创建成功"
        }
    except SoundBotAPIError:
        raise
    except Exception as e:
        logger.error(f"创建工程失败: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/api/v1/projects")
async def get_all_projects():
    """
    获取所有工程列表
    """
    try:
        db_manager = get_db_manager()
        projects = db_manager.get_all_projects()

        # 添加每个工程的文件数量
        for project in projects:
            project['file_count'] = db_manager.get_project_file_count(project['id'])

        return {
            "total": len(projects),
            "projects": projects
        }
    except Exception as e:
        logger.error(f"获取工程列表失败: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/api/v1/projects/recent")
async def get_recent_projects(limit: int = 10):
    """
    获取最近使用的工程列表
    """
    try:
        db_manager = get_db_manager()
        projects = db_manager.get_recent_projects(limit)

        # 添加每个工程的文件数量
        for project in projects:
            project['file_count'] = db_manager.get_project_file_count(project['id'])

        return {
            "total": len(projects),
            "projects": projects
        }
    except Exception as e:
        logger.error(f"获取最近工程失败: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/api/v1/projects/{project_id}")
async def get_project(project_id: str):
    """
    获取工程详情
    """
    try:
        db_manager = get_db_manager()
        project = db_manager.get_project(project_id)

        if not project:
            raise SoundBotAPIError(
                "project_not_found", "工程不存在", status_code=404
            )

        # 添加文件数量
        project['file_count'] = db_manager.get_project_file_count(project_id)

        return project
    except SoundBotAPIError:
        raise
    except Exception as e:
        logger.error(f"获取工程详情失败: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.put("/api/v1/projects/{project_id}")
async def update_project(project_id: str, request: schemas.UpdateProjectRequest):
    """
    更新工程信息
    """
    try:
        db_manager = get_db_manager()

        # 检查工程是否存在
        existing = db_manager.get_project(project_id)
        if not existing:
            raise HTTPException(status_code=404, detail="工程不存在")

        success = db_manager.update_project(
            project_id=project_id,
            name=request.name,
            description=request.description,
            temp_dir=request.temp_dir,
            settings=request.settings
        )

        if not success:
            raise HTTPException(status_code=400, detail="更新工程失败")

        if getattr(config, 'CURRENT_PROJECT_ID', 'default') == project_id:
            active_temp_dir = request.temp_dir if request.temp_dir is not None else existing.get('temp_dir')
            config.set_project_temp_clip_dir(active_temp_dir)

        return {
            "success": True,
            "message": "工程更新成功"
        }
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"更新工程失败: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.delete("/api/v1/projects/{project_id}")
async def delete_project(project_id: str):
    """
    删除工程（会级联删除所有相关文件、向量数据库和缓存）
    """
    if project_id in _projects_deleting():
        raise SoundBotAPIError("project_deleting", "工程正在删除", status_code=409)
    _projects_deleting().add(project_id)
    try:
        # B12：默认工程也允许删。删完会立刻重建一个空的（见下方 ensure_default），
        # 这样界面上就不会出现「显示着但删不掉」的工程。
        if not is_safe_project_id(project_id):
            raise SoundBotAPIError("invalid_project_id", "工程 ID 非法", status_code=400)
        db_manager = get_db_manager()

        # 检查工程是否存在
        existing = db_manager.get_project(project_id)
        if not existing:
            raise SoundBotAPIError("project_not_found", "工程不存在", status_code=404)

        # Stop all accepted writers before waiting for the per-project lock.
        cancelled_jobs = db_manager.request_project_job_cancellation(project_id)
        for job_id in cancelled_jobs:
            get_ws_manager().cancel_task(job_id)

        # 检查是否是当前工程
        current_project_id = getattr(config, 'CURRENT_PROJECT_ID', None)
        is_current_project = (current_project_id == project_id)

        async with _get_project_index_lock(project_id):
            # Catch jobs that were accepted just before the deletion flag was set.
            for job_id in db_manager.request_project_job_cancellation(project_id):
                get_ws_manager().cancel_task(job_id)

            # SQLite is authoritative. If this fails, retain the searchable
            # collections; if it succeeds, an orphan index directory is harmless
            # and can be cleaned on the next attempt/startup.
            # 删库是纯同步的重活（几十万行），放线程里跑，别堵事件循环
            success = await asyncio.to_thread(db_manager.delete_project, project_id)
            if not success:
                raise SoundBotAPIError(
                    "project_delete_failed",
                    "工程数据删除失败，原索引仍保留",
                    status_code=503,
                    retryable=True,
                )

            from core.search_engine import reset_optimized_searcher
            from core.ai_chat_service import reset_ai_chat_service
            from core.indexer import delete_project_index

            reset_optimized_searcher(project_id)
            reset_ai_chat_service(project_id)
            reset_searcher(project_id)
            index_deleted = await _run_model_work(delete_project_index, project_id)
            if not index_deleted:
                logger.warning(f"工程 {project_id} 已从 SQLite 删除；孤立索引目录稍后清理")

        # 删掉默认工程后立刻重建一个空的，避免「工程列表里没有 default、
        # 但各处还在用它」的悬空状态（B12）。
        recreated_default = False
        if project_id == "default":
            try:
                if not db_manager.get_project("default"):
                    recreated_default = db_manager.create_project("default", "默认工程")
                    logger.info("[Projects] 默认工程已重建（空工程）")
            except Exception as exc:
                logger.warning("[Projects] 重建默认工程失败: %s", exc)

        # 如果删除的是当前工程（含默认工程被删），切到默认工程
        if is_current_project or project_id == "default":
            logger.info(f"删除的是当前工程 {project_id}，清理缓存并切换到默认工程")

            # 先切换到默认工程
            config.CURRENT_PROJECT_ID = 'default'
            config.set_project_temp_clip_dir(None)
            logger.info("已切换到默认工程")

            # 重置 Searcher
            reset_optimized_searcher('default')
            logger.info("Searcher 已重置")

        return {
            "success": True,
            "message": "工程已删除",
            "index_deleted": index_deleted,
            "was_current_project": is_current_project,
            "switched_to_default": is_current_project or project_id == "default",
            "recreated_default": recreated_default,
        }
    except SoundBotAPIError:
        raise
    except Exception as e:
        logger.error(f"删除工程失败: {e}")
        raise HTTPException(status_code=500, detail=str(e))
    finally:
        _projects_deleting().discard(project_id)


@router.post("/api/v1/projects/{project_id}/switch")
async def switch_project(project_id: str):
    """
    切换到指定工程

    会将工程添加到最近工程列表，同时切换向量数据库和清理缓存
    """
    try:
        if not is_safe_project_id(project_id):
            raise SoundBotAPIError("invalid_project_id", "工程 ID 非法", status_code=400)
        # Validate before mutating any global state or clearing working caches.
        db_manager = get_db_manager()
        project = db_manager.get_project(project_id)
        if not project:
            raise SoundBotAPIError("project_not_found", "工程不存在", status_code=404)

        # 获取当前工程ID（用于判断是否真的切换了）
        old_project_id = getattr(config, 'CURRENT_PROJECT_ID', None)

        # 如果确实切换了工程，先更新当前工程ID，然后清理缓存
        if old_project_id and old_project_id != project_id:
            logger.info(f"切换工程: {old_project_id} -> {project_id}，开始清理缓存")

            # Project-scoped caches include the project/revision in their keys.
            # Only discard the two affected project views; live jobs for other
            # projects keep their Chroma clients untouched.
            from core.search_engine import reset_optimized_searcher
            reset_optimized_searcher(old_project_id)
            reset_optimized_searcher(project_id)
            logger.info("Searcher 已重置")

            from core.ai_chat_service import reset_ai_chat_service
            reset_ai_chat_service(old_project_id)
            reset_ai_chat_service(project_id)
            logger.info("AI Chat 工程上下文已重置")

        # 添加到最近工程
        db_manager.add_to_recent_projects(project_id)

        # 更新全局配置中的当前工程
        config.CURRENT_PROJECT_ID = project_id

        # 切换工程特定的临时目录。为空时回退到用户全局配置或默认目录。
        active_temp_dir = config.set_project_temp_clip_dir(project.get('temp_dir'))
        logger.info(f"当前临时文件目录: {active_temp_dir}")

        # 获取该工程的向量数据库信息
        from core.embedder import is_embedder_available

        indexer = _get_active_audio_indexer(project_id)
        indexed_count = indexer.get_indexed_count()

        embedder_available = is_embedder_available()

        return {
            "success": True,
            "project_id": project_id,
            "project_name": project['name'],
            "message": f"已切换到工程 '{project['name']}'",
            "cache_cleared": old_project_id != project_id,
            "vector_db": {
                "indexed_count": indexed_count,
                "embedder_available": embedder_available
            }
        }
    except SoundBotAPIError:
        raise
    except Exception as e:
        logger.error(f"切换工程失败: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/api/v1/projects/{project_id}/files")
async def get_project_files(
    project_id: str,
    limit: int = Query(default=200, ge=1, le=500),
    cursor: Optional[int] = Query(default=None, ge=1),
):
    """Compatibility alias for the metadata-only cursor-paginated file list."""
    db_manager = get_db_manager()
    if not is_safe_project_id(project_id):
        raise SoundBotAPIError("invalid_project_id", "工程 ID 非法", status_code=400)
    project = db_manager.get_project(project_id)
    if not project:
        raise SoundBotAPIError("project_not_found", "工程不存在", status_code=404)
    files, next_cursor = db_manager.get_files_cursor_page(
        project_id, limit=limit, before_id=cursor
    )
    for item in files:
        item["size"] = item.pop("file_size")
    return {
        "project_id": project_id,
        "project_name": project["name"],
        "total": db_manager.get_file_count(project_id),
        "files": files,
        "next_cursor": next_cursor,
    }


@router.get("/api/v1/projects/{project_id}/folders")
async def get_user_folders(project_id: str):
    """
    获取指定工程的所有用户自定义文件夹
    """
    try:
        db_manager = get_db_manager()

        # 检查工程是否存在
        project = db_manager.get_project(project_id)
        if not project:
            raise HTTPException(status_code=404, detail="工程不存在")

        folders = db_manager.get_user_folders(project_id)

        # 获取每个文件夹下的导入文件夹数量
        for folder in folders:
            mappings = db_manager.get_imported_folder_mappings(project_id, folder['id'])
            folder['imported_folder_count'] = len(mappings)
            folder['total_file_count'] = sum(m['file_count'] for m in mappings)

        return {
            "project_id": project_id,
            "total": len(folders),
            "folders": folders
        }
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"获取用户文件夹失败: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/api/v1/projects/{project_id}/folders")
async def create_user_folder(project_id: str, request: CreateFolderRequest):
    """
    创建用户自定义文件夹
    """
    try:
        async with _soft_index_lock(project_id):
            db_manager = get_db_manager()
            if project_id in _projects_deleting():
                raise HTTPException(status_code=409, detail="工程正在删除")
            if not db_manager.get_project(project_id):
                raise HTTPException(status_code=404, detail="工程不存在")

            import uuid
            folder_id = f"folder_{uuid.uuid4().hex[:8]}"
            sort_order = len(db_manager.get_user_folders(project_id))
            success = db_manager.create_user_folder(
                folder_id=folder_id,
                project_id=project_id,
                name=request.name,
                description=request.description,
                color=request.color,
                sort_order=sort_order
            )
            if not success:
                raise HTTPException(status_code=400, detail="创建文件夹失败")
            return {
                "success": True,
                "folder_id": folder_id,
                "name": request.name,
                "message": f"文件夹 '{request.name}' 创建成功"
            }
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"创建用户文件夹失败: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.put("/api/v1/projects/{project_id}/folders/{folder_id}")
async def update_user_folder(
    project_id: str,
    folder_id: str,
    request: UpdateFolderRequest,
    background_tasks: BackgroundTasks,
):
    """
    更新用户自定义文件夹
    """
    try:
        async with _soft_index_lock(project_id):
            db_manager = get_db_manager()
            if project_id in _projects_deleting():
                raise HTTPException(status_code=409, detail="工程正在删除")
            folder = db_manager.get_user_folder(folder_id)
            if not folder or folder['project_id'] != project_id:
                raise HTTPException(status_code=404, detail="文件夹不存在")
            affected_paths = [
                mapping["folder_path"]
                for mapping in db_manager.get_imported_folder_mappings(
                    project_id, folder_id
                )
            ]
            success = db_manager.update_user_folder(
                folder_id=folder_id,
                name=request.name,
                description=request.description,
                color=request.color,
                sort_order=request.sort_order
            )
            if not success:
                raise HTTPException(status_code=400, detail="更新文件夹失败")
            invalidation = (
                _invalidate_text_metadata_for_paths_locked(
                    project_id, affected_paths, background_tasks
                )
                if request.name is not None or request.description is not None
                else {"affected_files": 0, "reindex_job_id": None}
            )
            return {
                "success": True,
                "message": "文件夹更新成功",
                **invalidation,
            }
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"更新用户文件夹失败: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/api/v1/projects/{project_id}/folders/{folder_id}/files")
async def add_files_to_user_folder(project_id: str, folder_id: str, payload: Dict[str, Any]):
    """把选中的音效（按路径）加入某个用户文件夹。"""
    paths = payload.get("paths") or []
    if not isinstance(paths, list) or not paths:
        raise HTTPException(status_code=422, detail="paths 不能为空")
    db_manager = get_db_manager()
    added = db_manager.add_files_to_user_folder(project_id, folder_id, [str(p) for p in paths])
    return {"success": True, "added": added, "total": len(paths)}


@router.get("/api/v1/projects/{project_id}/folders/{folder_id}/files")
async def list_files_in_user_folder(project_id: str, folder_id: str):
    db_manager = get_db_manager()
    files = db_manager.list_files_in_user_folder(project_id, folder_id)
    return {"success": True, "files": files, "total": len(files)}


@router.delete("/api/v1/projects/{project_id}/folders/{folder_id}/files/{file_uuid}")
async def remove_file_from_user_folder(project_id: str, folder_id: str, file_uuid: str):
    db_manager = get_db_manager()
    removed = db_manager.remove_file_from_user_folder(project_id, folder_id, file_uuid)
    return {"success": removed}


@router.delete("/api/v1/projects/{project_id}/folders/{folder_id}")
async def delete_user_folder(
    project_id: str,
    folder_id: str,
    background_tasks: BackgroundTasks,
):
    """
    删除用户自定义文件夹

    删除后，该文件夹下的导入文件夹将变为未分类状态
    """
    try:
        async with _soft_index_lock(project_id):
            db_manager = get_db_manager()
            if project_id in _projects_deleting():
                raise HTTPException(status_code=409, detail="工程正在删除")
            folder = db_manager.get_user_folder(folder_id)
            if not folder or folder['project_id'] != project_id:
                raise HTTPException(status_code=404, detail="文件夹不存在")
            affected_paths = [
                mapping["folder_path"]
                for mapping in db_manager.get_imported_folder_mappings(
                    project_id, folder_id
                )
            ]
            if not db_manager.delete_user_folder(folder_id):
                raise HTTPException(status_code=400, detail="删除文件夹失败")
            invalidation = _invalidate_text_metadata_for_paths_locked(
                project_id, affected_paths, background_tasks
            )
            return {
                "success": True,
                "message": f"文件夹 '{folder['name']}' 已删除",
                **invalidation,
            }
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"删除用户文件夹失败: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/api/v1/projects/{project_id}/folder-mappings")
async def get_imported_folder_mappings(project_id: str, user_folder_id: Optional[str] = None):
    """
    获取导入文件夹的映射关系
    """
    try:
        db_manager = get_db_manager()

        # 检查工程是否存在
        project = db_manager.get_project(project_id)
        if not project:
            raise HTTPException(status_code=404, detail="工程不存在")

        mappings = db_manager.get_imported_folder_mappings(project_id, user_folder_id)

        return {
            "project_id": project_id,
            "total": len(mappings),
            "mappings": mappings
        }
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"获取导入文件夹映射失败: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/api/v1/projects/{project_id}/folder-mappings/{folder_path:path}")
async def update_folder_mapping(
    project_id: str,
    folder_path: str,
    background_tasks: BackgroundTasks,
    user_folder_id: Optional[str] = None,
):
    """
    更新导入文件夹的用户文件夹关联

    - **user_folder_id**: 用户文件夹ID，为空表示取消关联（变为未分类）
    """
    try:
        async with _soft_index_lock(project_id):
            db_manager = get_db_manager()
            if project_id in _projects_deleting():
                raise HTTPException(status_code=409, detail="工程正在删除")
            if not db_manager.get_project(project_id):
                raise HTTPException(status_code=404, detail="工程不存在")
            if user_folder_id:
                target_folder = db_manager.get_user_folder(user_folder_id)
                if not target_folder or target_folder["project_id"] != project_id:
                    raise HTTPException(status_code=404, detail="目标文件夹不存在")
            mapping = _find_mapping_by_path(
                db_manager.get_imported_folder_mappings(project_id), folder_path
            )
            if not mapping:
                raise HTTPException(status_code=404, detail="导入文件夹映射不存在")
            stored_path = str(mapping["folder_path"])
            if not db_manager.update_imported_folder_mapping(
                project_id, stored_path, user_folder_id
            ):
                raise HTTPException(status_code=400, detail="更新文件夹映射失败")
            changed = (mapping.get("user_folder_id") or None) != (user_folder_id or None)
            invalidation = (
                _invalidate_text_metadata_for_paths_locked(
                    project_id, [stored_path], background_tasks
                )
                if changed
                else {"affected_files": 0, "reindex_job_id": None}
            )
            return {
                "success": True,
                "message": "文件夹分类已更新",
                **invalidation,
            }
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"更新文件夹映射失败: {e}")
        raise HTTPException(status_code=500, detail="更新文件夹映射失败，请检查日志")


def get_ws_manager():
    return _d.call("get_ws_manager")


def _automatic_index_tasks():
    return _d.attr("_automatic_index_tasks")


def reset_searcher(*a, **k):
    return _d.call("reset_searcher", *a, **k)
