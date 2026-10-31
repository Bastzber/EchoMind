# -*- coding: utf-8 -*-
"""找相似：POST /api/v1/files/{file_uuid}/similar

排序口径见 core/similar.py：标签/描述命中的排在前面，音频向量（听感）接在后面。
"""
from __future__ import annotations

import asyncio

from fastapi import APIRouter, HTTPException, Query

from core import similar as similar_core
from core.database import get_db_manager

router = APIRouter()


@router.post("/api/v1/files/{file_uuid}/similar")
async def find_similar_files(
    file_uuid: str,
    project_id: str = Query("default", description="工程 ID"),
    limit: int = Query(similar_core.DEFAULT_LIMIT, ge=1, le=500, description="最多返回多少条"),
    threshold: float = Query(
        similar_core.DEFAULT_AUDIO_THRESHOLD,
        ge=0.0,
        le=1.0,
        description="音频相似度阈值（只作用于听感段）",
    ),
):
    db_manager = get_db_manager()
    try:
        return await asyncio.to_thread(
            similar_core.find_similar,
            db_manager,
            project_id,
            file_uuid,
            limit=limit,
            audio_threshold=threshold,
        )
    except LookupError as exc:
        raise HTTPException(status_code=404, detail=str(exc) or "文件不存在") from exc
