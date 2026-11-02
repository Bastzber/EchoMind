# -*- coding: utf-8 -*-
"""一句话描述的批量生成、导入导出。

从 main.py 拆出（AGENTS.md：新接口别继续堆那个文件）。
"""
from __future__ import annotations

import logging

from fastapi import APIRouter, HTTPException, Query, BackgroundTasks

logger = logging.getLogger(__name__)
router = APIRouter(tags=["descriptions"])

from typing import Any, Dict, List, Optional  # noqa: E402
from fastapi import BackgroundTasks, Query  # noqa: E402

import os
import json
import time
import math
import asyncio
import tempfile
import sys
import uuid
from datetime import datetime
from pathlib import Path
from core.database import is_safe_project_id, canonicalize_path
from models import schemas
import config

from api.routers import _deps as _d  # noqa: E402


# ---- 主模块里还没搬过来的东西：运行时取，避免循环 import ----
def get_db_manager():
    return _d.call("get_db_manager")


async def _deferred_reconcile(*args: Any, **kwargs: Any):
    return _d.call("_deferred_reconcile", *args, **kwargs)


async def _repair_index_task(*args: Any, **kwargs: Any):
    return _d.call("_repair_index_task", *args, **kwargs)


def _get_project_searcher(*args: Any, **kwargs: Any):
    return _d.call("_get_project_searcher", *args, **kwargs)


def _detect_library_root(*args: Any, **kwargs: Any):
    return _d.call("_detect_library_root", *args, **kwargs)


def _relative_to_root(*args: Any, **kwargs: Any):
    return _d.call("_relative_to_root", *args, **kwargs)


def _get_current_project_id() -> str:
    return str(getattr(_d.attr("config"), "CURRENT_PROJECT_ID", "default"))


class _SoundBotAPIErrorProxy:
    """SoundBotAPIError 在主模块里；按需转发，保留原有调用写法。"""

    def __call__(self, *args, **kwargs):
        return _d.attr("SoundBotAPIError")(*args, **kwargs)

    def __instancecheck__(self, instance):
        return isinstance(instance, _d.attr("SoundBotAPIError"))


SoundBotAPIError = _SoundBotAPIErrorProxy()



@router.get("/api/v1/descriptions/stats")
async def ai_description_stats():
    """AI 一句话描述完成统计（批量生成进度用）。"""
    db_manager = get_db_manager()
    current_project_id = getattr(config, 'CURRENT_PROJECT_ID', 'default')
    stats = db_manager.ai_description_stats(current_project_id)
    return {"success": True, **stats}


@router.post("/api/v1/descriptions/batch")
async def batch_generate_descriptions(
    payload: schemas.DescriptionBatchRequest,
    background_tasks: BackgroundTasks,
):
    """批量生成 AI 一句话描述（断点续跑：只处理尚无描述的文件）。

    描述写入 files.ai_description 并标记 text_vector 为 stale，
    随后由 _repair_index_task 重建文本索引，使描述可被语义/关键词搜索命中。
    """
    from core.llm_client import get_llm_client

    db_manager = get_db_manager()
    current_project_id = getattr(config, 'CURRENT_PROJECT_ID', 'default')
    if current_project_id in _projects_deleting():
        raise SoundBotAPIError("project_deleting", "工程正在删除", status_code=409)

    pending = db_manager.list_missing_ai_descriptions(
        current_project_id, payload.limit
    )
    if not pending:
        stats = db_manager.ai_description_stats(current_project_id)
        all_done = stats["remaining"] == 0 and stats.get("auto_count", 0) == 0
        return {
            "success": True,
            "processed": 0,
            "succeeded": 0,
            "failed": 0,
            "remaining": stats["remaining"],
            "auto_count": stats.get("auto_count", 0),
            "done": all_done,
        }

    client = get_llm_client()
    if not getattr(client, "is_available", True):
        raise HTTPException(status_code=400, detail="LLM 未配置，请在设置中配置 LLM API")

    semaphore = asyncio.Semaphore(40)

    async def _generate_one(record: Dict[str, Any]) -> bool:
        filename = str(record.get("filename") or Path(record.get("path", "")).name)
        system = (
            "你是音效库管理员。只输出最终的一句话描述，"
            "不要分析、不要解释、不要复述任务。"
        )
        user = (
            "用一句简体中文（不超过25字）描述这个音效的声音内容。"
            "只输出这句话本身，不要引号、不要思考过程。\n"
            f"文件名：{filename}"
        )
        async with semaphore:
            try:
                chunks: List[str] = []
                async for chunk in client.chat(
                    messages=[{"role": "user", "content": user}],
                    system_prompt=system,
                    temperature=0.3,
                    # 推理型模型（DeepSeek V4 Flash）会先消耗预算思考，
                    # 给足 800 才能保证最终答案非空。
                    max_tokens=800,
                    stream=False,
                ):
                    if chunk["type"] == "content":
                        chunks.append(chunk["content"])
                description = "".join(chunks).strip().strip('"\'“”‘’《》').strip()
                # 只保留第一句，并丢弃明显是思考过程的内容
                description = description.splitlines()[0].strip() if description else ""
                if len(description) > 60 or any(
                    k in description for k in ("用户要求", "任务：", "The user", "我们需要", "无法判断")
                ):
                    logger.warning("描述内容异常，丢弃: %s -> %.40s", filename, description)
                    return False
                if not description:
                    logger.warning("生成描述为空: %s", filename)
                    return False
                return db_manager.update_ai_description(
                    str(record["path"]), description, current_project_id
                )
            except Exception as exc:
                logger.warning("生成描述失败 %s: %s", filename, exc)
                return False

    results = await asyncio.gather(*[_generate_one(r) for r in pending])
    succeeded = sum(1 for ok in results if ok)
    stats = db_manager.ai_description_stats(current_project_id)

    # 仅当全部完成（无描述=0 且无兜底待精修）时触发文本索引重建，
    # 避免每批都全量 reconcile 拖慢批量流程。未完成时描述已写入 DB
    # 并标记 stale，下次批次结束时统一重建。
    job_id = None
    all_done = stats["remaining"] == 0 and stats.get("auto_count", 0) == 0
    if all_done:
        job_id = db_manager.create_job(current_project_id, "text_metadata_refresh", 1)
        background_tasks.add_task(
            _repair_index_task,
            job_id,
            current_project_id,
            ["text_vector"],
            "reconcile",
        )
    return {
        "success": True,
        "processed": len(pending),
        "succeeded": succeeded,
        "failed": len(pending) - succeeded,
        "remaining": stats["remaining"],
        "auto_count": stats.get("auto_count", 0),
        "done": all_done,
        "job_id": job_id,
    }


@router.post("/api/v1/descriptions/generate")
async def generate_one_description(
    payload: schemas.DescriptionGenerateRequest,
    background_tasks: BackgroundTasks,
):
    """为单个音效生成一句话描述（右键菜单用）。"""
    from core.llm_client import get_llm_client

    db_manager = get_db_manager()
    current_project_id = getattr(config, 'CURRENT_PROJECT_ID', 'default')
    record = db_manager.get_file(payload.path, current_project_id)
    if not record:
        raise HTTPException(status_code=404, detail="文件不存在")

    filename = Path(payload.path).name
    client = get_llm_client()
    if not getattr(client, "is_available", True):
        raise HTTPException(status_code=400, detail="LLM 未配置，请在设置中配置 LLM API")
    system = "你是音频素材库管理员，擅长根据音效文件名准确判断声音内容。"
    user = (
        "请用一句简体中文（不超过25字）自然描述这个音效的声音内容。"
        "直接输出描述本身，不要加引号、书名号或多余解释。\n"
        f"音效文件名：{filename}"
    )
    chunks: List[str] = []
    try:
        async for chunk in client.chat(
            messages=[{"role": "user", "content": user}],
            system_prompt=system,
            temperature=0.3,
            max_tokens=60,
            stream=False,
        ):
            if chunk["type"] == "content":
                chunks.append(chunk["content"])
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"生成描述失败: {exc}")
    description = "".join(chunks).strip().strip('"\'“”‘’《》')
    if not description:
        raise HTTPException(status_code=500, detail="LLM 未返回有效描述")

    db_manager.update_ai_description(payload.path, description, current_project_id)
    job_id = db_manager.create_job(current_project_id, "text_metadata_refresh", 1)
    background_tasks.add_task(
        _repair_index_task,
        job_id,
        current_project_id,
        ["text_vector"],
        "reconcile",
    )
    return {"success": True, "description": description, "job_id": job_id}


@router.get("/api/v1/descriptions/export")
async def export_descriptions(project_id: str = Query(default="default")):
    """导出一句话描述包：按「相对库根的路径」组织，换机器/换盘也能匹配。"""
    try:
        db_manager = get_db_manager()
        with db_manager.get_cursor() as cursor:
            rows = cursor.execute(
                "SELECT path, filename, ai_description, tags FROM files WHERE project_id=?",
                (project_id,),
            ).fetchall()
        root = _detect_library_root([r["path"] for r in rows])
        items = []
        for row in rows:
            description = str(row["ai_description"] or "")
            if not description or description.startswith("[auto]"):
                continue
            items.append({
                "rel": _relative_to_root(row["path"], root),
                "filename": row["filename"],
                "description": description,
                "tags": row["tags"] or "[]",
            })
        return {
            "success": True,
            "version": 1,
            "root": root,
            "count": len(items),
            "items": items,
        }
    except Exception as exc:
        logger.error("导出描述包失败: %s", exc)
        raise HTTPException(status_code=500, detail=str(exc))


@router.post("/api/v1/descriptions/import")
async def import_descriptions(
    payload: Dict[str, Any],
    background_tasks: BackgroundTasks,
    project_id: str = Query(default="default"),
):
    """导入描述包：按相对路径（大小写不敏感）匹配，套用到当前库。"""
    from core.metadata_pack import apply as run_apply

    try:
        items = payload.get("items") or []
        if not isinstance(items, list) or not items:
            raise SoundBotAPIError("empty_pack", "描述包为空", status_code=400)

        db_manager = get_db_manager()
        with db_manager.get_cursor() as cursor:
            rows = cursor.execute(
                "SELECT file_uuid, path, filename FROM files WHERE project_id=?",
                (project_id,),
            ).fetchall()
        root = _detect_library_root([r["path"] for r in rows])
        by_rel = {}
        by_name = {}
        for row in rows:
            rel = _relative_to_root(row["path"], root).lower()
            by_rel[rel] = row["file_uuid"]
            by_name.setdefault(str(row["filename"]).lower(), []).append(row["file_uuid"])

        applied = 0
        matched = 0
        pairs: List[Dict[str, Any]] = []
        unmatched: List[Dict[str, str]] = []
        for item in items:
            description = str(item.get("description") or "").strip()
            # 标签包里可能只有 tags/user_tags、没有描述（B9）。以前这里直接
            # continue，整包标签被丢弃，界面上还显示「导入成功 0 条」。
            item_tags = item.get("tags")
            item_user_tags = item.get("user_tags")
            has_tags = bool(item_tags) or bool(item_user_tags)
            if not description and not has_tags:
                unmatched.append({
                    "rel": str(item.get("rel") or ""),
                    "filename": str(item.get("filename") or ""),
                    "reason": "empty_description",
                    "description": "",
                })
                continue
            rel = str(item.get("rel") or "").replace("/", "\\").lower()
            uuid_value = by_rel.get(rel)
            reason = "no_match"
            if not uuid_value:
                candidates = by_name.get(str(item.get("filename") or "").lower()) or []
                uuid_value = candidates[0] if len(candidates) == 1 else None
                if not uuid_value and len(candidates) > 1:
                    reason = "ambiguous"
                elif uuid_value:
                    reason = "matched_by_name"
            if not uuid_value:
                unmatched.append({
                    "rel": str(item.get("rel") or ""),
                    "filename": str(item.get("filename") or ""),
                    "reason": reason,
                    "description": description,
                })
                continue
            matched += 1
            # 先攒起来，最后统一走 metadata_pack.apply 的分批写入（含标签合并）。
            # 逐条 commit + 逐条刷 FTS 就是 database is locked 的来源。
            pairs.append({
                "file_uuid": uuid_value,
                "description": description,
                "tags": item_tags,
                # user_tags 走 tags/file_tags 两层表，和 files.tags 不是一回事
                "user_tags": item_user_tags,
            })
        if pairs:
            try:
                write_result = await asyncio.to_thread(
                    run_apply, project_id, pairs, False
                )
                applied = int(write_result.get("applied") or 0)
            except Exception as write_error:
                logger.exception("描述包批量写入失败: %s", write_error)
                raise
        logger.info("描述包导入完成: 匹配 %d / 应用 %d / 未匹配 %d / 包内 %d",
                    matched, applied, len(unmatched), len(items))

        unmatched_csv = ""
        if unmatched:
            try:
                from core.reports import write_unmatched_csv

                unmatched_csv = write_unmatched_csv(unmatched, prefix="desc-unmatched")
                logger.info("未匹配清单已导出: %s（%d 条）", unmatched_csv, len(unmatched))
            except Exception as exc:
                logger.warning("导出未匹配清单失败: %s", exc)

        # 描述变了，文本向量要按新描述重建，否则搜索用不上新内容。
        job_id = None
        if applied:
            try:
                from core.search_engine import reset_optimized_searcher

                db_manager.mark_project_artifacts(project_id, ["text_vector"], "stale")
                db_manager.upsert_index_manifest(
                    project_id, "text_vector", state="stale", revision_increment=1
                )
                reset_optimized_searcher(project_id)
                job_id = db_manager.create_job(project_id, "text_metadata_refresh", applied)
                background_tasks.add_task(
                    _repair_index_task,
                    job_id,
                    project_id,
                    ["text_vector"],
                    "reconcile",
                )
                logger.info("描述包导入后已排队重建文本索引: job=%s", job_id)
            except Exception as index_error:
                logger.exception("描述包导入后重建文本索引失败: %s", index_error)

        return {
            "success": True,
            "matched": matched,
            "applied": applied,
            "pack": len(items),
            "unmatched": len(unmatched),
            "unmatched_csv": unmatched_csv,
            "index_job_id": job_id,
        }
    except SoundBotAPIError:
        raise
    except Exception as exc:
        logger.error("导入描述包失败: %s", exc)
        raise HTTPException(status_code=500, detail=str(exc))


def _projects_deleting():
    return _d.attr("_projects_deleting")
