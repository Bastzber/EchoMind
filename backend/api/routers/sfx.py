# -*- coding: utf-8 -*-
"""sfx 域，从 main.py 拆出（AGENTS.md：新接口别继续堆那个文件）。
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

from api.routers import _deps as _d

logger = logging.getLogger(__name__)
router = APIRouter(tags=["sfx"])


def get_db_manager():
    return _d.call("get_db_manager")


def SoundBotAPIError(*a, **k):
    return _d.attr("SoundBotAPIError")(*a, **k)


def _get_project_index_lock(*a, **k):
    return _d.call("_get_project_index_lock", *a, **k)


def _get_project_searcher(*a, **k):
    return _d.call("_get_project_searcher", *a, **k)


async def _repair_index_task(*a, **k):
    return await _d.call("_repair_index_task", *a, **k)


def _wav_duration(*a, **k):
    return _d.call("_wav_duration", *a, **k)


@router.post("/api/v1/sfx/generate")
async def sfx_generate(request: Dict[str, Any]):
    """AI 生成音效（试听模式：写入临时文件，不直接入库）。

    入参: text_prompt(必填), format(wav/mp3/pcm/ogg_opus, 默认 mp3), sample_rate(默认 44100)
    返回: generation_id / audio_path(临时文件) / duration / size
    """
    from core.sfx_generator import generate_sfx, is_configured

    if not is_configured():
        raise SoundBotAPIError(
            "sfx_not_configured", "豆包语音 API Key 未配置，无法生成音效", status_code=400
        )
    text_prompt = (request.get("text_prompt") or "").strip()
    if not text_prompt:
        raise HTTPException(status_code=422, detail="text_prompt 不能为空")

    import tempfile
    import uuid as _uuid

    fmt = str(request.get("format", "mp3")).strip().lower()
    if fmt not in ("wav", "mp3", "pcm", "ogg_opus"):
        fmt = "mp3"
    try:
        sample_rate = int(request.get("sample_rate", 44100) or 44100)
    except (TypeError, ValueError):
        sample_rate = 44100
    try:
        audio, duration = await asyncio.to_thread(
            generate_sfx, text_prompt, sample_rate, fmt
        )
    except Exception as exc:
        logger.error("音效生成失败: %s", exc)
        raise HTTPException(status_code=502, detail=f"生成失败: {exc}")

    # 响度标准化：生成模型输出比音效库素材小 5~10 dB，用户每条都要手动 +6 dB。
    # 这里统一拉到 -16 LUFS、峰值不超过 -1 dBTP；解不开就原样返回，不阻断生成。
    from core import loudness as _loudness

    loud_stats: Dict[str, Any] = {}
    try:
        audio, loud_stats = await asyncio.to_thread(_loudness.normalize, audio)
        if loud_stats.get("normalized"):
            duration = await asyncio.to_thread(_wav_duration, audio) or duration
    except Exception as exc:
        logger.warning("音效响度标准化失败，保留原始输出: %s", exc)

    # 落稳定目录：原来写 %TEMP%，系统一清临时文件，历史里的「试听 / 保存到库」就全废了。
    gen_dir = (
        Path(os.environ.get("APPDATA") or tempfile.gettempdir())
        / "EchoMind" / "generated" / datetime.now().strftime("%Y%m%d")
    )
    gen_dir.mkdir(parents=True, exist_ok=True)
    gen_id = _uuid.uuid4().hex[:12]
    tmp_path = gen_dir / f"sfx_{gen_id}.wav"
    try:
        tmp_path.write_bytes(audio)
    except Exception as exc:
        logger.error("写入生成音效失败: %s", exc)
        raise HTTPException(status_code=502, detail=f"写入失败: {exc}")
    return {
        "generation_id": gen_id,
        "audio_path": str(tmp_path),
        "duration": duration,
        "size": len(audio),
        "text_prompt": text_prompt,
        "generated_dir": str(gen_dir),
        "loudness": loud_stats,
    }


@router.post("/api/v1/sfx/save")
async def sfx_save(request: Dict[str, Any], background_tasks: BackgroundTasks):
    """把试听过的生成音效保存到库目录并自动索引。

    入参: audio_path(必填，生成接口返回的临时文件), name(可选), tags(可选数组)
    """
    from core.sfx_generator import get_save_dir

    import shutil

    audio_path_str = str(request.get("audio_path") or "").strip()
    if not audio_path_str:
        raise HTTPException(status_code=422, detail="audio_path 不能为空")
    audio_path = Path(audio_path_str)
    if not audio_path.exists():
        raise HTTPException(status_code=404, detail="临时音频不存在，请重新生成")

    name = (request.get("name") or "").strip()
    tags = request.get("tags") or []
    if not isinstance(tags, list):
        tags = []
    if not name:
        name = "AI音效_" + datetime.now().strftime("%Y%m%d_%H%M%S")

    save_dir = get_save_dir()
    stem, suffix = name, audio_path.suffix or ".mp3"
    if not Path(stem).suffix:
        stem = stem + suffix
    save_path = save_dir / stem
    counter = 1
    while save_path.exists():
        p = Path(stem)
        save_path = save_dir / f"{p.stem}_{counter}{p.suffix}"
        counter += 1
    try:
        shutil.copy2(audio_path, save_path)
    except Exception as exc:
        logger.error("保存生成音效失败: %s", exc)
        raise HTTPException(status_code=502, detail=f"保存失败: {exc}")

    # 探测元数据
    duration, sample_rate, channels = 0.0, 0, 0
    try:
        from core.audio_service import get_audio_service

        info = await asyncio.to_thread(get_audio_service().probe, str(save_path))
        if info:
            duration = float(getattr(info, "duration", 0) or 0)
            sample_rate = int(getattr(info, "sample_rate", 0) or 0)
            channels = int(getattr(info, "channels", 0) or 0)
    except Exception as exc:
        logger.warning("探测生成音效元数据失败: %s", exc)

    size = save_path.stat().st_size
    db_manager = get_db_manager()
    current_project_id = getattr(config, "CURRENT_PROJECT_ID", "default")
    job_id = None
    async with _get_project_index_lock(current_project_id):
        db_manager.add_file_simple(
            str(save_path),
            save_path.name,
            duration,
            sample_rate,
            channels,
            size,
            tags=json.dumps(tags, ensure_ascii=False),
        )
        record = db_manager.get_file(str(save_path), current_project_id)
        if record:
            now = datetime.now().isoformat()
            db_manager.mark_artifacts_stale_for_file(
                current_project_id,
                record.file_uuid,
                ["waveform", "audio_vector", "text_vector"],
                now,
            )
            try:
                await _get_project_searcher(current_project_id).clear_cache()
            except Exception as exc:
                logger.debug(f"清理搜索缓存失败: {exc}")
            job_id = db_manager.create_job(current_project_id, "index_reconcile", 1)
            background_tasks.add_task(
                _repair_index_task,
                job_id,
                current_project_id,
                ["waveform", "audio_vector", "text_vector"],
                "reconcile",
            )
    return {
        "success": True,
        "file_path": str(save_path),
        "filename": save_path.name,
        "duration": duration,
        "job_id": job_id,
    }


@router.post("/api/v1/sfx/generated/rename")
async def sfx_generated_rename(request: Dict[str, Any]):
    """给生成好的音效改名（就地重命名，历史记录里的路径要跟着更新）。"""
    src = Path(str(request.get("path") or "").strip())
    new_name = str(request.get("name") or "").strip()
    if not src.is_file():
        raise HTTPException(status_code=404, detail="文件不存在")
    if not new_name:
        raise HTTPException(status_code=422, detail="新文件名不能为空")
    # 只允许改文件名，不允许带路径，避免越权写到别处
    if any(sep in new_name for sep in ("/", "\\")) or new_name in (".", ".."):
        raise HTTPException(status_code=422, detail="文件名不能包含路径分隔符")
    if not Path(new_name).suffix:
        new_name = new_name + src.suffix
    target = src.parent / new_name
    if target.resolve() == src.resolve():
        return {"success": True, "path": str(src), "name": src.name}
    if target.exists():
        raise HTTPException(status_code=409, detail="同名文件已存在")
    try:
        src.rename(target)
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"重命名失败: {exc}")
    return {"success": True, "path": str(target), "name": target.name}


@router.post("/api/v1/sfx/generated/reveal")
async def sfx_generated_reveal(request: Dict[str, Any]):
    """在资源管理器里定位生成文件（选中它）。"""
    path = Path(str(request.get("path") or "").strip())
    if not path.exists():
        raise HTTPException(status_code=404, detail="文件不存在")
    try:
        if os.name == "nt" and path.is_file():
            import subprocess

            subprocess.Popen(["explorer", "/select,", str(path)])
        else:
            os.startfile(str(path if path.is_dir() else path.parent))  # type: ignore[attr-defined]
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"打开目录失败: {exc}")
    return {"success": True}


@router.post("/api/v1/sfx/generated/delete")
async def sfx_generated_delete(request: Dict[str, Any]):
    """删除一个生成文件（只删生成目录里的，不碰库内素材）。"""
    path = Path(str(request.get("path") or "").strip())
    if not path.is_file():
        raise HTTPException(status_code=404, detail="文件不存在")
    base_dir = Path(os.environ.get("APPDATA") or tempfile.gettempdir()) / "EchoMind" / "generated"
    try:
        path.resolve().relative_to(base_dir.resolve())
    except ValueError:
        raise HTTPException(status_code=403, detail="只允许删除生成目录里的文件")
    try:
        path.unlink()
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"删除失败: {exc}")
    return {"success": True}


@router.get("/api/v1/sfx/config")
async def sfx_get_config():
    """获取音频生成（豆包语音）配置状态。"""
    from core.sfx_generator import is_configured, get_save_dir

    return {
        "success": True,
        "configured": is_configured(),
        "save_dir": str(get_save_dir()),
        "base_url": "https://openspeech.bytedance.com/api/v3/tts/create",
    }


@router.post("/api/v1/sfx/config")
async def sfx_save_config(request: Dict[str, Any]):
    """保存音频生成（豆包语音）配置。入参: api_key, save_dir(可选)。"""
    from core.sfx_generator import save_config

    api_key = str(request.get("api_key") or "").strip()
    save_dir = str(request.get("save_dir") or "").strip()
    save_config(api_key=api_key, save_dir=save_dir)
    return {"success": True, "message": "音频生成配置已保存"}
