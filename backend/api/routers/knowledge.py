# -*- coding: utf-8 -*-
"""知识包（描述包 + 两套向量）的导入导出域，从 main.py 拆出。"""
from __future__ import annotations

import os
import json
import time
import math
import asyncio
import logging
import tempfile
from pathlib import Path
from typing import Optional, List, Dict, Any, Mapping, Sequence, Tuple

from fastapi import APIRouter, BackgroundTasks, Body, HTTPException, Path as PathParam, Query
from fastapi.responses import FileResponse, JSONResponse, Response, StreamingResponse
from pydantic import BaseModel, Field

from core.errors import SoundBotAPIError
from core import task_flags

import config

import sys
import uuid
from datetime import datetime
from core.database import is_safe_project_id, canonicalize_path
from models import schemas

from api.routers import _deps as _d

logger = logging.getLogger(__name__)
router = APIRouter(tags=["knowledge"])


def get_db_manager():
    return _d.call("get_db_manager")


def _cfg():
    return _d.attr("config")


def _run_hash_backfill(*a, **k):
    return _d.call("_run_hash_backfill", *a, **k)


class KnowledgeImportRequest(BaseModel):
    """导入知识包（描述 + 标签 + 两套向量）。path 为空时自动找安装目录里的包。"""

    path: Optional[str] = None
    project_id: Optional[str] = None


class KnowledgeExportRequest(BaseModel):
    """导出知识包到指定路径。base_pack 给定时只导出新增文件 + 描述/标签变更的条目（增量包）。"""

    out_path: str
    project_id: Optional[str] = None
    base_pack: Optional[str] = None


_KNOWLEDGE_PACK_NAME = "EchoMind-知识包.zip"


def _knowledge_pack_candidates() -> List[str]:
    """按优先级列出可能的知识包位置（安装目录 / 用户数据目录）。"""
    candidates: List[str] = []
    try:
        # 后端 exe 在 win-unpacked/resources/backend/soundbot-backend/ 下，
        # 知识包放在 win-unpacked/ 根目录，所以要往上找几层。
        exe_dir = Path(sys.executable).resolve().parent
        for depth in range(0, 5):
            base = exe_dir.parents[depth - 1] if depth else exe_dir
            candidates.append(str(base / _KNOWLEDGE_PACK_NAME))
    except Exception:
        pass
    try:
        candidates.append(str(Path.cwd() / _KNOWLEDGE_PACK_NAME))
    except Exception:
        pass
    try:
        candidates.append(str(config.get_user_data_dir() / _KNOWLEDGE_PACK_NAME))
    except Exception:
        pass
    return candidates


async def _backfill_fts_slow(project_id: str, ids: List[str]) -> None:
    """慢速补全文索引：每 2000 条歇 0.3 秒，不跟界面抢磁盘。"""
    db_manager = get_db_manager()
    total = len(ids)
    done = 0
    for start in range(0, total, 2000):
        chunk = ids[start:start + 2000]
        try:
            await asyncio.to_thread(db_manager.update_fts_rows, project_id, chunk)
        except Exception as exc:
            logger.warning("[FTS] 补同步失败: %s", exc)
        done += len(chunk)
        await asyncio.sleep(0.3)
    logger.info("[FTS] 后台补同步完成: %d 条", done)


async def _knowledge_import_task(job_id: str, project_id: str, zip_path: Path) -> None:
    """后台导知识包：进度写进 job，前端轮询 /api/v1/jobs/{id}。"""
    import asyncio

    from core import knowledge_pack

    db_manager = get_db_manager()
    from core import heavy_task as _heavy

    # 排队等轮到自己（导入在跑时这里会等着，前端能看到队位）
    try:
        await asyncio.to_thread(_heavy.wait_turn, "knowledge_pack", 3600.0)
    except Exception as exc:
        db_manager.update_job(job_id, state="failed", error=str(exc)[:200])
        return
    db_manager.update_job(job_id, state="running", stage="unpacking")

    def progress(stage: str, done: int, total: int) -> None:
        try:
            db_manager.update_job(job_id, stage=stage, processed=int(done))
        except Exception:
            pass

    def cancelled() -> bool:
        try:
            job = db_manager.get_job(job_id)
            return bool(job and job.get("cancel_requested"))
        except Exception:
            return False

    try:
        report = await asyncio.to_thread(
            knowledge_pack.import_pack, db_manager, project_id, zip_path, progress, cancelled,
        )
        # 匹配数为 0 说明一个文件都没对上（多半是 sha256 还没算完），
        # 这不是「成功」：写进 stage 让前端明确提示，别报「索引已就绪」。
        # FTS 延后补：知识包导入时不同步全文索引（磁盘会满负荷），
        # 这里起一个慢速后台任务分批补，不挡界面。
        _fts_ids = ((report.get("metadata") or {}).get("fts_pending")) or []
        if _fts_ids:
            try:
                asyncio.create_task(_backfill_fts_slow(project_id, _fts_ids))
            except Exception as _exc:
                logger.debug("[KnowledgePack] FTS 补同步调度失败: %s", _exc)

        matched = int(((report.get("metadata") or {}).get("matched")) or 0)
        applied = int(((report.get("metadata") or {}).get("applied")) or 0)
        db_manager.update_job(
            job_id, state="completed",
            stage="done matched=%d applied=%d" % (matched, applied),
            processed=int(report.get("files") or 0),
            error_message=None if matched else "知识包没有匹配到任何文件",
        )
        logger.info("[KnowledgePack] 导入完成: %s", report)
    except knowledge_pack.KnowledgePackError as exc:
        db_manager.update_job(job_id, state="failed", stage="error", error_message=str(exc)[:300])
        logger.warning("[KnowledgePack] 导入失败: %s", exc)
    except Exception as exc:
        db_manager.update_job(job_id, state="failed", stage="error", error_message=str(exc)[:300])
        logger.error("[KnowledgePack] 导入异常: %s", exc)
    finally:
        from core import task_flags as _flags

        _flags.set_knowledge_import_running(False)
        _heavy.leave("knowledge_pack")


async def _knowledge_export_task(
    job_id: str, project_id: str, out_path: Path, base_pack: Optional[Path] = None
) -> None:
    import asyncio

    from core import knowledge_pack

    db_manager = get_db_manager()
    db_manager.update_job(job_id, state="running", stage="exporting")

    def progress(stage: str, done: int, total: int) -> None:
        try:
            db_manager.update_job(job_id, stage=stage, processed=int(done))
        except Exception:
            pass

    # 知识包按 sha256 装条目，没算完哈希的文件会被漏掉（用户 11-01 17:4x：
    # 导出的包缺 573 条，导入方永远差这 573 个）。导出前先补算哈希。
    try:
        with db_manager.get_cursor() as cursor:
            missing_hash = cursor.execute(
                "SELECT COUNT(*) FROM files WHERE project_id=? "
                "AND (sha256 IS NULL OR sha256='')",
                (project_id,),
            ).fetchone()[0]
        if missing_hash:
            logger.info("[KnowledgePack] 导出前补算 %d 个文件哈希", missing_hash)
            db_manager.update_job(job_id, stage="hashing", processed=0, total=missing_hash)
            await _run_hash_backfill(project_id)
    except Exception as exc:
        logger.warning("[KnowledgePack] 导出前补算哈希失败: %s", exc)

    try:
        report = await asyncio.to_thread(
            knowledge_pack.export_pack, db_manager, project_id, out_path, progress, base_pack,
        )
        db_manager.update_job(
            job_id, state="completed",
            stage="done new=%d changed=%d" % (
                int(report.get("new_files") or 0),
                int(report.get("changed_files") or 0),
            ),
            processed=int(report.get("files") or 0),
            error_message=None,
        )
        logger.info("[KnowledgePack] 导出完成: %s", report)
    except knowledge_pack.KnowledgePackError as exc:
        db_manager.update_job(job_id, state="failed", stage="error", error_message=str(exc)[:300])
        logger.warning("[KnowledgePack] 导出失败: %s", exc)
    except Exception as exc:
        db_manager.update_job(job_id, state="failed", stage="error", error_message=str(exc)[:300])
        logger.error("[KnowledgePack] 导出异常: %s", exc)


@router.get("/api/v1/knowledge/available")
async def knowledge_pack_available():
    """检测安装目录里有没有内置知识包（首次启动提示用）。"""
    from core import knowledge_pack

    for candidate in _knowledge_pack_candidates():
        path = Path(candidate)
        if not path.is_file():
            continue
        try:
            info = knowledge_pack.inspect_pack(path)
        except Exception as exc:
            logger.warning("[KnowledgePack] 检查 %s 失败: %s", path, exc)
            continue
        return {"success": True, "available": True, "path": str(path), **info}
    return {"success": True, "available": False}


@router.post("/api/v1/knowledge/import")
async def knowledge_pack_import(payload: KnowledgeImportRequest, background_tasks: BackgroundTasks):
    """导入知识包：写描述/标签 + 导入两套向量，一个任务跑完。"""
    from core import knowledge_pack

    from core import task_flags

    # 同时开两个知识包任务会互相抢写锁，看起来就是「进度不动」（11-01 19:49 用户选了两次包）。
    if task_flags.knowledge_import_running():
        raise HTTPException(
            status_code=409,
            detail="已有知识包正在导入，等它跑完再导第二个",
        )

    zip_path = (payload.path or "").strip()
    if not zip_path:
        for candidate in _knowledge_pack_candidates():
            if Path(candidate).is_file():
                zip_path = candidate
                break
    if not zip_path:
        raise HTTPException(status_code=404, detail="没找到知识包（%s）" % _KNOWLEDGE_PACK_NAME)
    try:
        info = knowledge_pack.inspect_pack(Path(zip_path))
    except knowledge_pack.KnowledgePackError as exc:
        raise HTTPException(status_code=422, detail=str(exc))

    project_id = payload.project_id or getattr(config, "CURRENT_PROJECT_ID", "default")
    db_manager = get_db_manager()
    job_id = db_manager.create_job(project_id, "knowledge_import", int(info.get("files") or 0))
    task_flags.set_knowledge_import_running(True)
    background_tasks.add_task(_knowledge_import_task, job_id, project_id, Path(zip_path))
    return {
        "success": True,
        "job_id": job_id,
        "path": zip_path,
        "files": info.get("files"),
        "kinds": info.get("kinds"),
        "size_mb": info.get("size_mb"),
    }


@router.post("/api/v1/knowledge/export")
async def knowledge_pack_export(payload: KnowledgeExportRequest, background_tasks: BackgroundTasks):
    """把当前库导出成知识包（描述 + 标签 + 两套向量）。"""
    out_path = (payload.out_path or "").strip()
    if not out_path:
        raise HTTPException(status_code=422, detail="out_path 不能为空")
    project_id = payload.project_id or getattr(config, "CURRENT_PROJECT_ID", "default")
    db_manager = get_db_manager()
    file_count = db_manager.get_file_count(project_id)
    base_pack = (payload.base_pack or "").strip()
    if base_pack and not Path(base_pack).is_file():
        raise HTTPException(status_code=404, detail=f"基线包不存在: {base_pack}")
    job_id = db_manager.create_job(project_id, "knowledge_export", int(file_count or 0))
    background_tasks.add_task(
        _knowledge_export_task,
        job_id, project_id, Path(out_path),
        Path(base_pack) if base_pack else None,
    )
    return {
        "success": True,
        "job_id": job_id,
        "out_path": out_path,
        "files": file_count,
        "base_pack": base_pack or None,
    }
