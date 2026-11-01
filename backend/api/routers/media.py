# -*- coding: utf-8 -*-
"""媒体流接口：给 PR 面板（CEP）试听用。

面板跑在 PR 的 CEP Chromium 里，用 file:// 直接放本地音频不一定放得出来
（跨源策略、路径编码、非 ASCII 路径都可能踩坑）。这里由后端按 uuid 流式吐字节，
Starlette 的 FileResponse 自带 Range 支持，<audio> 可以边下边播。

?transcode=1 时先转成 PCM WAV 再吐：库里不少 WAV 是 IMA ADPCM（format_tag=17）
或 24/32bit 浮点，Chromium 解不了，直接播会报 MEDIA_ERR_SRC_NOT_SUPPORTED。
转码结果按 (uuid, mtime, size) 缓存，第二次秒开。
"""
from __future__ import annotations

import asyncio
import logging
import mimetypes
import os
import tempfile
from pathlib import Path
from typing import Optional

from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import FileResponse

logger = logging.getLogger(__name__)
router = APIRouter(tags=["media"])


def _cache_dir() -> Path:
    base = os.environ.get("APPDATA") or tempfile.gettempdir()
    path = Path(base) / "EchoMind" / "cache" / "panel-audio"
    path.mkdir(parents=True, exist_ok=True)
    return path


def _transcoded_path(source: Path, file_uuid: str) -> Path:
    """缓存键带上 mtime 和大小：源文件换了，旧转码自动失效。"""
    try:
        stamp = int(source.stat().st_mtime)
        size = int(source.stat().st_size)
    except OSError:
        stamp, size = 0, 0
    return _cache_dir() / f"{file_uuid}-{stamp}-{size}.wav"


@router.get("/api/v1/files/{file_uuid}/audio")
async def file_audio(
    file_uuid: str,
    project_id: str = Query(default="default"),
    transcode: bool = Query(default=False),
):
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

    source = Path(path)
    headers = {"Accept-Ranges": "bytes", "Cache-Control": "no-store"}

    if not transcode:
        media_type: Optional[str] = mimetypes.guess_type(path)[0]
        if not media_type or media_type == "application/octet-stream":
            media_type = "audio/wav" if path.lower().endswith(".wav") else "audio/mpeg"
        return FileResponse(
            path,
            media_type=media_type,
            filename=str(row["filename"] or source.name),
            headers=headers,
        )

    cached = _transcoded_path(source, file_uuid)
    if not cached.is_file():
        from core.transcode import transcode_file

        result = await asyncio.to_thread(
            transcode_file, path, str(cached), "wav"
        )
        if not result.get("ok"):
            raise HTTPException(
                status_code=422,
                detail=f"转码失败: {result.get('error') or '未知原因'}",
            )
    return FileResponse(
        str(cached),
        media_type="audio/wav",
        filename=source.stem + ".wav",
        headers=headers,
    )
