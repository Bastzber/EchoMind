# -*- coding: utf-8 -*-
"""媒体流接口：给 PR 面板（CEP）试听用。

面板跑在 PR 的 CEP Chromium 里，用 file:// 直接放本地音频不一定放得出来
（跨源策略、路径编码、非 ASCII 路径都可能踩坑）。这里由后端按 uuid 流式吐字节，
Starlette 的 FileResponse 自带 Range 支持，<audio> 可以边下边播。
"""
from __future__ import annotations

import logging
import mimetypes
import os
from typing import Optional

from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import FileResponse

logger = logging.getLogger(__name__)
router = APIRouter(tags=["media"])


@router.get("/api/v1/files/{file_uuid}/audio")
async def file_audio(file_uuid: str, project_id: str = Query(default="default")):
    """按 file_uuid 流式返回音频文件（支持 Range，浏览器可 seek）。"""
    from main import get_db_manager

    db_manager = get_db_manager()
    with db_manager.get_cursor() as cursor:
        row = cursor.execute(
            "SELECT path, filename FROM files WHERE project_id=? AND file_uuid=?",
            (project_id, file_uuid),
        ).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="文件不存在")
    path = str(row["path"] or "")
    if not path or not os.path.isfile(path):
        raise HTTPException(status_code=404, detail="磁盘上找不到这个文件")

    media_type: Optional[str] = mimetypes.guess_type(path)[0]
    if not media_type or media_type == "application/octet-stream":
        media_type = "audio/wav" if path.lower().endswith(".wav") else "audio/mpeg"
    return FileResponse(
        path,
        media_type=media_type,
        filename=str(row["filename"] or os.path.basename(path)),
        headers={"Accept-Ranges": "bytes", "Cache-Control": "no-store"},
    )
