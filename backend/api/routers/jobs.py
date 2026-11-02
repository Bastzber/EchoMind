# -*- coding: utf-8 -*-
"""jobs 域，从 main.py 拆出（AGENTS.md：新接口别继续堆那个文件）。
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

from core.errors import SoundBotAPIError
from core.database import is_safe_project_id
from models import schemas

import tempfile
import sys
import uuid
from datetime import datetime
import config

from api.routers import _deps as _d

logger = logging.getLogger(__name__)
router = APIRouter(tags=["jobs"])


def get_db_manager():
    return _d.call("get_db_manager")


def _cfg():
    return _d.attr("config")


@router.get("/api/v1/jobs")
async def list_background_jobs(
    project_id: Optional[str] = None,
    limit: int = 50,
    state: Optional[str] = None,
):
    """任务列表（B16）：前端能看到「正在跑什么」，卡住时也能直接查。"""
    states = [item for item in (state or "").replace(",", " ").split() if item]
    jobs = get_db_manager().list_recent_jobs(
        project_id=project_id, limit=limit, states=states or None
    )
    return {"jobs": jobs, "count": len(jobs)}


@router.get("/api/v1/jobs")
async def list_background_jobs(state: Optional[str] = None, limit: int = 50):
    """所有后台任务列表（B16：以前只有单个任务查询，UI 看不到「正在跑什么」）。"""
    jobs = get_db_manager().list_jobs(state=state, limit=limit)
    return {"success": True, "count": len(jobs), "jobs": jobs}


@router.get("/api/v1/jobs/{job_id}")
async def get_background_job(job_id: str):
    job = get_db_manager().get_job(job_id)
    if not job:
        raise SoundBotAPIError("job_not_found", "任务不存在", status_code=404)
    return job


@router.delete("/api/v1/jobs/{job_id}")
async def cancel_background_job(job_id: str):
    db_manager = get_db_manager()
    job = db_manager.get_job(job_id)
    if not job:
        raise SoundBotAPIError("job_not_found", "任务不存在", status_code=404)
    if job["state"] in {"completed", "failed", "cancelled"}:
        return {"job_id": job_id, "state": job["state"], "cancel_requested": False}
    db_manager.update_job(job_id, cancel_requested=1)
    get_ws_manager().cancel_task(job_id)
    # 编码/解码可能正卡在 mel worker 里，循环走不到取消检查点。
    # 杀掉 worker 能立刻把阻塞的调用打断，取消才能真正生效。
    try:
        from core import embedder as _embedder

        await asyncio.to_thread(_embedder.reset_mel_worker_safe)
    except Exception as exc:
        logger.debug("取消时重启 mel worker 失败: %s", exc)
    return {"job_id": job_id, "state": job["state"], "cancel_requested": True}


def get_ws_manager():
    return _d.call("get_ws_manager")
