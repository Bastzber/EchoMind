# -*- coding: utf-8 -*-
"""recipes 域，从 main.py 拆出（AGENTS.md：新接口别继续堆那个文件）。
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
router = APIRouter(tags=["recipes"])


def get_db_manager():
    return _d.call("get_db_manager")


def _get_recipe(*a, **k):
    return _d.call("_get_recipe", *a, **k)


def _serve_recipe_audio(*a, **k):
    return _d.call("_serve_recipe_audio", *a, **k)


@router.get("/api/v1/recipes/{recipe_id}/samples")
async def recipe_samples(recipe_id: str):
    """列出配方可选的单个素材（「选择素材」用）。"""
    from core.sound_recipe import list_recipe_samples

    recipe = _get_recipe(recipe_id)
    if recipe is None:
        raise HTTPException(status_code=404, detail="配方不存在")
    return {"success": True, "samples": list_recipe_samples(recipe)}


@router.post("/api/v1/recipes/{recipe_id}/hit")
async def recipe_hit(recipe_id: str, payload: Dict[str, Any]):
    """按 XY 参数渲染一次触发（“走一步”）。"""
    from core.sound_recipe import render_hit

    recipe = _get_recipe(recipe_id)
    if recipe is None or not recipe.layers:
        raise HTTPException(status_code=404, detail="配方不存在或样本不足")
    x = float(payload.get("x", 0.3) or 0.3)
    y = float(payload.get("y", 0.5) or 0.5)
    sample = str(payload.get("sample") or "").strip() or None
    variation = float(payload.get("variation", 1.0) or 0)
    enabled = payload.get("enabled")
    layer_samples = payload.get("layer_samples") or {}
    if not isinstance(layer_samples, dict):
        layer_samples = {}
    samples = await asyncio.to_thread(
        render_hit, recipe, x, y, None, sample, variation,
        enabled if isinstance(enabled, list) else None,
        layer_samples,
    )
    return {"success": True, **_serve_recipe_audio(samples)}


@router.post("/api/v1/recipes/{recipe_id}/stems")
async def recipe_stems(recipe_id: str, payload: Dict[str, Any] = None):
    """返回 4 条独立音轨 + 每条受 x/y 控制的增益范围。

    前端同时循环播放这 4 条，拖动时只改音量 —— 声音永不重启，因此不可能有断层。
    """
    from core.noise_ambience import STEM_MIX, load_user_stems, synth_stems
    from core.sound_recipe import to_wav_bytes as _to_wav

    recipe = _get_recipe(recipe_id)
    if recipe is None or not recipe.synth:
        raise HTTPException(status_code=404, detail="该配方不是环境音")

    seconds = min(max(float((payload or {}).get("seconds", 45) or 45), 5.0), 60.0)
    stems = await asyncio.to_thread(load_user_stems, recipe.synth, seconds)
    source = "user" if stems else "synth"
    if not stems:
        stems = await asyncio.to_thread(synth_stems, recipe.synth, seconds)
    directory = Path(tempfile.gettempdir()) / "echomind_stems"
    directory.mkdir(parents=True, exist_ok=True)

    items = []
    for stem_id, samples in stems.items():
        wav = _to_wav(samples)
        name = f"{recipe.synth}_{stem_id}.wav"
        path = directory / name
        path.write_bytes(wav)
        items.append({
            "id": stem_id,
            "url": f"/api/v1/temp-audio/stems/{name}",
            "mix": STEM_MIX.get(recipe.synth, {}).get(stem_id, {"x": (0.3, 0.6), "y": (0.3, 0.6)}),
        })
    return {"success": True, "seconds": seconds, "source": source, "stems": items}


@router.post("/api/v1/recipes/{recipe_id}/ambience")
async def recipe_ambience(recipe_id: str, payload: Dict[str, Any]):
    """渲染一段可无缝循环的环境床（拖动触控板时连续换气）。"""
    from core.sound_recipe import render_ambience

    recipe = _get_recipe(recipe_id)
    if recipe is None or not recipe.layers:
        raise HTTPException(status_code=404, detail="配方不存在或样本不足")
    x = float(payload.get("x", 0.5) or 0.5)
    y = float(payload.get("y", 0.5) or 0.5)
    seconds = min(max(float(payload.get("seconds", 6) or 6), 2.0), 12.0)
    enabled = payload.get("enabled")
    layer_samples = payload.get("layer_samples") or {}
    if not isinstance(layer_samples, dict):
        layer_samples = {}
    samples = await asyncio.to_thread(
        render_ambience, recipe, x, y, seconds, 1.0,
        enabled if isinstance(enabled, list) else None,
        layer_samples,
    )
    return {"success": True, **_serve_recipe_audio(samples)}


@router.post("/api/v1/recipes/{recipe_id}/session")
async def recipe_session(recipe_id: str, payload: Dict[str, Any]):
    """把一串触发事件渲染成一段录音（最长 60 秒）。"""
    from core.sound_recipe import render_ambience_performance, render_session

    recipe = _get_recipe(recipe_id)
    if recipe is None or not recipe.layers:
        raise HTTPException(status_code=404, detail="配方不存在或样本不足")
    events = payload.get("events") or []
    max_seconds = min(float(payload.get("max_seconds", 60) or 60), 60.0)
    sample = str(payload.get("sample") or "").strip() or None
    variation = float(payload.get("variation", 1.0) or 0)
    enabled = payload.get("enabled")
    layer_samples = payload.get("layer_samples") or {}
    if not isinstance(layer_samples, dict):
        layer_samples = {}
    for event in events:
        event.setdefault("sample", sample)
        event.setdefault("variation", variation)
    if recipe.mode == "env":
        samples = await asyncio.to_thread(
            render_ambience_performance, recipe, events, max_seconds,
            enabled if isinstance(enabled, list) else None,
            layer_samples,
        )
    else:
        samples = await asyncio.to_thread(render_session, recipe, events, max_seconds)
    return {"success": True, **_serve_recipe_audio(samples)}
