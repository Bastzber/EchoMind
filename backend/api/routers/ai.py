# -*- coding: utf-8 -*-
"""ai 域，从 main.py 拆出（AGENTS.md：新接口别继续堆那个文件）。
"""
from __future__ import annotations

import os
import json
import time
import math
import asyncio
import logging
from pathlib import Path
from typing import Optional, List, Dict, Any, Mapping, Sequence, Tuple

from fastapi import APIRouter, BackgroundTasks, HTTPException, Path as PathParam, Query
from fastapi.responses import FileResponse, JSONResponse, Response, StreamingResponse
from pydantic import BaseModel, Field

from core.errors import SoundBotAPIError

import tempfile
import sys
import uuid
from datetime import datetime
from core.database import is_safe_project_id, canonicalize_path
from models import schemas
import config

from api.routers import _deps as _d

logger = logging.getLogger(__name__)
router = APIRouter(tags=["ai"])


def get_db_manager():
    return _d.call("get_db_manager")


def _cfg():
    return _d.attr("config")


async def _repair_index_task(*a, **k):
    return await _d.call("_repair_index_task", *a, **k)


def _text_embedding_config_signature(*a, **k):
    return _d.call("_text_embedding_config_signature", *a, **k)


async def get_all_projects(*a, **k):
    return await _d.call("get_all_projects", *a, **k)


async def get_project(*a, **k):
    return await _d.call("get_project", *a, **k)



@router.post("/api/v1/ai/chat")
async def ai_chat(request: schemas.AIChatRequest):
    """
    AI 对话 - 自然语言搜索
    
    支持流式响应，前端需要使用 EventSource 接收。
    
    请求格式：
    - **message**: 用户消息
    - **history**: 对话历史（可选）
    - **top_k**: 返回结果数量（默认 20）
    - **threshold**: 相似度阈值（默认 0.1）
    
    SSE 流式响应：
    - thinking: 正在分析
    - analyzing: 分析完成
    - searching: 正在搜索
    - results: 搜索结果
    - error: 错误
    - done: 完成
    """
    from core.ai_chat_service import get_ai_chat_service, stream_to_sse
    
    try:
        project_id = request.project_id or "default"
        db_manager = get_db_manager()
        if not is_safe_project_id(project_id) or not db_manager.get_project(project_id):
            raise SoundBotAPIError(
                "project_not_found", "工程不存在", status_code=404,
                details={"project_id": project_id},
            )
        chat_service = get_ai_chat_service(project_id)
        
        return StreamingResponse(
            stream_to_sse(chat_service.chat(
                message=request.message,
                conversation_history=request.history,
                top_k=request.top_k,
                threshold=request.threshold,
                project_id=project_id,
            )),
            media_type="text/event-stream",
            headers={
                "Cache-Control": "no-cache",
                "Connection": "keep-alive",
                "X-Accel-Buffering": "no"
            }
        )
    except SoundBotAPIError:
        raise
    except Exception as e:
        logger.error(f"AI Chat 请求失败: {e}")
        import traceback
        logger.error(f"详细错误: {traceback.format_exc()}")
        raise HTTPException(status_code=500, detail=f"AI 服务暂时不可用: {str(e)}")


@router.get("/api/v1/ai/config")
async def get_ai_config():
    """
    获取 AI 配置
    
    返回当前 LLM 和 Embedding 的配置
    """
    try:
        from core.llm_config_manager import get_llm_config_manager
        
        config_manager = get_llm_config_manager()
        
        return {
            "success": True,
            "llm": {
                "provider": config_manager.get_llm_provider(),
                "config": config_manager.get_public_llm_config(),
                "available_services": config_manager.detect_available_local_services()
            },
            "embedding": {
                "provider": config_manager.get_embedding_provider(),
                "config": config_manager.get_public_embedding_config()
            }
        }
    except Exception as e:
        logger.error(f"获取 AI 配置失败: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/api/v1/ai/config")
async def save_ai_config(
    request: schemas.AIConfigRequest,
    background_tasks: BackgroundTasks,
):
    """
    保存 AI 配置
    
    - **llm_provider**: LLM 提供者 (lm_studio/ollama/external)
    - **llm_config**: LLM 提供者配置
    - **embedding_provider**: Embedding 提供者 (default/local/external)
    - **embedding_config**: Embedding 提供者配置
    """
    try:
        from core.llm_config_manager import get_llm_config_manager
        from core.llm_client import reset_llm_client
        from core.ai_chat_service import reset_ai_chat_service
        from core.search_engine import reset_optimized_searcher
        
        config_manager = get_llm_config_manager()
        old_embedding = config_manager.get_embedding_config()
        old_provider = config_manager.get_embedding_provider()
        old_signature = _text_embedding_config_signature(
            old_provider, old_embedding.get(old_provider, {})
        )
        
        config_manager.save_full_config(
            llm_provider=request.llm_provider,
            llm_config=request.llm_config,
            embedding_provider=request.embedding_provider,
            embedding_config=request.embedding_config
        )

        new_embedding = config_manager.get_embedding_config()
        new_provider = config_manager.get_embedding_provider()
        new_signature = _text_embedding_config_signature(
            new_provider, new_embedding.get(new_provider, {})
        )
        stale_projects = []
        if old_signature != new_signature:
            try:
                db_manager = get_db_manager()
                for project in db_manager.get_all_projects():
                    project_id = project["id"]
                    changed = db_manager.mark_project_artifacts(
                        project_id, ["text_vector"], "stale"
                    )
                    db_manager.upsert_index_manifest(
                        project_id,
                        "text_vector",
                        engine_fingerprint=new_signature,
                        state="stale",
                        revision_increment=1,
                    )
                    reset_optimized_searcher(project_id)
                    job_id = db_manager.create_job(
                        project_id, "index_rebuild", changed
                    )
                    background_tasks.add_task(
                        _repair_index_task,
                        job_id,
                        project_id,
                        ["text_vector"],
                        "rebuild",
                    )
                    stale_projects.append({
                        "project_id": project_id,
                        "files": changed,
                        "job_id": job_id,
                    })
            except Exception as index_error:
                # Metadata/credential saving already succeeded.  Do not make
                # Electron roll back its secure-store transaction; report the
                # index invalidation problem without including config values.
                logger.exception("文本索引失效标记失败: %s", index_error)
                stale_projects.append({
                    "project_id": None,
                    "files": 0,
                    "error": "text_index_invalidation_failed",
                })
        
        # 重置 LLM 客户端和 AI Chat 服务以应用新配置
        reset_llm_client()
        reset_ai_chat_service()
        
        return {
            "success": True,
            "message": "配置已保存",
            "text_index_stale": stale_projects,
        }
    except Exception as e:
        logger.error(f"保存 AI 配置失败: {e}")
        raise HTTPException(status_code=500, detail="保存配置失败，请检查日志")


@router.post("/api/v1/ai/config/test")
async def test_ai_config(request: schemas.AIConfigRequest):
    """
    测试 AI 配置连接
    
    - **llm_provider**: LLM 提供者
    - **llm_config**: LLM 提供者配置
    - **embedding_provider**: Embedding 提供者
    - **embedding_config**: Embedding 提供者配置
    """
    try:
        from core.llm_config_manager import get_llm_config_manager
        
        config_manager = get_llm_config_manager()
        
        # 测试 LLM 连接
        llm_result = await config_manager.test_llm_connection(
            provider=request.llm_provider,
            provider_config=request.llm_config
        )
        
        # 测试 Embedding 连接
        embedding_result = await config_manager.test_embedding_connection(
            provider=request.embedding_provider,
            provider_config=request.embedding_config
        )
        
        return {
            "success": llm_result.get("success", False) and embedding_result.get("success", False),
            "llm": llm_result,
            "embedding": embedding_result
        }
    except Exception as e:
        logger.error(f"测试 AI 配置失败: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/api/v1/ai/status")
async def get_ai_status():
    """
    获取 AI 服务状态
    
    返回 LLM 和 Embedding 的可用状态
    """
    try:
        from core.llm_config_manager import get_llm_config_manager
        from core.llm_client import get_llm_client
        from core.embedder import is_embedder_available
        
        config_manager = get_llm_config_manager()
        
        # 检查 LLM 可用性
        llm_available = False
        llm_provider = config_manager.get_llm_provider()
        available_services = config_manager.detect_available_local_services()
        
        if llm_provider == "lm_studio":
            llm_available = available_services.get("lm_studio", False)
        elif llm_provider == "ollama":
            llm_available = available_services.get("ollama", False)
        else:
            # 外部 API，尝试连接
            try:
                llm_client = get_llm_client()
                llm_available = llm_client.is_available
            except:
                llm_available = False
        
        # 检查 Embedding 可用性
        embedding_available = is_embedder_available()
        
        return {
            "success": True,
            "llm": {
                "available": llm_available,
                "provider": llm_provider
            },
            "embedding": {
                "available": embedding_available,
                "provider": config_manager.get_embedding_provider()
            }
        }
    except Exception as e:
        logger.error(f"获取 AI 状态失败: {e}")
        raise HTTPException(status_code=500, detail=str(e))
