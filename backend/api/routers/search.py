# -*- coding: utf-8 -*-
"""search 域，从 main.py 拆出（AGENTS.md：新接口别继续堆那个文件）。
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

from core.database import is_safe_project_id
from core.errors import SoundBotAPIError
from models import schemas

import tempfile
import sys
import uuid
from datetime import datetime
import config

from api.routers import _deps as _d

logger = logging.getLogger(__name__)
router = APIRouter(tags=["search"])


def get_db_manager():
    return _d.call("get_db_manager")


def _cfg():
    return _d.attr("config")


def _get_project_searcher(*a, **k):
    return _d.call("_get_project_searcher", *a, **k)


async def _search_task(*a, **k):
    return await _d.call("_search_task", *a, **k)


async def get_project(*a, **k):
    return await _d.call("get_project", *a, **k)


@router.post("/api/v1/search", response_model=schemas.SearchResponse)
async def search_audio(request: schemas.SearchRequest):
    """
    语义搜索音频（同步版本，保持向后兼容）

    - **query**: 自然语言查询（如"清脆的铃铛声"）
    - **top_k**: 返回结果数量（默认 20）
    - **threshold**: 相似度阈值（默认 0.15）
    """
    _t_handler_start = time.time()
    try:
        project_id = request.project_id
        if not is_safe_project_id(project_id) or not get_db_manager().get_project(project_id):
            raise SoundBotAPIError("project_not_found", "工程不存在", status_code=404)
        searcher = _get_project_searcher(project_id)

        filters = {}
        if request.min_duration is not None:
            filters["duration"] = {"$gte": request.min_duration}
        if request.max_duration is not None:
            if "duration" in filters:
                filters["duration"]["$lte"] = request.max_duration
            else:
                filters["duration"] = {"$lte": request.max_duration}
        if request.sample_rate is not None:
            filters["sample_rate"] = request.sample_rate
        if request.channels is not None:
            filters["channels"] = request.channels
        if request.format is not None:
            filters["format"] = request.format

        # 使用异步搜索但不推送进度
        results, stats = await searcher.search_async(
            query=request.query,
            top_k=request.top_k,
            min_similarity=request.threshold,
            filters=filters if filters else None,
            use_cache=True,
            fast=bool(getattr(request, "fast", False)),
        )

        logger.info(f"搜索 '{request.query}': 找到 {len(results)} 个结果, 耗时 {stats.get('duration', 0):.3f}s, 缓存命中: {stats.get('cache_hit', False)}")

        _t_after_search = time.time()
        # 转换为响应格式：先把缺 file_id 的路径一次性查出来，避免逐条查库
        missing_paths = [
            r.file_path for r in results if not r.metadata.get("file_id") and r.file_path
        ]
        id_by_path = {}
        if missing_paths:
            try:
                id_by_path = db_manager.get_file_ids_by_paths(missing_paths, project_id)
            except Exception as exc:
                logger.warning("批量解析 file_id 失败: %s", exc)
        search_results = []
        for r in results:
            # 使用 getattr 避免与 Python 内置 format 函数冲突
            file_format = getattr(r, 'format', '') or ''
            file_uuid = r.metadata.get("file_id") or id_by_path.get(r.file_path)
            if not file_uuid:
                matched_record = db_manager.get_file(r.file_path, project_id)
                file_uuid = matched_record.file_uuid if matched_record else None
            audio_file = schemas.AudioFile(
                id=file_uuid,
                path=r.file_path,
                filename=r.filename,
                duration=r.duration,
                sample_rate=r.metadata.get("sample_rate", 0),
                channels=r.metadata.get("channels", 0),
                format=file_format,
                size=r.metadata.get("size", 0)
            )
            search_results.append(schemas.SearchResult(
                audio_file=audio_file,
                score=r.similarity,
                distance=1.0 - r.similarity,
                metadata={
                    "project_id": project_id,
                    "audio_score": r.metadata.get("audio_score", r.metadata.get("semantic_score", 0.0)),
                    "text_score": r.metadata.get("text_score", 0.0),
                    "keyword_score": r.metadata.get("keyword_score", 0.0),
                    "score_weights": r.metadata.get("score_weights", {
                        "audio": 0.55, "text": 0.30, "keyword": 0.15,
                    }),
                }
            ))

        # 分页处理
        total = len(search_results)
        page = request.page
        page_size = request.page_size
        start_idx = (page - 1) * page_size
        end_idx = start_idx + page_size
        paginated_results = search_results[start_idx:end_idx]
        total_pages = (total + page_size - 1) // page_size

        return schemas.SearchResponse(
            query=request.query,
            total=total,
            page=page,
            page_size=page_size,
            total_pages=total_pages,
            results=paginated_results
        )

    except SoundBotAPIError:
        raise
    except Exception as e:
        import traceback
        logger.error(f"搜索失败: {e}")
        logger.error(f"搜索失败详细堆栈: {traceback.format_exc()}")
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/api/v1/search/async")
async def search_audio_async(
    request: schemas.SearchRequest,
    background_tasks: BackgroundTasks,
    client_id: str = Query(default="default")
):
    """
    异步语义搜索（带 WebSocket 进度推送）

    - **query**: 自然语言查询
    - **top_k**: 返回结果数量
    - **threshold**: 相似度阈值
    - **client_id**: WebSocket 客户端标识

    返回搜索任务ID，通过 WebSocket 接收进度和结果
    """
    try:
        project_id = request.project_id
        db_manager = get_db_manager()
        if not is_safe_project_id(project_id) or not db_manager.get_project(project_id):
            raise SoundBotAPIError(
                "project_not_found",
                "工程不存在",
                status_code=404,
                details={"project_id": project_id},
            )
        search_id = f"search_{int(time.time() * 1000)}"

        # 后台执行搜索
        background_tasks.add_task(
            _search_task,
            search_id=search_id,
            query=request.query,
            top_k=request.top_k,
            min_similarity=request.threshold,
            filters={
                k: v for k, v in {
                    "min_duration": request.min_duration,
                    "max_duration": request.max_duration,
                    "sample_rate": request.sample_rate,
                    "channels": request.channels,
                    "format": request.format
                }.items() if v is not None
            },
            client_id=client_id,
            project_id=project_id,
        )

        return {"search_id": search_id, "message": "搜索任务已启动"}

    except SoundBotAPIError:
        raise
    except Exception as e:
        logger.error(f"启动搜索任务失败: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/api/v1/search/cache/stats")
async def get_search_cache_stats():
    """
    获取搜索缓存统计信息
    """
    try:
        project_id = getattr(config, 'CURRENT_PROJECT_ID', 'default')
        searcher = _get_project_searcher(project_id)
        stats = searcher.get_cache_stats()
        return {
            "status": "success",
            "cache_stats": stats
        }
    except Exception as e:
        logger.error(f"获取缓存统计失败: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/api/v1/search/cache/clear")
async def clear_search_cache():
    """
    清空搜索缓存
    """
    try:
        project_id = getattr(config, 'CURRENT_PROJECT_ID', 'default')
        searcher = _get_project_searcher(project_id)
        await searcher.clear_cache()
        return {
            "status": "success",
            "message": "搜索缓存已清空"
        }
    except Exception as e:
        logger.error(f"清空缓存失败: {e}")
        raise HTTPException(status_code=500, detail=str(e))
