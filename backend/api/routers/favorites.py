# -*- coding: utf-8 -*-
"""收藏夹接口。

从 main.py 拆出来（AGENTS.md：新接口别继续堆那个文件，已堆进去的按域逐步搬）。
只依赖 core.database，没有全局状态，是最安全的一块样板。
"""
from __future__ import annotations

import logging

from fastapi import APIRouter, Query

from core.database import get_db_manager

logger = logging.getLogger(__name__)
router = APIRouter(tags=["favorites"])


@router.get("/api/v1/favorites")
async def list_favorites(
    project_id: str = Query(default="default"),
    limit: int = Query(default=500, le=2000),
):
    db_manager = get_db_manager()
    files = db_manager.list_favorites(project_id, limit=limit)
    return {"success": True, "files": files, "total": len(files)}
