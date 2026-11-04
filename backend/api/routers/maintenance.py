# -*- coding: utf-8 -*-
"""maintenance 域，从 main.py 拆出（AGENTS.md：新接口别继续堆那个文件）。
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
router = APIRouter(tags=["maintenance"])


def get_db_manager():
    return _d.call("get_db_manager")


def SoundBotAPIError(*a, **k):
    return _d.attr("SoundBotAPIError")(*a, **k)


async def _backfill_durations_task(*a, **k):
    return await _d.call("_backfill_durations_task", *a, **k)


async def get_project(*a, **k):
    return await _d.call("get_project", *a, **k)


@router.post("/api/v1/maintenance/prune-collections")
async def prune_empty_collections(
    project_id: str = Query(default="default"),
    dry_run: bool = Query(default=False),
):
    """删除「没有被 manifest 引用、且里面 0 条向量」的集合（空壳清理）。

    重建索引时会不断产生新的 shadow 集合，旧的那代被切走后如果是空的，
    就永远不会再被用到，只会占着目录。
    """
    from core.indexer import get_chroma_client, safe_project_chroma_path

    db_manager = get_db_manager()
    if not db_manager.get_project(project_id):
        raise SoundBotAPIError("project_not_found", "工程不存在", status_code=404)

    with db_manager.get_cursor() as cursor:
        active = {
            str(row[0])
            for row in cursor.execute(
                "SELECT collection_name FROM index_manifests WHERE project_id=? AND state='ready'",
                (project_id,),
            ).fetchall()
        }

    client = get_chroma_client(str(safe_project_chroma_path(project_id, create=False)))
    removed, kept = [], []
    for item in client.list_collections():
        name = getattr(item, "name", str(item))
        if name in active:
            kept.append({"name": name, "reason": "active"})
            continue
        try:
            count = client.get_collection(name).count()
        except Exception as exc:
            kept.append({"name": name, "reason": f"read_failed: {exc}"})
            continue
        if count > 0:
            kept.append({"name": name, "reason": f"has {count} vectors"})
            continue
        removed.append(name)
        if not dry_run:
            try:
                client.delete_collection(name)
            except Exception as exc:
                logger.warning("[Prune] 删除集合 %s 失败: %s", name, exc)
    logger.info("[Prune] 删除空集合 %d 个，保留 %d 个", len(removed), len(kept))
    return {
        "success": True,
        "dry_run": dry_run,
        "removed": removed,
        "kept": kept,
    }


@router.post("/api/v1/maintenance/backfill-durations")
async def backfill_durations(
    project_id: str = Query(default="default"),
    background_tasks: BackgroundTasks = None,
):
    """回填缺失的时长 / 采样率 / 声道。

    历史库里有大量行这几列是 0（导入时没探测或从旧备份恢复），界面上显示 00:00。
    这里用真正的音频探针重算一遍，按批写回。
    """
    db_manager = get_db_manager()
    with db_manager.get_cursor() as cursor:
        missing = cursor.execute(
            "SELECT COUNT(*) FROM files WHERE project_id=? AND (duration <= 0 OR sample_rate <= 0)",
            (project_id,),
        ).fetchone()[0]
    if not missing:
        return {"success": True, "missing": 0, "message": "没有需要回填的文件"}

    job_id = db_manager.create_job(project_id, "backfill_durations", int(missing))
    background_tasks.add_task(_backfill_durations_task, job_id, project_id)
    return {"success": True, "job_id": job_id, "missing": int(missing)}


@router.post("/api/v1/maintenance/decode-test")
async def decode_test(path: str = Query(...)):
    """诊断：对一个文件跑完整解码链路，返回每层的结果/异常。

    PyAV 失败时用 miniaudio 兜底，但打包环境里兜底是否生效看不出来——
    这个接口把每层的异常原样返回，省得靠猜。
    """
    from core.audio_service import get_audio_service

    from pathlib import Path as _Path

    # 边界：path 来自查询参数，谁都能传。不加限制的话，这个接口就是
    # 「对机器上任意文件跑一遍完整解码链路」的入口（CPU/内存都能被拉满）。
    from core.path_guard import is_inside as _path_is_inside

    try:
        _roots = get_db_manager().list_library_roots(getattr(config, "CURRENT_PROJECT_ID", "default"))
    except Exception:
        _roots = []
    if not _path_is_inside(path, _roots):
        raise HTTPException(status_code=403, detail="只允许诊断素材库内的文件：" + str(path))

    source = _Path(path)
    if not source.is_file():
        raise HTTPException(status_code=404, detail="文件不存在")
    service = get_audio_service()
    report: Dict[str, Any] = {'path': str(source), 'steps': {}}

    try:
        info = await asyncio.to_thread(service.probe, str(source))
        report['steps']['probe'] = {'ok': True, 'duration': info.duration, 'codec': info.codec}
    except Exception as exc:
        report['steps']['probe'] = {'ok': False, 'error': repr(exc)[:200]}

    try:
        decoded = await asyncio.to_thread(service.decode, str(source))
        report['steps']['decode'] = {'ok': True, 'duration': decoded.duration, 'samples': int(decoded.samples.size)}
    except Exception as exc:
        report['steps']['decode'] = {'ok': False, 'error': repr(exc)[:200]}

    try:
        wave = await asyncio.to_thread(service.waveform, str(source))
        report['steps']['waveform'] = {'ok': True, 'peaks': len(wave.peaks), 'duration': wave.duration}
    except Exception as exc:
        report['steps']['waveform'] = {'ok': False, 'error': repr(exc)[:200]}

    try:
        import miniaudio

        report['miniaudio_import'] = getattr(miniaudio, '__version__', 'ok')
        direct = service._decode_with_miniaudio(source, None, True)
        report['steps']['miniaudio_direct'] = bool(direct)
        stripped = service._strip_id3_tail(source)
        report['steps']['id3_stripped'] = bool(stripped)
        if stripped is not None:
            via_strip = service._decode_with_miniaudio(stripped, None, True)
            report['steps']['miniaudio_stripped'] = {'ok': bool(via_strip), 'samples': int(via_strip.samples.size) if via_strip else 0}
            try:
                stripped.unlink()
            except OSError:
                pass
    except Exception as exc:
        report['miniaudio_error'] = repr(exc)[:200]

    return report
