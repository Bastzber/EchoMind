# -*- coding: utf-8 -*-
"""assistant 域，从 main.py 拆出（AGENTS.md：新接口别继续堆那个文件）。
"""
from __future__ import annotations

import logging
from typing import Any, Dict, List, Optional

import os
import json
import time
import math
import asyncio
from pathlib import Path
from typing import Optional, List, Dict, Any, Mapping, Sequence, Tuple

from fastapi import APIRouter, BackgroundTasks, HTTPException, Path as PathParam, Query
from fastapi.responses import FileResponse, JSONResponse, Response, StreamingResponse
from pydantic import BaseModel, Field
from pydantic import BaseModel, Field

import tempfile
import sys
import uuid
from datetime import datetime
from core.database import is_safe_project_id, canonicalize_path
from models import schemas
import config

from api.routers import _deps as _d

logger = logging.getLogger(__name__)
router = APIRouter(tags=["assistant"])


def get_db_manager():
    return _d.call("get_db_manager")


def SoundBotAPIError(*a, **k):
    return _d.attr("SoundBotAPIError")(*a, **k)


class AssistantChatRequest(BaseModel):
    messages: List[Dict[str, str]]
    project_id: str = "default"


class AssistantSpeakRequest(BaseModel):
    text: str
    profile_id: str = ""
    provider: str = "auto"
    channels: int = 1
    sample_rate: int = 24000


@router.post("/api/v1/assistant/chat")
async def assistant_chat(payload: AssistantChatRequest):
    """大肥鱼 AI 助理：带工具调用的多步对话。"""
    from core.assistant import run_assistant

    if not payload.messages:
        raise HTTPException(status_code=422, detail="messages 不能为空")
    result = await run_assistant(payload.messages[-12:], payload.project_id or "default")
    return {"success": True, **result}


@router.post("/api/v1/assistant/speak/stream")
async def assistant_speak_stream(payload: AssistantSpeakRequest):
    """流式朗读：边合成边把 PCM 推给前端，首帧约 0.5 秒就能出声。

    一次性合成要等整句念完（5~6 秒）才拿到文件；这里直接把 Breeze 的流转发出去。
    """
    import httpx

    from core import tts

    text = (payload.text or '').strip()
    if not text:
        raise HTTPException(status_code=422, detail="text 不能为空")
    if not await asyncio.to_thread(tts.breeze_available, 1.0):
        for _ in range(25):
            await asyncio.sleep(1.0)
            if await asyncio.to_thread(tts.breeze_available, 1.0):
                break

    loop = asyncio.get_running_loop()
    parts = await asyncio.to_thread(
        tts.breeze_request_parts,
        text,
        voice_id=await asyncio.to_thread(tts.assistant_voice_id),
        instruction=await asyncio.to_thread(tts.voice_style),
    )
    if not parts:
        raise HTTPException(status_code=422, detail="文本不能为空")
    url, body, headers = parts

    async def gen():
        # Breeze 边生成边返回 PCM（实测首块 0.47s，整段 5.8s）
        async with httpx.AsyncClient(timeout=httpx.Timeout(180.0, connect=10.0)) as client:
            async with client.stream('POST', url, content=body, headers=headers) as resp:
                if resp.status_code != 200:
                    raise SoundBotAPIError("tts_failed", f"合成失败 {resp.status_code}", status_code=503)
                async for chunk in resp.aiter_raw():
                    if chunk:
                        yield chunk

    return StreamingResponse(
        gen(),
        media_type="application/octet-stream",
        headers={"X-Sample-Rate": "24000", "X-Channels": "1", "Cache-Control": "no-store"},
    )


@router.post("/api/v1/assistant/speak")
async def assistant_speak(payload: AssistantSpeakRequest):
    """朗读一段文本：本地 Breeze 优先，豆包兜底。"""
    from core import tts

    text = (payload.text or "").strip()
    if not text:
        raise HTTPException(status_code=422, detail="text 不能为空")
    # 冷启动保护：刚开机/刚重启时 Breeze 还没起来，直接合成会 503，
    # 前端那一段就被跳过了（表现就是「第一句话没声音」）。
    # 这里最多等 25 秒，等它起来再合成。
    if not await asyncio.to_thread(tts.breeze_available, 1.0):
        for _ in range(25):
            await asyncio.sleep(1.0)
            if await asyncio.to_thread(tts.breeze_available, 1.0):
                break
    provider = (getattr(payload, "provider", "") or "auto").strip() or "auto"
    result = await asyncio.to_thread(tts.speak, text, provider, getattr(payload, "profile_id", "") or "")
    if not result.get("ok"):
        raise SoundBotAPIError("tts_failed", str(result.get("error") or "朗读失败"), status_code=503)
    return {"success": True, "path": result.get("path"), "provider": result.get("provider"), "seconds": result.get("seconds")}


@router.get("/api/v1/assistant/memory")
async def assistant_memory_list():
    from core.assistant import load_memory

    return {"success": True, "items": load_memory(get_db_manager(), limit=50)}


@router.delete("/api/v1/assistant/memory")
async def assistant_memory_clear():
    db_manager = get_db_manager()
    with db_manager.get_cursor() as cursor:
        cursor.execute("DELETE FROM assistant_memory")
    return {"success": True}


@router.get("/api/v1/assistant/events")
async def assistant_events():
    """给前端做主动提醒用：最近导入/索引状态的变化源。"""
    db_manager = get_db_manager()
    with db_manager.get_cursor() as cursor:
        failed = cursor.execute(
            "SELECT COUNT(*) FROM file_artifacts WHERE project_id='default' AND state='failed'"
        ).fetchone()[0]
        pending = cursor.execute(
            "SELECT COUNT(*) FROM file_artifacts WHERE project_id='default' AND state IN ('pending','processing')"
        ).fetchone()[0]
        total = cursor.execute(
            "SELECT COUNT(*) FROM files WHERE project_id='default'"
        ).fetchone()[0]
        last_job = cursor.execute(
            "SELECT kind, state, total, created_at FROM jobs ORDER BY created_at DESC LIMIT 1"
        ).fetchone()
    return {
        "success": True,
        "failed": failed,
        "pending": pending,
        "total_files": total,
        "last_job": ({"kind": last_job[0], "state": last_job[1], "total": last_job[2], "created_at": last_job[3]} if last_job else None),
    }
