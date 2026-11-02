# -*- coding: utf-8 -*-
"""audio 域，从 main.py 拆出（AGENTS.md：新接口别继续堆那个文件）。
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

import config

import tempfile
import sys
import uuid
from datetime import datetime
from core.database import is_safe_project_id, canonicalize_path
from models import schemas

from api.routers import _deps as _d

logger = logging.getLogger(__name__)
router = APIRouter(tags=["audio"])


def get_db_manager():
    return _d.call("get_db_manager")


def SoundBotAPIError(*a, **k):
    return _d.attr("SoundBotAPIError")(*a, **k)


def _stems_staging_root(*a, **k):
    return _d.call("_stems_staging_root", *a, **k)


class EffectRequest(BaseModel):
    path: str
    preset: str = "room_large"
    wet: Optional[float] = None


class EffectExportRequest(BaseModel):
    path: str
    preset: str = "room_large"
    wet: Optional[float] = None
    out_dir: Optional[str] = None


class ChannelMixRequest(BaseModel):
    path: str
    audible: List[int]


class ReverseRequest(BaseModel):
    path: str


class RemoveVocalsRequest(BaseModel):
    paths: List[str]
    out_dir: Optional[str] = None
    strength: float = 1.0


class SeparateRequest(BaseModel):
    paths: List[str]
    out_dir: Optional[str] = None
    model: str = "htdemucs"
    stems: Optional[List[str]] = None


class StemsSaveRequest(BaseModel):
    files: List[str]
    target_dir: str
    overwrite: bool = False


@router.post("/api/v1/audio/export-effect")
async def export_effect_endpoint(payload: EffectExportRequest):
    """处理并落盘：默认输出到原文件同目录 <名字>_<预设>.wav。"""
    from core.effects import apply_effect, PRESETS
    import shutil

    if not payload.path:
        raise HTTPException(status_code=422, detail="path 不能为空")
    loop = asyncio.get_running_loop()
    wet = -1.0 if payload.wet is None else float(payload.wet)
    result = await loop.run_in_executor(None, apply_effect, payload.path, payload.preset, wet)
    if not result.get("ok"):
        raise SoundBotAPIError("effect_failed", str(result.get("error") or "处理失败"), status_code=500)

    source = Path(payload.path)
    out_dir = Path(payload.out_dir) if payload.out_dir else source.parent
    out_dir.mkdir(parents=True, exist_ok=True)
    preset_name = (PRESETS.get(payload.preset) or {}).get("name") or payload.preset
    target = out_dir / f"{source.stem}_{preset_name}.wav"
    index = 2
    while target.exists():
        target = out_dir / f"{source.stem}_{preset_name} ({index}).wav"
        index += 1
    await loop.run_in_executor(None, shutil.copyfile, result["path"], str(target))
    return {"success": True, "path": str(target), "preset": result.get("preset"), "wet": result.get("wet")}


@router.get("/api/v1/audio/effect-presets")
async def list_effect_presets():
    """可用效果器预设（混响空间）。"""
    from core.effects import PRESETS

    items = [
        {"id": key, "name": value["name"], "decay": value["decay"], "wet": value["wet"]}
        for key, value in PRESETS.items()
    ]
    return {"success": True, "presets": items}


@router.post("/api/v1/audio/apply-effect")
async def apply_effect_endpoint(payload: EffectRequest):
    """给干声加混响，返回可试听的临时 WAV。"""
    from core.effects import apply_effect

    if not payload.path:
        raise HTTPException(status_code=422, detail="path 不能为空")
    loop = asyncio.get_running_loop()
    wet = -1.0 if payload.wet is None else float(payload.wet)
    result = await loop.run_in_executor(None, apply_effect, payload.path, payload.preset, wet)
    if not result.get("ok"):
        raise SoundBotAPIError("effect_failed", str(result.get("error") or "处理失败"), status_code=500)
    return {"success": True, **result}


@router.get("/api/v1/audio/channels")
async def audio_channels(path: str = Query(...), points: int = 400):
    """逐声道波形峰值（最多 8 条），用于播放器下方的声道条。"""
    from core.channel_tools import channel_peaks

    loop = asyncio.get_running_loop()
    result = await loop.run_in_executor(None, channel_peaks, path, points)
    if not result.get("ok"):
        raise SoundBotAPIError("channels_failed", str(result.get("error") or "读取声道失败"), status_code=500)
    return {"success": True, **result}


@router.post("/api/v1/audio/channel-mix")
async def audio_channel_mix(payload: ChannelMixRequest):
    """生成只保留指定声道的试听文件（其余静音），用于单独听某个声道。"""
    from core.channel_tools import render_channel_mix

    if not payload.path:
        raise HTTPException(status_code=422, detail="path 不能为空")
    loop = asyncio.get_running_loop()
    result = await loop.run_in_executor(None, render_channel_mix, payload.path, payload.audible)
    if not result.get("ok"):
        raise SoundBotAPIError("channel_mix_failed", str(result.get("error") or "生成失败"), status_code=500)
    return {"success": True, **result}


@router.post("/api/v1/audio/reverse")
async def reverse_audio(payload: ReverseRequest):
    """生成（或复用缓存的）倒放 WAV，返回本地绝对路径。"""
    from core.audio_reverse import reverse_to_wav

    if not payload.path:
        raise HTTPException(status_code=422, detail="path 不能为空")
    loop = asyncio.get_running_loop()
    result = await loop.run_in_executor(None, reverse_to_wav, payload.path)
    if not result.get("ok"):
        raise SoundBotAPIError("reverse_failed", str(result.get("error") or "倒放失败"), status_code=500)
    return {"success": True, **result}


@router.post('/api/v1/audio/stems/save')
async def save_stems(payload: StemsSaveRequest):
    """把用户选中的分轨文件复制到指定文件夹（不覆盖同名文件）。"""
    import shutil

    if not payload.files:
        raise HTTPException(status_code=422, detail='没有选中的分轨')
    target = Path(payload.target_dir).expanduser()
    try:
        target.mkdir(parents=True, exist_ok=True)
    except Exception as exc:
        raise SoundBotAPIError('bad_target_dir', f'无法创建目标文件夹: {exc}', status_code=400)
    saved = []
    skipped = []
    for raw in payload.files:
        src = Path(str(raw))
        if not src.is_file():
            skipped.append({'path': str(src), 'reason': 'not_found'})
            continue
        dest = target / src.name
        if dest.exists() and not payload.overwrite:
            stem, suffix = src.stem, src.suffix
            index = 1
            while dest.exists():
                dest = target / f'{stem} ({index}){suffix}'
                index += 1
        try:
            if dest.resolve() != src.resolve():
                shutil.copy2(str(src), str(dest))
        except Exception as exc:
            skipped.append({'path': str(src), 'reason': str(exc)[:120]})
            continue
        saved.append(str(dest))
    return {'success': True, 'saved': saved, 'count': len(saved), 'skipped': skipped, 'target_dir': str(target)}


@router.post("/api/v1/audio/separate")
async def separate_audio(payload: SeparateRequest):
    """用 Demucs 把音乐拆成人声/鼓/贝斯/其他，并额外合成一版伴奏。"""
    from core.separation import separate, SUPPORTED_MODELS, DEFAULT_MODEL

    if not payload.paths:
        raise HTTPException(status_code=422, detail="paths 不能为空")
    if len(payload.paths) > 20:
        raise HTTPException(status_code=422, detail="单次最多 20 首（分轨比较慢）")

    model_name = payload.model if payload.model in SUPPORTED_MODELS else DEFAULT_MODEL
    loop = asyncio.get_running_loop()
    results = []
    for path in payload.paths:
        source = Path(str(path))
        if not source.is_file():
            results.append({"source": str(path), "ok": False, "error": "文件不存在"})
            continue
        # 默认写到临时暂存区，绝不写进原文件夹：分轨产物要不要、放哪里由用户决定。
        if payload.out_dir:
            out_dir = Path(payload.out_dir)
        else:
            out_dir = Path(tempfile.mkdtemp(prefix='stems-', dir=str(_stems_staging_root())))

        outcome = await loop.run_in_executor(
            None, separate, str(source), str(out_dir), model_name, payload.stems, True
        )
        results.append({
            "source": str(path),
            "ok": bool(outcome.get("ok")),
            "stems": outcome.get("stems") or {},
            "instrumental": outcome.get("instrumental") or "",
            "device": outcome.get("device") or "",
            "error": outcome.get("error") or "",
        })

    ok = sum(1 for item in results if item["ok"])
    return {"success": True, "total": len(results), "ok": ok, "failed": len(results) - ok, "results": results}


@router.post("/api/v1/audio/remove-vocals")
async def remove_vocals_batch(payload: RemoveVocalsRequest):
    """把选中音乐里的人声尽量消掉，输出伴奏 WAV。"""
    from core.vocals import remove_vocals

    if not payload.paths:
        raise HTTPException(status_code=422, detail="paths 不能为空")
    if len(payload.paths) > 200:
        raise HTTPException(status_code=422, detail="单次最多 200 个文件")

    loop = asyncio.get_running_loop()
    results = []
    for path in payload.paths:
        source = Path(str(path))
        if not source.is_file():
            results.append({"source": str(path), "ok": False, "error": "文件不存在"})
            continue
        # 默认写临时暂存区，不写原文件夹：去人声结果是「伴奏」，要不要、放哪由用户决定
        if payload.out_dir:
            out_dir = Path(payload.out_dir)
        else:
            out_dir = Path(tempfile.mkdtemp(prefix='vocals-', dir=str(_stems_staging_root())))
        out_dir.mkdir(parents=True, exist_ok=True)
        destination = out_dir / (source.stem + "_伴奏.wav")
        if destination.exists():
            index = 2
            while destination.exists():
                destination = out_dir / f"{source.stem}_伴奏 ({index}).wav"
                index += 1
        outcome = await loop.run_in_executor(
            None, remove_vocals, str(source), str(destination), float(payload.strength or 1.0)
        )
        results.append({
            "source": str(path),
            "destination": str(destination),
            "ok": bool(outcome.get("ok")),
            "samples": int(outcome.get("samples") or 0),
            "error": outcome.get("error") or "",
        })

    ok = sum(1 for item in results if item["ok"])
    return {"success": True, "total": len(results), "ok": ok, "failed": len(results) - ok, "results": results}


@router.get("/api/v1/audio/{file_path:path}")
async def get_audio(file_path: str = PathParam(..., description="音频文件路径")):
    """
    提供音频文件播放服务（通用路由，放在子路由之后）

    支持范围请求（用于前端波形显示和流式播放）
    """
    audio_file = config.validate_audio_path(file_path)

    # 获取文件大小
    file_size = audio_file.stat().st_size

    capability = config.AUDIO_FORMAT_CAPABILITIES.get(audio_file.suffix.lower(), {})
    mime_type = capability.get('mime_type', 'application/octet-stream')

    # 创建文件响应，支持范围请求
    return FileResponse(
        path=str(audio_file),
        media_type=mime_type,
        filename=audio_file.name
    )
