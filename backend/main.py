# -*- coding: utf-8 -*-
# SoundBot - AI 音效管理器
# Copyright (C) 2026 Nagisa_Huckrick (胡杨)
#
# This program is free software: you can redistribute it and/or modify
# it under the terms of the GNU General Public License as published by
# the Free Software Foundation, either version 3 of the License, or
# (at your option) any later version.
#
# This program is distributed in the hope that it will be useful,
# but WITHOUT ANY WARRANTY; without even the implied warranty of
# MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
# GNU General Public License for more details.
#
# You should have received a copy of the GNU General Public License
# along with this program.  If not, see <https://www.gnu.org/licenses/>.

"""FastAPI 后端服务，用于音效管理器的 AI 语义搜索功能。"""

import os
import re
import time
import uuid
import tempfile
import asyncio
import threading
import json
import numpy as np
import math
import functools
from datetime import datetime
from pathlib import Path
from typing import Optional, List, Dict, Any, Mapping, Sequence, Tuple
from contextlib import asynccontextmanager
from concurrent.futures import ThreadPoolExecutor


def validate_path(path: str, allow_absolute: bool = True) -> bool:
    """
    验证路径是否安全，防止路径遍历攻击
    
    Args:
        path: 要验证的路径
        allow_absolute: 是否允许绝对路径
        
    Returns:
        bool: 路径是否安全
    """
    if not path:
        return False
    
    # FastAPI already decodes URL path parameters once. JSON body paths are
    # native filesystem strings. Decoding again corrupts legitimate ``%``
    # names, so validation operates on the value exactly as received.
    if '\x00' in path:
        return False
    normalized = os.path.normpath(path)
    components = re.split(r"[\\/]", path)
    if any(component == ".." for component in components):
        return False
    
    # 如果不允许绝对路径，检查是否是相对路径
    if not allow_absolute and os.path.isabs(normalized):
        return False
    
    return True

from fastapi import FastAPI, HTTPException, Query, Path as PathParam, BackgroundTasks, WebSocket, WebSocketDisconnect, Body
from fastapi.exceptions import RequestValidationError
from fastapi.responses import FileResponse, StreamingResponse, Response, JSONResponse
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
import uvicorn

import config
from models import schemas
from core.indexer import (
    get_indexer,
    AudioIndexer,
    reset_all_indexers,
    reset_chroma_client,
)
from core.searcher import get_searcher, AudioSearcher, reset_searcher
from core.embedder import get_embedder, reset_embedder, is_embedder_available, is_embedder_loaded
from core.database import (
    get_db_manager,
    reset_db_manager,
    AudioFileRecord,
    is_safe_project_id,
    canonicalize_path,
    canonical_path_is_within,
)
from core.websocket_manager import (
    get_ws_manager,
    reset_ws_manager,
)
from utils.logger import logger

# 线程池用于 CPU 密集型任务
_executor = ThreadPoolExecutor(max_workers=4)
_model_executor = ThreadPoolExecutor(max_workers=1)
_project_index_locks: Dict[str, asyncio.Lock] = {}
_projects_deleting: set[str] = set()

# 大批量导入时不在导入循环里逐条算 CLAP/BGE 向量
# （每文件 ~50ms，7 万条要好几个小时）；先入库 + 波形，向量标记 pending，
# 交给后台对账任务按批计算。
IMPORT_INLINE_INDEX_LIMIT = 500

# 索引进度心跳：影子索引完成前 ready 不会变，用这个让界面看出"在动"
_index_progress = {"audio": 0, "text": 0, "target": 0, "active": False}
_automatic_index_tasks: Dict[str, Dict[str, Any]] = {}
_shutting_down = False


async def _run_audio_work(function, *args, **kwargs):
    loop = asyncio.get_running_loop()
    return await loop.run_in_executor(
        _executor, functools.partial(function, *args, **kwargs)
    )


async def _run_model_work(function, *args, **kwargs):
    loop = asyncio.get_running_loop()
    return await loop.run_in_executor(
        _model_executor, functools.partial(function, *args, **kwargs)
    )


def _get_project_index_lock(project_id: str) -> asyncio.Lock:
    return _project_index_locks.setdefault(str(project_id), asyncio.Lock())


async def _prepare_import_candidate(
    file_path: str,
    project_id: str,
    scanner: Any,
    audio_service: Any,
    *,
    import_root: Optional[str] = None,
) -> Dict[str, Any]:
    """Persist path/stat identity before any decoder or model work begins."""
    absolute = Path(file_path).resolve()
    existing = get_db_manager().get_file(str(absolute), project_id)
    stat = await _run_audio_work(absolute.stat)
    source = await _run_audio_work(audio_service.fingerprint, str(absolute))
    parsed_name, name_tokens, name_description = scanner._parse_filename(absolute.name)
    folder_path = ""
    if import_root:
        try:
            relative = absolute.parent.relative_to(Path(import_root).resolve())
            folder_path = "" if str(relative) == "." else str(relative)
        except ValueError:
            folder_path = ""

    from core.scanner import AudioFile as ScannedAudioFile

    placeholder = ScannedAudioFile(
        path=str(absolute),
        filename=absolute.name,
        duration=0.0,
        sample_rate=0,
        channels=0,
        format=absolute.suffix.lower().lstrip("."),
        size=stat.st_size,
        folder_path=folder_path,
        parsed_name=parsed_name,
        name_tokens=name_tokens,
        name_description=name_description,
        metadata_tags={},
    )
    record = AudioFileRecord(
        path=str(absolute),
        filename=absolute.name,
        file_size=stat.st_size,
        tags="[]",
        source_fingerprint=source.source_key,
        waveform_version=int(source.waveform_version),
    )
    file_uuid = await _run_audio_work(
        get_db_manager().upsert_file, record, project_id
    )
    return {
        "audio_file": placeholder,
        "file_uuid": file_uuid,
        "source": source,
        "existing": existing,
    }


async def _record_probe_failure(
    project_id: str,
    candidate: Dict[str, Any],
    *,
    message: str = "PyAV could not decode this supported file",
    folder_context: Optional[Sequence[Mapping[str, Any]]] = None,
) -> None:
    db_manager = get_db_manager()
    file_uuid = candidate["file_uuid"]
    source_key = candidate["source"].source_key
    for kind in ("waveform", "audio_vector"):
        db_manager.set_artifact_state(
            project_id,
            file_uuid,
            kind,
            "failed",
            source_fingerprint=source_key,
            error_code="audio_probe_failed",
            error_message=message,
        )
    await _index_text_metadata_artifact(
        project_id,
        file_uuid,
        candidate["audio_file"],
        tags=(candidate["existing"].tags if candidate["existing"] else "[]"),
        folder_context=folder_context,
    )


class SoundBotAPIError(Exception):
    """Structured error contract shared by backend, Electron and renderer."""

    def __init__(
        self,
        code: str,
        message: str,
        *,
        status_code: int = 400,
        retryable: bool = False,
        details: Optional[Dict[str, Any]] = None,
    ):
        super().__init__(message)
        self.status_code = status_code
        self.payload = {
            "code": code,
            "message": message,
            "retryable": retryable,
            "details": details or {},
        }


def cleanup_old_clips(max_keep=100):
    """
    清理多余的临时文件，只保留最新的max_keep个
    
    注意：此功能已禁用，临时文件由用户自行管理
    保留函数是为了向后兼容，但不再执行实际清理操作
    """
    # 临时文件由用户自行管理，不再自动清理
    logger.info("临时文件自动清理已禁用，由用户自行管理")
    return


def _inject_ark_config() -> None:
    """从项目根 .env.ark 注入豆包 LLM/Embedding 配置。

    密钥只进入内存配置，写入磁盘的 ai_config.json 元数据不含密钥
    （llm_config_manager._config_for_disk 负责过滤）。
    """
    try:
        env_path = Path(__file__).resolve().parent.parent / ".env.ark"
        if not env_path.exists():
            logger.debug("未找到 .env.ark，跳过豆包配置注入")
            return
        values: dict = {}
        for raw_line in env_path.read_text(encoding="utf-8").splitlines():
            line = raw_line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, _, value = line.partition("=")
            values[key.strip()] = value.strip()
        api_key = values.get("ARK_API_KEY", "")
        base_url = values.get("ARK_BASE_URL", "")
        if not api_key or not base_url:
            logger.warning(".env.ark 缺少 ARK_API_KEY / ARK_BASE_URL，跳过注入")
            return
        from core.llm_config_manager import get_llm_config_manager

        manager = get_llm_config_manager()
        # 用户在界面里配过别的 LLM（比如 DeepSeek）时不要覆盖，否则每次
        # 重启后端都会把 custom 改回豆包。
        try:
            _current = manager.get_current_llm_config()
            _base = str(getattr(_current, "base_url", "") or "")
        except Exception:
            _base = ""
        if _base and "ark.cn-beijing.volces.com" not in _base:
            logger.info("检测到用户自定义 LLM 配置（%s），跳过豆包注入", _base)
            return

        chat_model = values.get("ARK_CHAT_MODEL", "")
        if chat_model:
            manager.update_llm_config(
                "custom",
                {"base_url": base_url, "api_key": api_key, "model": chat_model},
            )
            logger.info("豆包 LLM 配置已注入: provider=custom model=%s", chat_model)
        embed_model = values.get("ARK_EMBED_MODEL", "")
        if embed_model:
            manager.update_embedding_config(
                "external",
                {
                    "base_url": base_url,
                    "api_key": api_key,
                    "model": embed_model,
                    "dimension": int(values.get("ARK_EMBED_DIM", "2048") or 2048),
                    "endpoint": values.get("ARK_EMBED_ENDPOINT", "/embeddings/multimodal"),
                },
            )
            logger.info(
                "豆包 Embedding 配置已注入: provider=external model=%s endpoint=%s",
                embed_model,
                values.get("ARK_EMBED_ENDPOINT", "/embeddings/multimodal"),
            )
    except Exception as exc:
        logger.error("豆包配置注入失败: %s", exc)


def _load_sfx_config() -> None:
    """加载「创造音效」配置。

    这条链路必须独立于 LLM 注入：用户把 LLM 改成 DeepSeek 后，上面的注入会
    提前 return，导致界面里保存的语音 Key 永远加载不到（表现为「未配置」）。
    优先级：磁盘上的界面配置 > .env.ark 默认值。
    """
    values: dict = {}
    try:
        env_path = Path(__file__).resolve().parent.parent / ".env.ark"
        if env_path.exists():
            for raw_line in env_path.read_text(encoding="utf-8").splitlines():
                line = raw_line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                key, _, value = line.partition("=")
                values[key.strip()] = value.strip()
    except Exception as exc:
        logger.debug("读取 .env.ark 失败: %s", exc)

    try:
        from core.sfx_generator import (
            configure_voice_api_key,
            configure_save_dir,
            load_config,
        )

        voice_key = values.get("DOUBAO_VOICE_API_KEY", "")
        configure_voice_api_key(voice_key)
        if voice_key:
            logger.info("豆包语音 API Key 已从 .env.ark 注入")
        save_dir = values.get("SFX_SAVE_DIR", "")
        if save_dir:
            configure_save_dir(save_dir)
        load_config()
        from core.sfx_generator import is_configured

        logger.info(
            "创造音效配置: %s", "已配置" if is_configured() else "未配置语音 Key"
        )
    except Exception as exc:
        logger.warning("加载创造音效配置失败: %s", exc)


@asynccontextmanager
async def lifespan(app: FastAPI):
    """应用生命周期管理"""
    global _shutting_down
    _shutting_down = False
    logger.info(f"SoundBot API 启动中...")
    logger.info(f"设备: {config.get_device()}")
    logger.info(f"数据库路径: {config.get_db_path()}")

    # 环境检查：记录路径信息，模型缺失时提前打印明确错误
    try:
        from bootstrap import check_environment
        env_result = check_environment()
        logger.info(f"[Bootstrap] 路径检查: {env_result['paths']}")
        if not env_result['ok']:
            for err in env_result['errors']:
                logger.error(f"[Bootstrap] {err['type']}: {err['message']}")
                logger.error(f"[Bootstrap] 解决方案: {err['solution']}")
    except Exception as _e:
        logger.debug(f"[Bootstrap] 环境检查跳过: {_e}")

    # 注入豆包 LLM/Embedding 配置（密钥仅进内存，不落盘）
    _inject_ark_config()
    # 创造音效的语音 Key 独立加载：LLM 换成 DeepSeek 时也必须恢复
    _load_sfx_config()

    # 初始化 SQLite 数据库
    db_manager = get_db_manager()
    file_count = db_manager.get_file_count()
    logger.info(f"SQLite 数据库已加载，当前文件数: {file_count}")

    # 上次进程被强杀时，artifacts 会停在 processing，之后 reconcile 只挑
    # pending/stale/failed，导致这些条目永远不再被处理（数字冻结）。
    # 启动时没有任务在跑，统一把它们退回 pending，让自动补索引能接手。
    try:
        with db_manager.get_cursor() as cursor:
            running = cursor.execute(
                "SELECT COUNT(*) FROM jobs WHERE state IN ('running','pending')"
            ).fetchone()[0]
            if not running:
                fixed = cursor.execute(
                    "UPDATE file_artifacts SET state='pending' WHERE state='processing'"
                ).rowcount
                if fixed:
                    logger.info("启动自愈：%d 条中断的 processing 状态已退回 pending", fixed)
    except Exception as exc:
        logger.warning("启动自愈失败: %s", exc)

    # 使用动态获取的临时文件目录
    temp_dir = Path(config.get_temp_clip_dir())
    temp_dir.mkdir(parents=True, exist_ok=True)
    logger.info(f"临时文件目录: {temp_dir}")

    logger.info("临时文件由用户自行管理，不执行自动清理")

    # 启动模型预加载（后台异步）。完成事件会自动修复所有工程中
    # 因模型缺失而保持 pending/failed/stale 的双索引 artifact。
    from core.model_preloader import (
        get_preloader,
        preload_models_on_startup,
        reset_preloader,
    )
    preloader = get_preloader()
    event_loop = asyncio.get_running_loop()

    def on_model_progress(stage: str, _progress: float) -> None:
        if stage == "complete" and not _shutting_down:
            event_loop.call_soon_threadsafe(_schedule_model_ready_reconcile)

    # 限制 torch 的 CPU 线程数，避免与检索线程抢核心
    try:
        import torch as _torch
        _threads = int(os.environ.get("OMP_NUM_THREADS", "4") or 4)
        _torch.set_num_threads(max(1, _threads))
        logger.info("torch CPU 线程数已限制为 %d", _threads)
    except Exception as _exc:
        logger.debug("设置 torch 线程数失败: %s", _exc)

    preloader.add_progress_callback(on_model_progress)
    await preload_models_on_startup()

    # 预热关键词搜索的文件快照：5 万条从 SQLite 重建约 10 秒，放在后台做，
    # 用户第一次搜索就不必等这一下。
    async def _warm_zh_embedder() -> None:
        """P3：启动后预热中文文本模型，避免第一次长句搜索等 10 秒以上。"""
        await asyncio.sleep(8)
        try:
            from core import zh_embedder

            if not zh_embedder.available():
                return
            started = time.time()
            await asyncio.to_thread(zh_embedder.encode, ["预热"])
            logger.info("[Embed] BGE 预热完成 %.1fs", time.time() - started)
        except Exception as exc:
            logger.warning("[Embed] 预热失败: %s", exc)

    async def _ensure_fts_ready() -> None:
        """后台建/补 FTS5 中文检索索引（不阻塞启动）。"""
        await asyncio.sleep(6)
        try:
            project_id = getattr(config, "CURRENT_PROJECT_ID", "default")
            db = get_db_manager()
            started = time.time()
            inserted = await asyncio.to_thread(db.ensure_fts, project_id)
            logger.info(
                "[FTS] 中文检索索引就绪：灌入 %s 行，耗时 %.1fs",
                inserted,
                time.time() - started,
            )
        except Exception as exc:
            logger.warning("[FTS] 构建失败（检索会回退旧通道）: %s", exc)

    async def _warm_search_snapshot() -> None:
        await asyncio.sleep(8)
        try:
            project_id = getattr(config, 'CURRENT_PROJECT_ID', 'default')
            # 先建检索器（首次构造要 7~13 秒），再建文件快照，这样用户第一次
            # 搜索不必再等这两个一次性开销。
            searcher = await asyncio.to_thread(_get_project_searcher, project_id)
            logger.info("[Warmup] 检索器已预热")
            if searcher is not None:
                await asyncio.to_thread(searcher._get_all_files, None)
                logger.info("[Warmup] 关键词搜索文件快照已预热")
                # 再跑一次真实检索：Chroma 的向量是懒加载的，不先查一遍，
                # 用户的首个语义搜索仍要等 20 秒以上的冷读。
                # 但要延后：这句会占住 GPU/CPU 十几秒，紧跟启动跑会和用户
                # 刚打开界面时的第一次关键词搜索抢资源（实测把 0.1s 拖成 26s）。
                await asyncio.sleep(45)
                _t = time.time()
                try:
                    await searcher.search_async(
                        query="sound", top_k=5, use_cache=False
                    )
                    logger.info(
                        "[Warmup] 语义检索已预热 %.1fs", time.time() - _t
                    )
                except Exception as warm_exc:
                    logger.debug("[Warmup] 语义预热失败: %s", warm_exc)
        except Exception as exc:
            logger.debug(f"[Warmup] 搜索预热失败: {exc}")


    asyncio.create_task(_ensure_fts_ready())
    asyncio.create_task(_backfill_content_hashes())
    asyncio.create_task(_warm_search_snapshot())
    asyncio.create_task(_warm_zh_embedder())

    yield

    _shutting_down = True
    logger.info("SoundBot API 关闭中...")
    logger.info("临时文件由用户自行管理，不执行自动清理")
    preloader.remove_progress_callback(on_model_progress)
    for entry in list(_automatic_index_tasks.values()):
        get_db_manager().update_job(entry["job_id"], cancel_requested=1)
    if _automatic_index_tasks:
        await asyncio.gather(
            *(entry["task"] for entry in list(_automatic_index_tasks.values())),
            return_exceptions=True,
        )
    await preloader.close()
    reset_preloader()
    reset_embedder()
    from core.search_engine import reset_optimized_searcher
    from core.ai_chat_service import reset_ai_chat_service

    reset_optimized_searcher()
    reset_ai_chat_service()
    reset_all_indexers()
    reset_searcher()
    reset_chroma_client()
    reset_db_manager()
    reset_ws_manager()
    logger.info("全局单例状态已清理")


# 创建 FastAPI 应用
app = FastAPI(
    title="SoundBot API",
    description="AI 音效管理器的语义搜索后端",
    version=config.APP_VERSION,
    lifespan=lifespan
)


@app.exception_handler(SoundBotAPIError)
async def soundbot_api_error_handler(_request, exc: SoundBotAPIError):
    return JSONResponse(status_code=exc.status_code, content=exc.payload)


@app.exception_handler(HTTPException)
async def http_error_handler(_request, exc: HTTPException):
    if isinstance(exc.detail, dict) and exc.detail.get("code"):
        payload = {
            "code": str(exc.detail["code"]),
            "message": str(exc.detail.get("message") or "请求失败"),
            "retryable": bool(exc.detail.get("retryable", False)),
            "details": dict(exc.detail.get("details") or {}),
        }
    else:
        payload = {
            "code": f"http_{exc.status_code}",
            "message": str(exc.detail or "请求失败"),
            "retryable": exc.status_code in {408, 425, 429, 502, 503, 504},
            "details": {},
        }
    return JSONResponse(status_code=exc.status_code, content=payload)


@app.exception_handler(RequestValidationError)
async def validation_error_handler(_request, exc: RequestValidationError):
    # Exclude Pydantic's raw input values: configuration requests may contain
    # credentials that must never be echoed into renderer-visible responses.
    issues = [
        {
            "field": ".".join(str(part) for part in error.get("loc", ())),
            "message": str(error.get("msg", "invalid value")),
            "type": str(error.get("type", "validation_error")),
        }
        for error in exc.errors()
    ]
    return JSONResponse(
        status_code=422,
        content={
            "code": "validation_error",
            "message": "请求参数无效",
            "retryable": False,
            "details": {"issues": issues},
        },
    )


@app.exception_handler(Exception)
async def unhandled_error_handler(_request, exc: Exception):
    logger.exception("未处理的 API 异常: %s", exc)
    return JSONResponse(
        status_code=500,
        content={
            "code": "internal_error",
            "message": "后端发生未预期错误，请查看日志",
            "retryable": False,
            "details": {},
        },
    )

# 添加 CORS 中间件
app.add_middleware(
    CORSMiddleware,
    allow_origins=config.CORS_ORIGINS,
    allow_credentials=True,
    allow_methods=["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allow_headers=["Content-Type", "Authorization"],
)


# ==================== WebSocket 端点 ====================

@app.websocket("/ws/scan/{client_id}")
async def websocket_scan_progress(websocket: WebSocket, client_id: str):
    """
    WebSocket 端点：接收扫描进度推送

    前端通过此 WebSocket 接收实时扫描进度。

    接收消息格式:
    - {"type": "cancel", "task_id": "xxx"} - 取消扫描任务
    - {"type": "ping"} - 心跳检测

    发送消息格式:
    - scan_progress: {"type": "scan_progress", "task_id": "xxx", "data": {...}}
    - scan_complete: {"type": "scan_complete", "task_id": "xxx", "data": {...}}
    - scan_error: {"type": "scan_error", "task_id": "xxx", "data": {...}}
    """
    logger.info(f"[WS] WebSocket 连接尝试: client_id={client_id}, origin={websocket.headers.get('origin')}")
    ws_manager = get_ws_manager()
    await ws_manager.connect(websocket, client_id)
    logger.info(f"[WS] WebSocket 连接成功: client_id={client_id}")
    try:
        while True:
            data = await websocket.receive_text()
            message = json.loads(data)
            msg_type = message.get("type", "")

            if msg_type == "cancel":
                task_id = message.get("task_id")
                if task_id:
                    ws_manager.cancel_task(task_id)
                    logger.info(f"任务已取消: {task_id}")

            elif msg_type == "ping":
                await websocket.send_json({"type": "pong"})

    except WebSocketDisconnect:
        logger.info(f"[WS] WebSocket 断开: client_id={client_id}")
        ws_manager.disconnect(websocket, client_id)
    except json.JSONDecodeError:
        logger.warning(f"[WS] 无效的 JSON 消息 from {client_id}")
    except Exception as e:
        logger.error(f"[WS] WebSocket 错误: {e}")
        ws_manager.disconnect(websocket, client_id)


# ==================== 健康检查 ====================

@app.get("/api/v1/health", response_model=schemas.HealthResponse)
async def health_check():
    """
    健康检查接口

    返回服务状态、版本号和当前设备信息
    """
    from core.audio_service import get_audio_service

    audio_runtime = get_audio_service().runtime_status()
    audio_decoder_available = bool(audio_runtime["available"])
    return schemas.HealthResponse(
        status="healthy" if audio_decoder_available else "degraded",
        version=config.APP_VERSION,
        device=config.get_device(),
        model_loaded=is_embedder_loaded(),
        audio_decoder_available=audio_decoder_available,
    )


@app.get(
    "/api/v1/runtime/capabilities",
    response_model=schemas.RuntimeCapabilitiesResponse,
)
async def get_runtime_capabilities():
    """Report required and optional frozen-runtime capabilities.

    The response is safe to show in a startup diagnostic: it never includes
    local paths, environment variables, exception messages, or credentials.
    """
    from core.audio_service import get_audio_service

    audio_runtime = get_audio_service().runtime_status()
    return schemas.RuntimeCapabilitiesResponse(
        status="ready" if audio_runtime["available"] else "degraded",
        version=config.APP_VERSION,
        audio_decoder=schemas.AudioDecoderCapability(**audio_runtime),
        semantic_search=schemas.SemanticSearchCapability(
            available=is_embedder_loaded()
        ),
        supported_audio_extensions=sorted(config.AUDIO_FORMAT_CAPABILITIES),
    )


@app.get("/api/v1/model/status")
async def get_model_status():
    """
    获取 AI 模型加载状态

    返回模型是否已预加载到内存，以及加载进度
    """
    from core.model_preloader import get_preloader
    preloader = get_preloader()
    # Polling this endpoint is also the recovery signal after the desktop app
    # installs/replaces a previously missing local model package. Unchanged
    # corrupt packages are not retried on every poll.
    preloader.retry_if_source_changed()

    return {
        "status": "success",
        "model_status": preloader.get_status(),
        "embedder_available": preloader.get_embedder() is not None
    }


# ==================== 扫描与索引 ====================

@app.post("/api/v1/scan", deprecated=True)
async def scan_and_index(request: schemas.ScanRequest):
    """Reject the pre-v0.2 path that wrote Chroma without durable SQLite state."""
    raise SoundBotAPIError(
        "legacy_scan_removed",
        "该入口已停用；请使用项目导入作业接口",
        status_code=410,
        details={"replacement": "/api/v1/projects/{project_id}/imports"},
    )


# ==================== 仅扫描文件（不建索引）====================
@app.post("/api/v1/scan-only", response_model=schemas.ScanResponse)
async def scan_only(request: schemas.ScanRequest):
    """
    仅扫描音频文件，不建立索引（用于没有模型的情况）
    """
    # 验证路径安全性，防止路径遍历攻击
    if not validate_path(request.folder_path):
        raise HTTPException(status_code=400, detail="路径包含非法字符")
    
    folder = Path(request.folder_path)
    
    if not folder.exists():
        raise HTTPException(status_code=404, detail=f"文件夹不存在: {request.folder_path}")
    
    if not folder.is_dir():
        raise HTTPException(status_code=400, detail=f"路径不是文件夹: {request.folder_path}")
    
    try:
        from core.scanner import AudioScanner
        scanner = AudioScanner()
        audio_files = await _run_audio_work(
            scanner.scan, str(folder), request.recursive
        )
        
        audio_file_list = []
        for f in audio_files:
            audio_file_list.append(schemas.AudioFile(
                path=f.path,
                filename=f.filename,
                duration=f.duration,
                sample_rate=f.sample_rate,
                channels=f.channels,
                format=f.format,
                size=f.size
            ))
        
        return schemas.ScanResponse(
            total=len(audio_file_list),
            files=audio_file_list
        )
        
    except Exception as e:
        logger.error(f"扫描失败: {e}")
        raise HTTPException(status_code=500, detail=str(e))


# ==================== 异步导入（带进度推送） ====================

def _filter_duplicate_paths(paths, duplicate_pairs):
    """按「文件名小写 + 字节数」过滤掉库里已有的文件；返回 (保留列表, 跳过数量)。"""
    if not duplicate_pairs:
        return list(paths), 0
    kept = []
    skipped = 0
    for item in paths:
        try:
            size = int(item.stat().st_size)
        except OSError:
            kept.append(item)
            continue
        if (item.name.lower(), size) in duplicate_pairs:
            skipped += 1
            continue
        kept.append(item)
    return kept, skipped


async def _start_folder_import(
    project_id: str,
    folder_path: str,
    recursive: bool,
    client_id: str,
    background_tasks: BackgroundTasks,
    skip_existing: bool = False,
) -> Dict[str, Any]:
    """Validate and enqueue one immutable project-scoped folder import."""
    db_manager = get_db_manager()
    if not is_safe_project_id(project_id) or not db_manager.get_project(project_id):
        raise SoundBotAPIError("project_not_found", "工程不存在", status_code=404)
    if project_id in _projects_deleting:
        raise SoundBotAPIError("project_deleting", "工程正在删除", status_code=409)

    # 验证路径安全性，防止路径遍历攻击
    if not validate_path(folder_path):
        raise HTTPException(status_code=400, detail="路径包含非法字符")

    folder = Path(folder_path).expanduser()

    if not folder.exists() or not folder.is_dir():
        raise HTTPException(status_code=400, detail="无效的文件夹路径")
    folder = folder.resolve(strict=True)

    task_id = db_manager.create_job(project_id, "folder_import")
    ws_manager = get_ws_manager()
    ws_manager.register_task(task_id, client_id)

    # 后台执行扫描
    background_tasks.add_task(
        _scan_and_import_task,
        task_id=task_id,
        folder_path=str(folder),
        recursive=recursive,
        client_id=client_id,
        project_id=project_id,
        skip_existing=skip_existing,
    )

    return {
        "task_id": task_id,
        "job_id": task_id,
        "project_id": project_id,
        "state": "pending",
        "message": "扫描任务已启动",
    }


@app.post("/api/v1/import/async", deprecated=True)
async def import_folder_async(
    request: schemas.ScanRequest,
    background_tasks: BackgroundTasks,
    client_id: str = Query(default="default"),
):
    """Compatibility adapter; new callers use the project-explicit route."""
    project_id = getattr(config, "CURRENT_PROJECT_ID", "default") or "default"
    return await _start_folder_import(
        project_id,
        request.folder_path,
        request.recursive,
        client_id,
        background_tasks,
    )


@app.post("/api/v1/import/files", deprecated=True)
async def import_selected_files(
    request: schemas.ImportFilesRequest,
    background_tasks: BackgroundTasks,
):
    """Persist and index files selected by Electron without copying bytes over IPC."""
    from core.audio_service import get_audio_service

    db_manager = get_db_manager()
    project_id = request.project_id or getattr(config, 'CURRENT_PROJECT_ID', 'default')
    if not is_safe_project_id(project_id) or not db_manager.get_project(project_id):
        raise SoundBotAPIError("project_not_found", "工程不存在", status_code=404)
    if project_id in _projects_deleting:
        raise SoundBotAPIError("project_deleting", "工程正在删除", status_code=409)
    audio_service = get_audio_service()
    accepted: List[str] = []
    rejected: List[Dict[str, str]] = []
    for raw_path in request.file_paths:
        path = Path(raw_path)
        if not path.is_file():
            rejected.append({"path": raw_path, "reason": "not_found"})
        elif not audio_service.is_supported(path):
            rejected.append({"path": raw_path, "reason": "unsupported_format"})
        else:
            accepted.append(str(path.resolve()))
    if not accepted:
        raise SoundBotAPIError(
            "no_importable_files",
            "没有可导入的音频文件",
            details={"rejected": rejected},
        )
    job_id = db_manager.create_job(project_id, "file_import", len(accepted))
    client_id = request.client_id or "default"
    get_ws_manager().register_task(job_id, client_id)
    background_tasks.add_task(
        _import_selected_files_task,
        job_id,
        accepted,
        project_id,
        client_id,
    )
    return {
        "job_id": job_id,
        "task_id": job_id,
        "project_id": project_id,
        "state": "pending",
        "total": len(accepted),
        "rejected": rejected,
    }


@app.post("/api/v1/projects/{project_id}/imports")
async def import_project_files(
    project_id: str,
    request: schemas.ProjectImportRequest,
    background_tasks: BackgroundTasks,
):
    """Import exactly one folder or file list into the path-scoped project."""
    if request.folder_path is not None:
        return await _start_folder_import(
            project_id,
            request.folder_path,
            request.recursive,
            request.client_id or "default",
            background_tasks,
            skip_existing=bool(getattr(request, "skip_existing", False)),
        )
    payload = schemas.ImportFilesRequest(
        file_paths=request.file_paths or [],
        client_id=request.client_id,
        project_id=project_id,
    )
    return await import_selected_files(payload, background_tasks)


async def _import_selected_files_task(
    job_id: str,
    file_paths: List[str],
    project_id: str,
    client_id: str,
) -> None:
    if project_id in _projects_deleting:
        get_db_manager().update_job(
            job_id, state="cancelled", stage="project_deleting"
        )
        return
    async with _get_project_index_lock(project_id):
        if project_id in _projects_deleting or not get_db_manager().get_project(project_id):
            get_db_manager().update_job(
                job_id, state="cancelled", stage="project_deleting"
            )
            return
        await _import_selected_files_task_locked(
            job_id, file_paths, project_id, client_id
        )


async def _import_selected_files_task_locked(
    job_id: str,
    file_paths: List[str],
    project_id: str,
    client_id: str,
) -> None:
    from core.audio_service import get_audio_service, AudioServiceError
    from core.scanner import AudioScanner

    db_manager = get_db_manager()
    ws_manager = get_ws_manager()
    service = get_audio_service()
    scanner = AudioScanner(service)
    folder_context = _load_logical_folder_context(project_id)
    db_manager.update_job(job_id, state="running", stage="analyzing")
    added = 0
    failed = 0
    try:
        _last_index_report = 0.0
        defer_vectors = len(file_paths) > IMPORT_INLINE_INDEX_LIMIT
        if defer_vectors:
            logger.info(
                "[IMPORT] 本次 %d 个文件，跳过逐条向量计算，交给后台批量处理", len(file_paths)
            )

        for index, file_path in enumerate(file_paths):
            job = db_manager.get_job(job_id)
            if (job and job["cancel_requested"]) or ws_manager.is_task_cancelled(job_id):
                db_manager.update_job(
                    job_id, state="cancelled", stage="cancelled", processed=index
                )
                return
            candidate = await _prepare_import_candidate(
                file_path, project_id, scanner, service
            )
            existing = candidate["existing"]
            if not existing:
                added += 1
            audio_file = await _run_audio_work(scanner._process_file, Path(file_path))
            if not audio_file:
                failed += 1
                await _record_probe_failure(
                    project_id, candidate, folder_context=folder_context
                )
                db_manager.update_job(job_id, processed=index + 1, stage="failed_item")
                await ws_manager.send_scan_progress(
                    client_id,
                    job_id,
                    index + 1,
                    len(file_paths),
                    Path(file_path).name,
                    "failed",
                    progress=int(((index + 1) / len(file_paths)) * 100),
                )
                continue
            waveform = None
            waveform_error = None
            try:
                waveform = await _run_audio_work(service.waveform, audio_file.path)
            except AudioServiceError as exc:
                waveform_error = exc
            source_fp = await _run_audio_work(service.fingerprint, audio_file.path)
            record = AudioFileRecord(
                path=audio_file.path,
                filename=audio_file.filename,
                duration=audio_file.duration,
                sample_rate=audio_file.sample_rate,
                channels=audio_file.channels,
                file_size=audio_file.size,
                peaks_json=json.dumps(waveform.peaks) if waveform else None,
                tags="[]",
                source_fingerprint=source_fp.source_key,
                waveform_fingerprint=waveform.fingerprint.key if waveform else None,
                waveform_version=int(source_fp.waveform_version),
            )
            file_uuid = await _run_audio_work(
                db_manager.upsert_file, record, project_id
            )
            if waveform_error:
                db_manager.set_artifact_state(
                    project_id, file_uuid, "waveform", "failed",
                    source_fingerprint=source_fp.source_key,
                    error_code=waveform_error.code,
                    error_message=waveform_error.message,
                )
            if is_embedder_available() and not defer_vectors:
                try:
                    indexer = _get_active_audio_indexer(project_id)
                    indexed = await _run_model_work(
                        indexer.add_single_audio,
                        audio_file.path,
                        {
                            "filename": audio_file.filename,
                            "duration": audio_file.duration,
                            "sample_rate": audio_file.sample_rate,
                            "channels": audio_file.channels,
                            "format": audio_file.format,
                            "size": audio_file.size,
                            "project_id": project_id,
                            "file_id": file_uuid,
                        },
                    )
                    db_manager.set_artifact_state(
                        project_id,
                        file_uuid,
                        "audio_vector",
                        "ready" if indexed else "failed",
                        source_fingerprint=source_fp.source_key,
                        engine_fingerprint=(
                            indexer.get_manifest().get("engine_fingerprint")
                            if indexed else None
                        ),
                        error_code=None if indexed else "audio_index_failed",
                    )
                except Exception as exc:
                    db_manager.set_artifact_state(
                        project_id, file_uuid, "audio_vector", "failed",
                        error_code="audio_index_failed", error_message=str(exc),
                    )
            if defer_vectors:
                db_manager.set_artifact_state(
                    project_id, file_uuid, "audio_vector", "pending",
                    source_fingerprint=source_fp.source_key,
                )
            else:
                await _index_text_metadata_artifact(
                    project_id,
                    file_uuid,
                    audio_file,
                    tags=existing.tags if existing else "[]",
                    folder_context=folder_context,
                )
            _now_index = time.monotonic()
            if _now_index - _last_index_report >= 0.5 or index + 1 == len(file_paths):
                _last_index_report = _now_index
                db_manager.update_job(job_id, processed=index + 1, stage="indexing")
            await ws_manager.send_scan_progress(
                client_id,
                job_id,
                index + 1,
                len(file_paths),
                audio_file.filename,
                "indexing",
                progress=int(((index + 1) / len(file_paths)) * 100),
            )
        await _bump_project_index_revision(project_id)
        if defer_vectors:
            try:
                await asyncio.sleep(1.0)
                _schedule_project_reconcile(project_id, ("audio_vector", "text_vector"), reason="bulk_import")
            except Exception as exc:
                logger.debug("调度批量索引进程失败: %s", exc)
        db_manager.update_job(
            job_id,
            state="completed",
            stage="done",
            processed=len(file_paths),
            error_message=f"{failed} files failed" if failed else None,
        )
        await ws_manager.send_scan_complete(
            client_id, job_id, len(file_paths), added, len(file_paths) - added
        )
    except Exception as exc:
        logger.exception(f"文件导入失败: {exc}")
        db_manager.update_job(
            job_id,
            state="failed",
            stage="failed",
            error_code="import_failed",
            error_message=str(exc),
        )
        await ws_manager.send_scan_error(client_id, job_id, str(exc))
    finally:
        ws_manager.unregister_task(job_id)


@app.get("/api/v1/jobs/{job_id}")
async def get_background_job(job_id: str):
    job = get_db_manager().get_job(job_id)
    if not job:
        raise SoundBotAPIError("job_not_found", "任务不存在", status_code=404)
    return job


@app.delete("/api/v1/jobs/{job_id}")
async def cancel_background_job(job_id: str):
    db_manager = get_db_manager()
    job = db_manager.get_job(job_id)
    if not job:
        raise SoundBotAPIError("job_not_found", "任务不存在", status_code=404)
    if job["state"] in {"completed", "failed", "cancelled"}:
        return {"job_id": job_id, "state": job["state"], "cancel_requested": False}
    db_manager.update_job(job_id, cancel_requested=1)
    get_ws_manager().cancel_task(job_id)
    return {"job_id": job_id, "state": job["state"], "cancel_requested": True}


async def _index_text_metadata_artifact(
    project_id: str,
    file_uuid: str,
    audio_file: Any,
    tags: Any = "[]",
    *,
    folder_context: Optional[Sequence[Mapping[str, Any]]] = None,
) -> bool:
    db_manager = get_db_manager()
    record = db_manager.get_file_by_uuid(file_uuid, project_id)
    source_fingerprint = record.source_fingerprint if record else None
    try:
        metadata = _build_text_metadata_payload(
            project_id,
            file_uuid,
            audio_file,
            tags=tags,
            source_fingerprint=source_fingerprint,
            folder_context=folder_context,
        )
        result = await _get_active_text_indexer(project_id).upsert_metadata([metadata])
        success = result.get("indexed", 0) == 1
        db_manager.set_artifact_state(
            project_id,
            file_uuid,
            "text_vector",
            "ready" if success else "failed",
            source_fingerprint=source_fingerprint,
            engine_fingerprint=result.get("fingerprint"),
            error_code=None if success else "text_index_failed",
        )
        return success
    except Exception as exc:
        db_manager.set_artifact_state(
            project_id,
            file_uuid,
            "text_vector",
            "failed",
            error_code="text_index_failed",
            error_message=str(exc),
        )
        logger.warning(f"文本元数据索引失败 {audio_file.path}: {exc}")
        return False


def _source_value(source: Any, key: str, default: Any = None) -> Any:
    if isinstance(source, Mapping):
        return source.get(key, default)
    return getattr(source, key, default)


def _flatten_metadata_values(value: Any) -> List[str]:
    """Flatten user/file metadata into deterministic searchable strings."""
    if value is None:
        return []
    if isinstance(value, str):
        rendered = value.strip()
        if not rendered:
            return []
        if rendered[:1] in {"[", "{"}:
            try:
                return _flatten_metadata_values(json.loads(rendered))
            except (TypeError, ValueError):
                pass
        return [rendered]
    if isinstance(value, Mapping):
        result: List[str] = []
        for key in sorted(value, key=lambda item: str(item)):
            result.extend(_flatten_metadata_values(key))
            result.extend(_flatten_metadata_values(value[key]))
        return result
    if isinstance(value, (list, tuple, set, frozenset)):
        result = []
        for item in value:
            result.extend(_flatten_metadata_values(item))
        return result
    return [str(value)]


def _load_logical_folder_context(project_id: str) -> List[Dict[str, Any]]:
    """Snapshot imported mappings and their user-facing folder metadata."""
    db_manager = get_db_manager()
    folders = {
        str(folder["id"]): folder
        for folder in db_manager.get_user_folders(project_id)
    }
    context: List[Dict[str, Any]] = []
    for mapping in db_manager.get_imported_folder_mappings(project_id):
        folder = folders.get(str(mapping.get("user_folder_id") or ""))
        context.append({
            "folder_path": mapping.get("folder_path") or "",
            "canonical_path": canonicalize_path(mapping.get("folder_path") or ""),
            "logical_folder": (folder or {}).get("name") or "",
            "description": (folder or {}).get("description") or "",
            "user_folder_id": mapping.get("user_folder_id"),
        })
    # Longest ancestor wins when an import root and one of its nested folders
    # are both present in the mapping table.
    return sorted(
        context,
        key=lambda item: len(str(item.get("canonical_path") or "")),
        reverse=True,
    )


def _derive_ucs_metadata(values: Sequence[Any]) -> Dict[str, Any]:
    """Derive UCS categories and their synonyms from filename/user metadata."""
    from core.ucs_keywords import get_ucs_keywords

    flattened: List[str] = []
    for value in values:
        flattened.extend(_flatten_metadata_values(value))
    corpus = " ".join(flattened).casefold()
    normalized_corpus = " ".join(
        token for token in re.split(r"[^0-9a-z\u3400-\u9fff]+", corpus) if token
    )
    corpus_tokens = set(normalized_corpus.split())

    def matches(term: str) -> bool:
        normalized = " ".join(
            token
            for token in re.split(
                r"[^0-9a-z\u3400-\u9fff]+", str(term).casefold()
            )
            if token
        )
        if not normalized:
            return False
        if re.search(r"[\u3400-\u9fff]", normalized):
            return normalized.replace(" ", "") in normalized_corpus.replace(" ", "")
        if " " not in normalized:
            return normalized in corpus_tokens
        return f" {normalized} " in f" {normalized_corpus} "

    categories: List[str] = []
    keywords: List[str] = []
    seen_keywords = set()
    for category, synonyms in get_ucs_keywords().items():
        if not (matches(category) or any(matches(synonym) for synonym in synonyms)):
            continue
        categories.append(str(category))
        for synonym in synonyms:
            rendered = str(synonym).strip()
            identity = rendered.casefold()
            if rendered and identity not in seen_keywords:
                seen_keywords.add(identity)
                keywords.append(rendered)
    return {
        "categories": categories,
        "keywords": keywords,
        # build_metadata_text consumes this field, so include both the UCS
        # labels and their searchable synonyms in a deterministic string.
        "search_text": " ".join([*categories, *keywords]),
    }


def _build_text_metadata_payload(
    project_id: str,
    file_uuid: str,
    source: Any,
    *,
    tags: Any = "[]",
    source_fingerprint: Optional[str] = None,
    folder_context: Optional[Sequence[Mapping[str, Any]]] = None,
) -> Dict[str, Any]:
    """Build the complete, project-scoped metadata document for text indexing."""
    file_path = str(_source_value(source, "file_path") or _source_value(source, "path") or "")
    filename = str(_source_value(source, "filename") or Path(file_path).name)
    parsed_name = str(_source_value(source, "parsed_name") or "")
    name_description = str(_source_value(source, "name_description") or "")
    ai_description = str(_source_value(source, "ai_description") or "")
    if not parsed_name or not name_description:
        stem = Path(filename).stem
        derived = " ".join(
            part for part in re.split(r"[_\-\s.]+", stem) if part
        )
        parsed_name = parsed_name or derived
        name_description = name_description or derived

    context = list(folder_context) if folder_context is not None else _load_logical_folder_context(project_id)
    logical = next(
        (
            item for item in context
            if item.get("user_folder_id")
            and canonical_path_is_within(
                file_path, str(item.get("folder_path") or "")
            )
        ),
        {},
    )
    logical_folder = str(logical.get("logical_folder") or "")
    description = str(logical.get("description") or "")
    metadata_tags = _source_value(source, "metadata_tags", {}) or {}
    ucs = _derive_ucs_metadata((
        filename,
        tags,
        metadata_tags,
        logical_folder,
        description,
        name_description,
    ))
    return {
        "file_id": file_uuid,
        "file_path": file_path,
        "filename": filename,
        "folder_path": _source_value(source, "folder_path", "") or str(Path(file_path).parent),
        "logical_folder": logical_folder,
        "logical_folder_id": logical.get("user_folder_id") or "",
        "description": description,
        "parsed_name": parsed_name,
        "name_description": name_description,
        "ai_description": ai_description,
        "metadata_tags": metadata_tags,
        "ucs_category": ucs["search_text"],
        "ucs_categories": ucs["categories"],
        "ucs_keywords": ucs["keywords"],
        "duration": float(_source_value(source, "duration", 0.0) or 0.0),
        "sample_rate": int(_source_value(source, "sample_rate", 0) or 0),
        "channels": int(_source_value(source, "channels", 0) or 0),
        "format": str(_source_value(source, "format") or Path(file_path).suffix.lower().lstrip(".")),
        "size": int(_source_value(source, "size", _source_value(source, "file_size", 0)) or 0),
        "tags": tags,
        "source_fingerprint": source_fingerprint,
        "project_id": project_id,
    }


def _get_active_audio_indexer(project_id: str):
    from core.index_lifecycle import get_active_audio_indexer

    return get_active_audio_indexer(get_db_manager(), project_id)


def _get_active_text_indexer(project_id: str):
    from core.index_lifecycle import get_active_text_indexer

    return get_active_text_indexer(get_db_manager(), project_id)


def _manifest_update_values(manifest: Dict[str, Any]) -> Dict[str, Any]:
    return {
        "collection_name": manifest.get("collection"),
        "engine_fingerprint": manifest.get("engine_fingerprint"),
        "model_id": manifest.get("model_id"),
        "model_revision": manifest.get("model_revision"),
        "dimensions": manifest.get("dimensions"),
        "preprocessing_version": manifest.get("preprocessing_version"),
        "metric": manifest.get("metric") or "cosine",
        "state": "rebuild_required" if manifest.get("needs_rebuild") else "ready",
    }


async def _bump_project_index_revision(project_id: str) -> None:
    db_manager = get_db_manager()
    for kind, indexer in (
        ("audio_vector", _get_active_audio_indexer(project_id)),
        ("text_vector", _get_active_text_indexer(project_id)),
    ):
        db_manager.upsert_index_manifest(
            project_id,
            kind,
            **_manifest_update_values(indexer.get_manifest()),
            revision_increment=1,
        )
    try:
        await _get_project_searcher(project_id).clear_cache()
    except Exception as exc:
        logger.debug(f"索引版本已更新，旧搜索缓存将自然失效: {exc}")


def _find_mapping_by_path(
    mappings: Sequence[Mapping[str, Any]], folder_path: str
) -> Optional[Mapping[str, Any]]:
    target = canonicalize_path(folder_path)
    return next(
        (
            mapping for mapping in mappings
            if canonicalize_path(str(mapping.get("folder_path") or "")) == target
        ),
        None,
    )


def _invalidate_text_metadata_for_paths_locked(
    project_id: str,
    folder_paths: Sequence[str],
    background_tasks: BackgroundTasks,
) -> Dict[str, Any]:
    """Invalidate affected metadata and enqueue repair while caller holds the lock."""
    db_manager = get_db_manager()
    affected = db_manager.mark_text_artifacts_for_folders(
        project_id, folder_paths, "stale"
    )
    if not affected:
        return {"affected_files": 0, "reindex_job_id": None}

    db_manager.upsert_index_manifest(
        project_id,
        "text_vector",
        state="stale",
        revision_increment=1,
    )
    # Reset, rather than instantiate, the project-scoped search clients.  A
    # subsequent request will observe the new manifest revision in its cache
    # key while the active collection remains searchable during reconciliation.
    from core.search_engine import reset_optimized_searcher
    from core.ai_chat_service import reset_ai_chat_service

    reset_optimized_searcher(project_id)
    reset_ai_chat_service(project_id)
    job_id = db_manager.create_job(project_id, "index_reconcile", affected)
    background_tasks.add_task(
        _repair_index_task,
        job_id,
        project_id,
        ["text_vector"],
        "reconcile",
    )
    return {"affected_files": affected, "reindex_job_id": job_id}


async def _flush_vector_batch(
    pending: List[Tuple[str, str, Dict[str, Any], Optional[str]]],
    project_id: str,
) -> int:
    """Batch-encode audio vectors (one GPU forward per 32 files) and mark
    artifact state per file. ``pending`` items are
    (file_uuid, file_path, metadata, source_fingerprint)."""
    if not pending:
        return 0
    indexer = _get_active_audio_indexer(project_id)
    db_manager = get_db_manager()
    entries = [(file_path, file_uuid, _meta) for file_uuid, file_path, _meta, _fp in pending]
    try:
        ok_ids = await _run_model_work(indexer.add_audio_batch, entries)
    except Exception as exc:
        logger.warning(f"批量音频向量索引异常（{len(pending)} 条）: {exc}")
        for file_uuid, _path, _meta, source_fp in pending:
            db_manager.set_artifact_state(
                project_id, file_uuid, "audio_vector", "failed",
                source_fingerprint=source_fp,
                error_code="audio_index_failed", error_message=str(exc),
            )
        return 0
    ok_set = set(ok_ids)
    for file_uuid, _path, _meta, source_fp in pending:
        ok = file_uuid in ok_set
        db_manager.set_artifact_state(
            project_id, file_uuid, "audio_vector",
            "ready" if ok else "failed",
            source_fingerprint=source_fp,
            engine_fingerprint=(
                indexer.get_manifest().get("engine_fingerprint") if ok else None
            ),
            error_code=None if ok else "audio_index_failed",
            error_message=None if ok else "CLAP indexer returned false",
        )
    return len(ok_set)


async def _flush_text_batch(
    pending: List[Tuple[str, Any, str]],
    project_id: str,
    folder_context: Optional[Sequence[Mapping[str, Any]]],
) -> int:
    """Batch upsert metadata-text vectors (one API call per batch)."""
    if not pending:
        return 0
    db_manager = get_db_manager()
    indexer = _get_active_text_indexer(project_id)
    metadatas = []
    for file_uuid, audio_file, tags in pending:
        record = db_manager.get_file_by_uuid(file_uuid, project_id)
        source_fp = record.source_fingerprint if record else None
        metadatas.append(_build_text_metadata_payload(
            project_id, file_uuid, audio_file,
            tags=tags, source_fingerprint=source_fp, folder_context=folder_context,
        ))
    try:
        result = await indexer.upsert_metadata(metadatas)
        fingerprint = result.get("fingerprint")
        for file_uuid, _audio_file, _tags in pending:
            record = db_manager.get_file_by_uuid(file_uuid, project_id)
            db_manager.set_artifact_state(
                project_id, file_uuid, "text_vector", "ready",
                source_fingerprint=record.source_fingerprint if record else None,
                engine_fingerprint=fingerprint,
            )
        return result.get("indexed", 0)
    except Exception as exc:
        logger.warning(f"批量文本向量索引异常（{len(pending)} 条）: {exc}")
        for file_uuid, _audio_file, _tags in pending:
            record = db_manager.get_file_by_uuid(file_uuid, project_id)
            db_manager.set_artifact_state(
                project_id, file_uuid, "text_vector", "failed",
                source_fingerprint=record.source_fingerprint if record else None,
                error_code="text_index_failed", error_message=str(exc),
            )
        return 0


async def _scan_and_import_task(
    task_id: str,
    folder_path: str,
    recursive: bool,
    client_id: str,
    project_id: str,
    skip_existing: bool = False,
):
    if project_id in _projects_deleting:
        get_db_manager().update_job(
            task_id, state="cancelled", stage="project_deleting"
        )
        return
    async with _get_project_index_lock(project_id):
        if project_id in _projects_deleting or not get_db_manager().get_project(project_id):
            get_db_manager().update_job(
                task_id, state="cancelled", stage="project_deleting"
            )
            return
        await _scan_and_import_task_locked(
            task_id, folder_path, recursive, client_id, project_id, skip_existing
        )


async def _scan_and_import_task_locked(
    task_id: str,
    folder_path: str,
    recursive: bool,
    client_id: str,
    project_id: str,
    skip_existing: bool = False,
):
    """
    后台扫描导入任务

    执行流程：
    1. 扫描所有音频文件
    2. 检查文件是否已存在于数据库
    3. 对新文件计算波形峰值
    4. 写入 SQLite 数据库
    5. 通过 WebSocket 推送进度
    """
    from core.scanner import AudioScanner
    from core.audio_service import get_audio_service, AudioServiceError

    ws_manager = get_ws_manager()
    db_manager = get_db_manager()
    scanner = AudioScanner()
    audio_service = get_audio_service()

    logger.info(f"[SCAN_TASK] 任务ID: {task_id}, 文件夹: {folder_path}, 递归: {recursive}, 客户端: {client_id}, 工程: {project_id}")
    logger.info(f"[SCAN_TASK] ws_manager 连接数: {ws_manager.get_connection_count()}")
    logger.info(f"[SCAN_TASK] 活跃连接: {list(ws_manager.active_connections.keys())}")

    try:
        # 第一步：扫描所有文件
        logger.info(f"[SCAN_TASK] 发送扫描状态: 正在扫描文件...")
        await ws_manager.send_scan_status(
            client_id, task_id, "scanning", "正在扫描文件..."
        )
        logger.info(f"[SCAN_TASK] 扫描状态已发送，当前连接数: {ws_manager.get_connection_count()}")

        # Persist every supported path before probing it. A corrupt file is
        # still a durable library record with repairable failed artifacts.
        db_manager.update_job(task_id, state="running", stage="scanning")
        candidate_paths = await _run_audio_work(
            scanner.collect_audio_paths, folder_path, recursive
        )
        total = len(candidate_paths)
        db_manager.update_job(task_id, total=total)

        # 「只导入新文件」：必须在候选入库之前判定，否则准备阶段已经把记录写进去了。
        duplicate_pairs: set = set()
        if skip_existing:
            try:
                with db_manager.get_cursor() as cursor:
                    for row in cursor.execute(
                        "SELECT LOWER(filename), COALESCE(file_size,0) FROM files WHERE project_id=?",
                        (project_id,),
                    ):
                        duplicate_pairs.add((str(row[0]), int(row[1] or 0)))
                logger.info("[IMPORT] 只导入新文件模式：库里已有 %d 个文件名+大小组合", len(duplicate_pairs))
            except Exception as exc:
                logger.warning("[IMPORT] 读取重复集合失败，退化为全部导入: %s", exc)
                duplicate_pairs = set()
        duplicate_skipped = 0
        if duplicate_pairs:
            kept_paths, duplicate_skipped = _filter_duplicate_paths(candidate_paths, duplicate_pairs)
            logger.info(
                "[IMPORT] 准备阶段跳过重复 %d 个，待导入 %d 个", duplicate_skipped, len(kept_paths)
            )
            candidate_paths = kept_paths
            total = len(candidate_paths)
            db_manager.update_job(task_id, total=total)

        candidates: Dict[str, Dict[str, Any]] = {}
        added = 0
        # 每个文件都要入库/探测，这一段是导入最慢的部分。
        # 之前这里从不更新 processed，前端只能看到"共 N 条"却一直没有进度，
        # 用户会以为卡死。现在按时间节流上报进度（每 0.5 秒一次）。
        import time as _time

        _last_report = 0.0
        for candidate_index, candidate_path in enumerate(candidate_paths):
            if ws_manager.is_task_cancelled(task_id):
                db_manager.update_job(
                    task_id,
                    state="cancelled",
                    stage="cancelled",
                    processed=candidate_index,
                )
                return
            candidate = await _prepare_import_candidate(
                str(candidate_path),
                project_id,
                scanner,
                audio_service,
                import_root=folder_path,
            )
            candidates[canonicalize_path(str(candidate_path))] = candidate
            if not candidate["existing"]:
                added += 1

            now = _time.monotonic()
            if now - _last_report >= 0.5 or candidate_index + 1 == total:
                _last_report = now
                db_manager.update_job(
                    task_id,
                    stage="preparing",
                    processed=candidate_index + 1,
                    total=total,
                )

        # Decode/probe only after SQLite owns the candidate set.
        db_manager.update_job(task_id, stage="decoding", processed=total, total=total)
        audio_files, folder_structure = await _run_audio_work(
            scanner.scan_with_structure, folder_path, recursive
        )
        if duplicate_skipped:
            audio_files = [
                item for item in audio_files
                if canonicalize_path(item.path) in candidates
            ]
        decoded_keys = {canonicalize_path(item.path) for item in audio_files}
        probe_failures = [
            candidate for key, candidate in candidates.items() if key not in decoded_keys
        ]
        logger.info(
            f"[SCAN_TASK] 扫描完成，候选 {total} 个，"
            f"可解码 {len(audio_files)} 个，失败 {len(probe_failures)} 个"
        )

        # 发送扫描统计日志到前端
        await ws_manager.send_scan_log(
            client_id, task_id, 'info',
            f"扫描完成统计: 找到 {total} 个音频文件",
            {
                'total': total,
                'decodable': len(audio_files),
                'failed': len(probe_failures),
                'folder_path': folder_path,
            }
        )

        # 发送文件夹结构到前端
        await ws_manager.send_folder_structure(
            client_id, task_id, folder_structure.model_dump()
        )

        # 创建导入文件夹映射记录（未分类）
        try:
            from core.scanner import FolderNode

            def collect_folder_paths(node: FolderNode, paths: list):
                """递归收集所有文件夹路径"""
                if node.path:
                    paths.append(node.path)
                for child in node.children:
                    collect_folder_paths(child, paths)

            folder_paths = []
            collect_folder_paths(folder_structure, folder_paths)

            # 为每个文件夹创建映射记录（未分类，user_folder_id 为 None）
            for folder_path in folder_paths:
                db_manager.add_imported_folder_mapping(
                    project_id=project_id,
                    folder_path=folder_path,
                    user_folder_id=None,
                    folder_name=Path(folder_path).name
                )

            logger.info(f"[SCAN_TASK] 创建了 {len(folder_paths)} 个文件夹映射记录")
        except Exception as e:
            logger.warning(f"[SCAN_TASK] 创建文件夹映射记录失败: {e}")

        # Use one immutable mapping snapshot for this locked import.  Nested
        # mappings are already ordered longest-first by the helper.
        folder_context = _load_logical_folder_context(project_id)

        if total == 0:
            await ws_manager.send_scan_complete(
                client_id, task_id, 0, 0, 0, "未找到音频文件"
            )
            ws_manager.unregister_task(task_id)
            db_manager.update_job(task_id, state="completed", stage="done", processed=0)
            return

        logger.info(f"开始导入 {total} 个文件到 SQLite")

        # 第二步：逐个处理文件
        skipped = 0
        indexed = 0
        # 批量向量索引积攒队列（每满 32 条批量 GPU 编码 / 批量 API 调用）
        vector_pending: List[Tuple[str, str, Dict[str, Any], Optional[str]]] = []
        text_pending: List[Tuple[str, Any, str]] = []

        # 大批量导入：向量/文本索引整批交给后台对账，导入只负责入库 + 波形。
        # 逐批算 CLAP/BGE 会让导入慢到 250ms/文件（7 万条要好几个小时）。
        # 导入阶段不再逐条算 CLAP/BGE：大库会卡在进度框里几十分钟。
        # 现在导入只写库 + 波形，向量交给导入完成后的后台索引任务。
        defer_vectors = True if total >= 1 else False
        if defer_vectors:
            logger.info("[IMPORT] 文件数 %d 超过 %d，导入阶段跳过向量计算，交给后台批量处理",
                        total, IMPORT_INLINE_INDEX_LIMIT)

        _ws_loop_start = 0.0
        for i, audio_file in enumerate(audio_files):
            _iter_start = time.monotonic()
            # 检查是否取消
            if ws_manager.is_task_cancelled(task_id):
                await ws_manager.send_scan_complete(
                    client_id, task_id, total, added, i - added,
                    "用户取消"
                )
                ws_manager.unregister_task(task_id)
                db_manager.update_job(
                    task_id, state="cancelled", stage="cancelled", processed=i
                )
                return

            current_file = Path(audio_file.path).name
            progress_pct = int((i / total) * 100)

            # 发送进度 - 扫描阶段 (0-40%)
            await ws_manager.send_scan_progress(
                client_id, task_id, i, total, current_file, "scanning",
                progress=int(progress_pct * 0.4)
            )

            # Existing metadata is not sufficient evidence that waveform/vector
            # artifacts are healthy. Reconcile it instead of permanently skipping.
            candidate = candidates[canonicalize_path(audio_file.path)]
            existing_record = candidate["existing"]

            # 同名同大小且不是同一条记录 → 视为重复，跳过
            if skip_existing and duplicate_pairs and not existing_record:
                pair = (audio_file.filename.lower(), int(getattr(audio_file, "size", 0) or 0))
                if pair in duplicate_pairs:
                    duplicate_skipped += 1
                    if duplicate_skipped <= 5:
                        logger.info("[IMPORT] 跳过重复文件: %s", audio_file.filename)
                    await ws_manager.send_scan_progress(
                        client_id, task_id, i, total, current_file, "skipped",
                        progress=int(40 + progress_pct * 0.3),
                    )
                    continue

            # 发送进度 - 分析阶段 (40-70%)
            await ws_manager.send_scan_progress(
                client_id, task_id, i, total, current_file, "analyzing",
                progress=int(40 + progress_pct * 0.3)
            )

            # 计算波形峰值
            peaks_json = None
            waveform_fingerprint = None
            waveform_version = 0
            source_fingerprint = None
            waveform_error = None
            try:
                source_fp = await _run_audio_work(
                    audio_service.fingerprint, audio_file.path
                )
                source_fingerprint = source_fp.source_key
                cached_is_current = bool(
                    existing_record
                    and existing_record.get_peaks()
                    and existing_record.source_fingerprint == source_fingerprint
                    and str(existing_record.waveform_version) == str(source_fp.waveform_version)
                )
                if not cached_is_current:
                    waveform = await _run_audio_work(
                        audio_service.waveform, audio_file.path
                    )
                    peaks_json = json.dumps(waveform.peaks)
                    waveform_fingerprint = waveform.fingerprint.key
                    waveform_version = int(waveform.fingerprint.waveform_version)
                else:
                    skipped += 1
            except AudioServiceError as e:
                logger.warning(f"计算波形失败 {audio_file.path}: {e.message}")
                waveform_error = e

            # 发送进度 - 保存到数据库阶段 (70-85%)
            await ws_manager.send_scan_progress(
                client_id, task_id, i, total, current_file, "saving",
                progress=int(70 + progress_pct * 0.15)
            )

            _t_write_start = time.monotonic()
            # 写入数据库（使用当前工程ID）
            record = AudioFileRecord(
                path=audio_file.path,
                filename=audio_file.filename,
                duration=audio_file.duration,
                sample_rate=audio_file.sample_rate,
                channels=audio_file.channels,
                file_size=audio_file.size,
                peaks_json=peaks_json,
                tags='[]',
                source_fingerprint=source_fingerprint,
                waveform_fingerprint=waveform_fingerprint,
                waveform_version=waveform_version,
            )
            file_uuid = await _run_audio_work(
                db_manager.upsert_file, record, project_id
            )
            if file_uuid:
                if waveform_error:
                    db_manager.set_artifact_state(
                        project_id,
                        file_uuid,
                        "waveform",
                        "failed",
                        source_fingerprint=source_fingerprint,
                        error_code=waveform_error.code,
                        error_message=waveform_error.message,
                    )
                if added and (i + 1) % 10 == 0:
                    logger.info(f"[SCAN_TASK] 已添加 {added} 个文件，当前: {current_file}")

                # 发送进度 - 向量索引阶段 (85-100%)
                await ws_manager.send_scan_progress(
                    client_id, task_id, i, total, current_file, "indexing",
                    progress=int(85 + progress_pct * 0.15)
                )

                try:
                    if is_embedder_available() and not defer_vectors:
                        vector_pending.append((
                            file_uuid,
                            audio_file.path,
                            {
                                "filename": audio_file.filename,
                                "duration": audio_file.duration,
                                "sample_rate": audio_file.sample_rate,
                                "channels": audio_file.channels,
                                "format": audio_file.format,
                                "size": audio_file.size,
                                "project_id": project_id,
                                "file_id": file_uuid,
                            },
                            source_fingerprint,
                        ))
                        if len(vector_pending) >= 32:
                            indexed += await _flush_vector_batch(vector_pending, project_id)
                            vector_pending = []
                    elif defer_vectors:
                        db_manager.set_artifact_state(
                            project_id, file_uuid, "audio_vector", "pending",
                            source_fingerprint=source_fingerprint,
                        )
                except Exception as e:
                    logger.warning(f"生成语义索引失败 {audio_file.path}: {e}")
                    db_manager.set_artifact_state(
                        project_id, file_uuid, "audio_vector", "failed",
                        error_code="audio_index_failed", error_message=str(e),
                    )
                if defer_vectors:
                    db_manager.set_artifact_state(
                        project_id, file_uuid, "text_vector", "pending",
                        source_fingerprint=source_fingerprint,
                    )
                else:
                    text_pending.append((file_uuid, audio_file, existing_record.tags if existing_record else "[]"))
                    if len(text_pending) >= 32:
                        await _flush_text_batch(text_pending, project_id, folder_context)
                        text_pending = []
            _t_before_job = time.monotonic()
            db_manager.update_job(task_id, processed=i + 1, stage="indexing")
            if os.getenv("ECHOMIND_IMPORT_PROFILE") == "1" and i < 40:
                logger.info(
                    "[IMPORT_PROFILE] %s iter=%.0fms write=%.0fms job=%.0fms",
                    audio_file.filename,
                    (time.monotonic() - _iter_start) * 1000,
                    (_t_before_job - _t_write_start) * 1000,
                    (time.monotonic() - _t_before_job) * 1000,
                )

        if defer_vectors:
            try:
                await asyncio.sleep(1.0)
                _schedule_project_reconcile(project_id, ("audio_vector", "text_vector"), reason="bulk_import")
                logger.info("[IMPORT] 已调度后台批量索引")
            except Exception as exc:
                logger.debug("调度批量索引失败: %s", exc)

        # 循环结束：flush 剩余的批量向量/文本索引
        if vector_pending:
            indexed += await _flush_vector_batch(vector_pending, project_id)
            vector_pending = []
        if text_pending:
            await _flush_text_batch(text_pending, project_id, folder_context)
            text_pending = []

        for failure_index, candidate in enumerate(probe_failures, start=len(audio_files)):
            if ws_manager.is_task_cancelled(task_id):
                db_manager.update_job(
                    task_id,
                    state="cancelled",
                    stage="cancelled",
                    processed=failure_index,
                )
                return
            await _record_probe_failure(
                project_id, candidate, folder_context=folder_context
            )
            db_manager.update_job(
                task_id,
                processed=failure_index + 1,
                stage="failed_item",
            )
            await ws_manager.send_scan_progress(
                client_id,
                task_id,
                failure_index + 1,
                total,
                candidate["audio_file"].filename,
                "failed",
                progress=int(((failure_index + 1) / total) * 100),
            )

        await _bump_project_index_revision(project_id)
        if duplicate_skipped:
            logger.info(f"其中 {duplicate_skipped} 个因同名同大小已在库中而跳过")
        await ws_manager.send_scan_complete(
            client_id, task_id, total, added, skipped + duplicate_skipped,
            "已跳过重复文件" if duplicate_skipped else None,
        )
        ws_manager.unregister_task(task_id)
        db_manager.update_job(
            task_id,
            state="completed",
            stage="done",
            processed=total,
            error_message=(
                f"{len(probe_failures)} files failed to decode"
                if probe_failures else None
            ),
        )
        logger.info(f"导入完成: 新增 {added} 个文件，跳过 {skipped} 个")

        # 后台补索引：不在导入流程里做，避免界面卡死
        if added:
            try:
                index_job = db_manager.create_job(project_id, "post_import_index", added)
                await _bump_project_index_revision(project_id)
                asyncio.create_task(
                    _repair_index_task(
                        index_job,
                        project_id,
                        ["audio_vector", "text_vector"],
                        "reconcile",
                    )
                )
                logger.info("[IMPORT] 已排入后台索引任务: %s", index_job)
            except Exception as exc:
                logger.warning("[IMPORT] 排入后台索引失败: %s", exc)

    except Exception as e:
        logger.error(f"扫描导入失败: {e}")
        db_manager.update_job(
            task_id, state="failed", stage="failed",
            error_code="import_failed", error_message=str(e),
        )
        await ws_manager.send_scan_error(client_id, task_id, str(e))
        ws_manager.unregister_task(task_id)


# ==================== SQLite 数据库 API ====================

@app.get("/api/v1/db/files")
async def get_all_db_files(
    limit: int = Query(default=200, ge=1, le=500),
    cursor: Optional[int] = Query(default=None, ge=1),
):
    """
    从 SQLite 获取当前工程的所有文件列表（启动时加载）

    返回格式：
    {
        "total": 1000,
        "files": [
            {
                "path": "/path/to/file.wav",
                "filename": "file.wav",
                "duration": 12.5,
                "sample_rate": 48000,
                "channels": 2,
                "size": 1234567,
                "peaks": [0.1, 0.2, ...],  # 波形峰值数组
                "tags": ["标签1", "标签2"],
                "created_at": "2024-01-01T00:00:00"
            }
        ]
    }
    """
    try:
        db_manager = get_db_manager()
        current_project_id = getattr(config, 'CURRENT_PROJECT_ID', 'default')
        items, next_cursor = db_manager.get_files_cursor_page(
            current_project_id, limit=limit, before_id=cursor
        )
        for item in items:
            item["size"] = item.pop("file_size")
            # Compatibility marker: absence is null, never an empty truthy array.
            item["peaks"] = None
        return {
            "project_id": current_project_id,
            "total": db_manager.get_file_count(current_project_id),
            "files": items,
            "next_cursor": next_cursor,
        }
    except Exception as e:
        logger.error(f"获取文件列表失败: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/api/v1/db/file/{path:path}")
async def get_db_file(path: str):
    """
    获取单个文件详情

    - **path**: URL 编码的文件路径
    """
    file_path = path

    db_manager = get_db_manager()
    current_project_id = getattr(config, 'CURRENT_PROJECT_ID', 'default')
    record = db_manager.get_file(file_path, current_project_id)

    if not record:
        raise HTTPException(status_code=404, detail="文件不存在")

    return {
        "id": record.file_uuid,
        "path": record.path,
        "filename": record.filename,
        "duration": record.duration,
        "sample_rate": record.sample_rate,
        "channels": record.channels,
        "size": record.file_size,
        "peaks": record.get_peaks(),
        "tags": record.get_tags(),
        "created_at": record.created_at
    }


@app.put("/api/v1/db/file/{path:path}/tags")
async def update_file_tags(
    path: str,
    background_tasks: BackgroundTasks,
    payload: schemas.TagsRequest | List[str] = Body(...),
):
    """
    更新文件标签

    - **path**: URL 编码的文件路径
    - **tags**: 新的标签列表
    """
    file_path = path
    tags = payload.tags if isinstance(payload, schemas.TagsRequest) else payload

    db_manager = get_db_manager()
    current_project_id = getattr(config, 'CURRENT_PROJECT_ID', 'default')
    if current_project_id in _projects_deleting:
        raise SoundBotAPIError("project_deleting", "工程正在删除", status_code=409)
    async with _get_project_index_lock(current_project_id):
        success = db_manager.update_tags(file_path, tags, current_project_id)

        if not success:
            raise HTTPException(status_code=404, detail="文件不存在")
        # 说明：files.tags（6 维标签）和「我的标签」（tags/file_tags）是两套，
        # 这里不再互相同步——按用户要求分开管理。
        try:
            await _get_project_searcher(current_project_id).clear_cache()
        except Exception as exc:
            logger.debug(f"清理搜索缓存失败: {exc}")
        job_id = db_manager.create_job(current_project_id, "text_metadata_refresh", 1)
        background_tasks.add_task(
            _repair_index_task,
            job_id,
            current_project_id,
            ["text_vector"],
            "reconcile",
        )
    return {"success": True, "message": "标签已更新", "job_id": job_id}


@app.get("/api/v1/descriptions/stats")
async def ai_description_stats():
    """AI 一句话描述完成统计（批量生成进度用）。"""
    db_manager = get_db_manager()
    current_project_id = getattr(config, 'CURRENT_PROJECT_ID', 'default')
    stats = db_manager.ai_description_stats(current_project_id)
    return {"success": True, **stats}


@app.post("/api/v1/descriptions/batch")
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
    if current_project_id in _projects_deleting:
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


@app.post("/api/v1/descriptions/generate")
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


@app.get("/api/v1/db/tags")
async def list_tags():
    """列出工程内所有标签及使用次数（标签管理面板用）。"""
    db_manager = get_db_manager()
    current_project_id = getattr(config, 'CURRENT_PROJECT_ID', 'default')
    tags = db_manager.list_all_tags(current_project_id)
    return {"success": True, "tags": tags, "total": len(tags)}


@app.put("/api/v1/db/tags/batch")
async def batch_set_tags(
    payload: schemas.BatchTagsRequest,
    background_tasks: BackgroundTasks,
):
    """批量设置标签：同一组标签应用到多个文件路径。"""
    db_manager = get_db_manager()
    current_project_id = getattr(config, 'CURRENT_PROJECT_ID', 'default')
    if current_project_id in _projects_deleting:
        raise SoundBotAPIError("project_deleting", "工程正在删除", status_code=409)
    tags = [str(t).strip() for t in payload.tags if str(t).strip()]
    async with _get_project_index_lock(current_project_id):
        applied = 0
        for path in payload.paths:
            if db_manager.update_tags(path, tags, current_project_id):
                applied += 1
        try:
            await _get_project_searcher(current_project_id).clear_cache()
        except Exception as exc:
            logger.debug(f"清理搜索缓存失败: {exc}")
        job_id = db_manager.create_job(current_project_id, "text_metadata_refresh", 1)
        background_tasks.add_task(
            _repair_index_task,
            job_id,
            current_project_id,
            ["text_vector"],
            "reconcile",
        )
    return {"success": True, "message": f"已更新 {applied} 个文件标签", "applied": applied, "job_id": job_id}


@app.patch("/api/v1/db/tags")
async def rename_tag(
    payload: schemas.RenameTagRequest,
    background_tasks: BackgroundTasks,
):
    """全局重命名标签。"""
    db_manager = get_db_manager()
    current_project_id = getattr(config, 'CURRENT_PROJECT_ID', 'default')
    if current_project_id in _projects_deleting:
        raise SoundBotAPIError("project_deleting", "工程正在删除", status_code=409)
    async with _get_project_index_lock(current_project_id):
        affected_uuids = []
        try:
            with db_manager.get_cursor() as cursor:
                affected_uuids = [
                    row[0] for row in cursor.execute(
                        "SELECT file_uuid FROM files WHERE project_id=? AND tags LIKE ?",
                        (current_project_id, f'%"{payload.old}"%'),
                    ).fetchall()
                ]
        except Exception as exc:
            logger.debug(f"收集改名受影响的文件失败: {exc}")
        changed = db_manager.rename_tag(current_project_id, payload.old, payload.new)
        try:
            await _get_project_searcher(current_project_id).clear_cache()
        except Exception as exc:
            logger.debug(f"清理搜索缓存失败: {exc}")
        if changed > 0:
            job_id = db_manager.create_job(current_project_id, "text_metadata_refresh", 1)
            background_tasks.add_task(
                _repair_index_task,
                job_id,
                current_project_id,
                ["text_vector"],
                "reconcile",
            )
    return {"success": True, "message": f"已重命名标签，影响 {changed} 个文件", "changed": changed}


@app.delete("/api/v1/db/tags/{tag}")
async def delete_tag(tag: str, background_tasks: BackgroundTasks):
    """全局删除标签（从所有文件移除）。"""
    db_manager = get_db_manager()
    current_project_id = getattr(config, 'CURRENT_PROJECT_ID', 'default')
    if current_project_id in _projects_deleting:
        raise SoundBotAPIError("project_deleting", "工程正在删除", status_code=409)
    async with _get_project_index_lock(current_project_id):
        affected_uuids = []
        try:
            with db_manager.get_cursor() as cursor:
                affected_uuids = [
                    row[0] for row in cursor.execute(
                        "SELECT file_uuid FROM files WHERE project_id=? AND tags LIKE ?",
                        (current_project_id, f'%"{tag}"%'),
                    ).fetchall()
                ]
        except Exception as exc:
            logger.debug(f"收集删标签受影响的文件失败: {exc}")
        changed = db_manager.delete_tag(current_project_id, tag)
        try:
            await _get_project_searcher(current_project_id).clear_cache()
        except Exception as exc:
            logger.debug(f"清理搜索缓存失败: {exc}")
        if changed > 0:
            for file_uuid in affected_uuids:
                db_manager.sync_layers_from_files_tags(current_project_id, file_uuid=file_uuid)
            job_id = db_manager.create_job(current_project_id, "text_metadata_refresh", 1)
            background_tasks.add_task(
                _repair_index_task,
                job_id,
                current_project_id,
                ["text_vector"],
                "reconcile",
            )
    return {"success": True, "message": f"已删除标签，影响 {changed} 个文件", "changed": changed}


@app.post("/api/v1/db/file/{path:path}/rename")
async def rename_db_file(
    path: str,
    payload: schemas.RenameFileRequest,
    background_tasks: BackgroundTasks,
):
    """重命名文件记录（磁盘文件重命名由 Electron 主进程完成，此处同步数据库）。"""
    db_manager = get_db_manager()
    current_project_id = getattr(config, 'CURRENT_PROJECT_ID', 'default')
    if current_project_id in _projects_deleting:
        raise SoundBotAPIError("project_deleting", "工程正在删除", status_code=409)
    async with _get_project_index_lock(current_project_id):
        success = db_manager.rename_file(path, payload.new_name, current_project_id)
        if not success:
            raise HTTPException(status_code=404, detail="文件不存在")
        try:
            await _get_project_searcher(current_project_id).clear_cache()
        except Exception as exc:
            logger.debug(f"清理搜索缓存失败: {exc}")
        job_id = db_manager.create_job(current_project_id, "text_metadata_refresh", 1)
        background_tasks.add_task(
            _repair_index_task,
            job_id,
            current_project_id,
            ["text_vector"],
            "reconcile",
        )
    return {"success": True, "message": "文件已重命名", "job_id": job_id}


# ==================== 声音配方（本地分层合成） ====================

_RECIPE_CACHE: Dict[str, Any] = {}
_RECIPE_DEFS = [
    {
        "id": "amb_wind",
        "synth": "wind",
        "name": "风与气流",
        "category": "环境音",
        "mode": "env",
        "labels": ["远处 · 微风", "远处 · 强风", "近处 · 微风", "近处 · 强风"],
        "queries": [
            {"layer": "base", "label": "柔风底声", "q": "风", "prob": 1.0, "gain_db": -8.0,
             "trim_seconds": 1.6, "strength_gain": 3.0, "require": ["风"]},
            {"layer": "gust", "label": "阵风细节", "q": "阵风", "prob": 0.25, "gain_db": -12.0,
             "trim_seconds": 1.2, "strength_gain": 4.0, "prob_min": 0.15, "prob_max": 0.8,
             "require": ["阵风", "风"]},
            {"layer": "strong", "label": "强风气流", "q": "大风", "prob": 0.2, "gain_db": -10.0,
             "trim_seconds": 1.4, "strength_gain": 9.0, "prob_min": 0.08, "prob_max": 0.9,
             "require": ["大风", "呼啸", "风"]},
            {"layer": "accent", "label": "点缀音", "q": "树叶", "prob": 0.08, "gain_db": -16.0,
             "trim_seconds": 0.6, "prob_min": 0.03, "prob_max": 0.35,
             "require": ["树叶", "沙沙"]},
        ],
    },
    {
        "id": "amb_rain",
        "synth": "rain",
        "name": "雨天",
        "category": "环境音",
        "mode": "env",
        "labels": ["远处 · 细雨", "远处 · 暴雨", "近处 · 细雨", "近处 · 暴雨"],
        "queries": [
            {"layer": "base", "label": "雨声底噪", "q": "雨", "prob": 1.0, "gain_db": -8.0,
             "trim_seconds": 2.0, "strength_gain": 3.0, "require": ["雨"]},
            {"layer": "gust", "label": "雨点细节", "q": "雨滴", "prob": 0.4, "gain_db": -14.0,
             "trim_seconds": 1.2, "prob_min": 0.2, "prob_max": 0.9, "require": ["雨滴", "雨"]},
            {"layer": "strong", "label": "雷声", "q": "雷", "prob": 0.12, "gain_db": -8.0,
             "trim_seconds": 2.0, "strength_gain": 6.0, "prob_min": 0.02, "prob_max": 0.35,
             "require": ["雷"]},
        ],
    },
    {
        "id": "amb_forest",
        "synth": "forest",
        "name": "林间鸟鸣",
        "category": "环境音",
        "mode": "env",
        "labels": ["远处 · 稀疏鸟鸣", "远处 · 密集鸟鸣", "近处 · 稀疏鸟鸣", "近处 · 密集鸟鸣"],
        "queries": [
            {"layer": "base", "label": "林间底噪", "q": "树林", "prob": 1.0, "gain_db": -10.0,
             "trim_seconds": 2.0, "strength_gain": 2.0, "require": ["树林", "森林"]},
            {"layer": "gust", "label": "鸟鸣", "q": "鸟叫", "prob": 0.5, "gain_db": -10.0,
             "trim_seconds": 1.2, "prob_min": 0.15, "prob_max": 0.95, "require": ["鸟"]},
            {"layer": "strong", "label": "虫声", "q": "虫鸣", "prob": 0.3, "gain_db": -14.0,
             "trim_seconds": 1.2, "prob_min": 0.05, "prob_max": 0.6, "require": ["虫"]},
        ],
    },
    {
        "id": "amb_sea",
        "synth": "sea",
        "name": "海边浪潮",
        "category": "环境音",
        "mode": "env",
        "labels": ["远处 · 平静", "远处 · 巨浪", "近处 · 平静", "近处 · 巨浪"],
        "queries": [
            {"layer": "base", "label": "海浪底声", "q": "海浪", "prob": 1.0, "gain_db": -8.0,
             "trim_seconds": 2.4, "strength_gain": 4.0, "require": ["海浪", "海"]},
            {"layer": "gust", "label": "浪花细节", "q": "浪花", "prob": 0.45, "gain_db": -12.0,
             "trim_seconds": 1.2, "prob_min": 0.15, "prob_max": 0.9, "require": ["浪花", "海水"]},
            {"layer": "strong", "label": "海风", "q": "海风", "prob": 0.2, "gain_db": -14.0,
             "trim_seconds": 1.4, "strength_gain": 5.0, "prob_min": 0.05, "prob_max": 0.5, "require": ["海风"]},
        ],
    },
    {
        "id": "amb_fire",
        "synth": "fire",
        "name": "篝火燃烧",
        "category": "环境音",
        "mode": "env",
        "labels": ["远处 · 小火", "远处 · 大火", "近处 · 小火", "近处 · 大火"],
        "queries": [
            {"layer": "base", "label": "火焰底声", "q": "火", "prob": 1.0, "gain_db": -10.0,
             "trim_seconds": 2.0, "strength_gain": 3.0, "require": ["火"]},
            {"layer": "gust", "label": "噼啪细节", "q": "噼啪", "prob": 0.5, "gain_db": -12.0,
             "trim_seconds": 0.6, "prob_min": 0.15, "prob_max": 0.9, "require": ["噼啪", "燃烧"]},
        ],
    },
    {
        "id": "footstep_wood",
        "name": "木板脚步",
        "category": "脚步",
        "queries": [
            {"layer": "step", "q": "脚步", "prob": 1.0, "gain_db": 0.0, "pitch_span": 0.02,
             "trim_seconds": 0.55, "require": ["脚步", "步", "footstep"]},
        ],
    },
    {
        "id": "footstep_concrete",
        "name": "水泥脚步",
        "category": "脚步",
        "queries": [
            {"layer": "step", "q": "脚步", "prob": 1.0, "pitch_span": 0.02,
             "trim_seconds": 0.55, "require": ["脚步", "步", "footstep"]},
        ],
    },
    {
        "id": "door_wood",
        "name": "木门开关",
        "category": "门与开关",
        "queries": [
            {"layer": "open", "q": "开门", "prob": 1.0, "pitch_span": 0.04, "trim_seconds": 2.2,
             "require": ["开门", "门"]},
            {"layer": "latch", "q": "咔哒", "prob": 0.25, "gain_db": -14.0, "offset_ms": [120, 320],
             "trim_seconds": 0.5, "require": ["咔哒", "锁"]},
        ],
    },
]


def _get_recipe(recipe_id: str):
    from core.sound_recipe import build_from_library

    if recipe_id in _RECIPE_CACHE:
        return _RECIPE_CACHE[recipe_id]
    spec = next((d for d in _RECIPE_DEFS if d["id"] == recipe_id), None)
    if not spec:
        return None
    if spec.get("synth"):
        try:
            import threading as _threading

            from core.noise_ambience import warmup as _warmup

            _threading.Thread(target=_warmup, daemon=True).start()
        except Exception:
            pass

    recipe = build_from_library(
        spec["id"], spec["name"], spec["category"], spec["queries"],
        mode=spec.get("mode", "step"),
        synth=spec.get("synth", ""),
    )
    _RECIPE_CACHE[recipe_id] = recipe
    return recipe


@app.get("/api/v1/recipes")
async def list_recipes():
    """列出可用的声音配方（每层样本从用户自己的音效库自动组装）。"""
    _RECIPE_CACHE.clear()
    result = []
    for spec in _RECIPE_DEFS:
        recipe = _get_recipe(spec["id"])
        info = recipe.to_dict() if recipe else {"id": spec["id"], "name": spec["name"], "category": spec["category"], "layers": []}
        info["labels"] = spec.get("labels") or []
        info["usable"] = bool(recipe and (recipe.layers or recipe.synth))
        result.append(info)
    return {"success": True, "recipes": result}


def _serve_recipe_audio(samples) -> Dict[str, Any]:
    import tempfile
    from core.sound_recipe import to_wav_bytes

    wav = to_wav_bytes(samples)
    directory = Path(tempfile.gettempdir()) / "echomind_recipe"
    directory.mkdir(parents=True, exist_ok=True)
    name = f"recipe_{uuid.uuid4().hex[:10]}.wav"
    path = directory / name
    path.write_bytes(wav)
    return {
        "url": f"/api/v1/temp-audio/recipe/{name}",
        "file_path": str(path),
        "duration": round(len(samples) / 48000.0, 3),
        "bytes": len(wav),
    }


@app.get("/api/v1/temp-audio/recipe/{name}")
async def serve_recipe_audio(name: str):
    """把临时生成的配方音频回传给界面试听。"""
    from fastapi.responses import FileResponse
    import tempfile
    import re

    if not re.fullmatch(r"recipe_[0-9a-f]{10}\.wav", name):
        raise HTTPException(status_code=400, detail="非法文件名")
    path = Path(tempfile.gettempdir()) / "echomind_recipe" / name
    if not path.exists():
        raise HTTPException(status_code=404, detail="音频不存在")
    return FileResponse(str(path), media_type="audio/wav")


@app.get("/api/v1/recipes/{recipe_id}/samples")
async def recipe_samples(recipe_id: str):
    """列出配方可选的单个素材（「选择素材」用）。"""
    from core.sound_recipe import list_recipe_samples

    recipe = _get_recipe(recipe_id)
    if recipe is None:
        raise HTTPException(status_code=404, detail="配方不存在")
    return {"success": True, "samples": list_recipe_samples(recipe)}


@app.post("/api/v1/recipes/{recipe_id}/hit")
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


@app.post("/api/v1/recipes/{recipe_id}/stems")
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


@app.get("/api/v1/temp-audio/stems/{name}")
async def serve_stem_audio(name: str):
    """回传音轨；带上 CORS 头，方便前端用 WebAudio/audio 标签播放。"""
    from fastapi.responses import FileResponse
    from core.noise_ambience import is_servable_stem_name

    if not is_servable_stem_name(name):
        raise HTTPException(status_code=400, detail="非法文件名")
    path = Path(tempfile.gettempdir()) / "echomind_stems" / name
    if not path.exists():
        raise HTTPException(status_code=404, detail="音轨不存在")
    return FileResponse(str(path), media_type="audio/wav", headers={"Access-Control-Allow-Origin": "*"})


@app.post("/api/v1/recipes/{recipe_id}/ambience")
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


@app.post("/api/v1/recipes/{recipe_id}/session")
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


@app.post("/api/v1/sfx/generate")
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

    tmp_dir = Path(tempfile.gettempdir()) / "soundbot_sfx"
    tmp_dir.mkdir(parents=True, exist_ok=True)
    gen_id = _uuid.uuid4().hex[:12]
    suffix = {"wav": ".wav", "mp3": ".mp3", "pcm": ".pcm", "ogg_opus": ".ogg"}.get(fmt, ".mp3")
    tmp_path = tmp_dir / f"sfx_{gen_id}{suffix}"
    try:
        tmp_path.write_bytes(audio)
    except Exception as exc:
        logger.error("写入临时音效失败: %s", exc)
        raise HTTPException(status_code=502, detail=f"写入失败: {exc}")
    return {
        "generation_id": gen_id,
        "audio_path": str(tmp_path),
        "duration": duration,
        "size": len(audio),
        "text_prompt": text_prompt,
    }


@app.post("/api/v1/sfx/save")
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


@app.get("/api/v1/sfx/config")
async def sfx_get_config():
    """获取音频生成（豆包语音）配置状态。"""
    from core.sfx_generator import is_configured, get_save_dir

    return {
        "success": True,
        "configured": is_configured(),
        "save_dir": str(get_save_dir()),
        "base_url": "https://openspeech.bytedance.com/api/v3/tts/create",
    }


@app.post("/api/v1/sfx/config")
async def sfx_save_config(request: Dict[str, Any]):
    """保存音频生成（豆包语音）配置。入参: api_key, save_dir(可选)。"""
    from core.sfx_generator import save_config

    api_key = str(request.get("api_key") or "").strip()
    save_dir = str(request.get("save_dir") or "").strip()
    save_config(api_key=api_key, save_dir=save_dir)
    return {"success": True, "message": "音频生成配置已保存"}


@app.post("/api/v1/db/file/{path:path}/reanalyze")
async def reanalyze_db_file(path: str, background_tasks: BackgroundTasks):
    """重新分析单个素材：重建波形、音频向量、文本向量。"""
    db_manager = get_db_manager()
    current_project_id = getattr(config, 'CURRENT_PROJECT_ID', 'default')
    if current_project_id in _projects_deleting:
        raise SoundBotAPIError("project_deleting", "工程正在删除", status_code=409)
    async with _get_project_index_lock(current_project_id):
        record = db_manager.get_file(path, current_project_id)
        if not record:
            raise HTTPException(status_code=404, detail="文件不存在")
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
    return {"success": True, "message": "已提交重新分析", "job_id": job_id}


# ==================== 批量重命名 ====================

@app.post("/api/v1/files/rename")
async def batch_rename(
    payload: Dict[str, Any],
    background_tasks: BackgroundTasks,
    project_id: str = Query(default="default"),
):
    """批量重命名：先 dry_run 预览，确认后再动磁盘。"""
    import os as _os

    items = payload.get("items") or []
    dry_run = bool(payload.get("dry_run", True))
    if not isinstance(items, list) or not items:
        raise HTTPException(status_code=422, detail="items 不能为空")

    db_manager = get_db_manager()
    results = []
    seen_targets = set()

    for item in items:
        file_uuid = str(item.get("file_uuid") or "").strip()
        new_name = str(item.get("new_name") or "").strip()
        entry = {"file_uuid": file_uuid, "new_name": new_name, "ok": False, "message": ""}

        if not file_uuid or not new_name:
            entry["message"] = "参数缺失"
            results.append(entry)
            continue
        if any(ch in new_name for ch in '\\/:*?"<>|'):
            entry["message"] = "文件名包含非法字符"
            results.append(entry)
            continue

        with db_manager.get_cursor() as cursor:
            row = cursor.execute(
                "SELECT path, filename FROM files WHERE project_id=? AND file_uuid=?",
                (project_id, file_uuid),
            ).fetchone()
        if not row:
            entry["message"] = "文件不存在"
            results.append(entry)
            continue

        old_path = row[0]
        folder = _os.path.dirname(old_path)
        old_name = row[1] or _os.path.basename(old_path)
        ext = _os.path.splitext(old_name)[1]
        if not _os.path.splitext(new_name)[1]:
            new_name = new_name + ext
        new_path = _os.path.join(folder, new_name)
        entry["old_path"] = old_path
        entry["new_path"] = new_path

        if _os.path.normcase(new_path) in seen_targets:
            entry["message"] = "目标文件名重复"
            results.append(entry)
            continue
        seen_targets.add(_os.path.normcase(new_path))

        if _os.path.exists(new_path) and _os.path.normcase(new_path) != _os.path.normcase(old_path):
            entry["message"] = "目标文件已存在"
            results.append(entry)
            continue

        if dry_run:
            entry["ok"] = True
            entry["message"] = "可重命名"
            results.append(entry)
            continue

        try:
            _os.rename(old_path, new_path)
        except Exception as exc:
            entry["message"] = "磁盘重命名失败: " + str(exc)
            results.append(entry)
            continue

        try:
            with db_manager.get_cursor() as cursor:
                cursor.execute(
                    "UPDATE files SET path=?, filename=? WHERE project_id=? AND file_uuid=?",
                    (new_path, new_name, project_id, file_uuid),
                )
                cursor.connection.commit()
            db_manager.update_fts_row(file_uuid, project_id)
            # 文件名是文本向量的输入之一，改名后这条要重算
            db_manager.mark_artifacts_stale_for_file(project_id, file_uuid, ["text_vector"])
            entry["ok"] = True
            entry["message"] = "已重命名"
        except Exception as exc:
            entry["message"] = "数据库更新失败（文件已改名）: " + str(exc)
        results.append(entry)

    reindex_queued = False
    if not dry_run and any(r["ok"] for r in results):
        background_tasks.add_task(_deferred_reconcile, project_id, ["text_vector"], "rename")
        reindex_queued = True

    return {
        "success": all(r["ok"] for r in results),
        "dry_run": dry_run,
        "total": len(results),
        "done": sum(1 for r in results if r["ok"]),
        "results": results,
        "reindex_queued": reindex_queued,
    }


# ==================== 收藏 + 重复检测 ====================

@app.post("/api/v1/files/{file_uuid}/favorite")
async def set_favorite(file_uuid: str, payload: Dict[str, Any], project_id: str = Query(default="default")):
    db_manager = get_db_manager()
    value = bool(payload.get("favorite", True))
    ok = db_manager.set_favorite(project_id, file_uuid, value)
    return {"success": ok, "favorite": value}


@app.get("/api/v1/favorites")
async def list_favorites(project_id: str = Query(default="default"), limit: int = Query(default=500, le=2000)):
    db_manager = get_db_manager()
    files = db_manager.list_favorites(project_id, limit=limit)
    return {"success": True, "files": files, "total": len(files)}


@app.get("/api/v1/duplicates")
async def list_duplicates(project_id: str = Query(default="default"), limit: int = Query(default=20000, le=20000)):
    db_manager = get_db_manager()
    groups = db_manager.duplicate_groups(project_id, limit=limit)
    total_files = sum(g["count"] for g in groups)
    return {
        "success": True,
        "groups": groups,
        "group_count": len(groups),
        "file_count": total_files,
        "wasted_bytes": sum(
            (len(g["files"]) - 1) * int(g["files"][0].get("size") or 0) for g in groups
        ),
    }



_hash_task_running = False

DUPLICATE_BACKUP_DIRNAME = "duplicate-backups"


def _duplicate_backup_root() -> Path:
    """备份清单和副本都放在用户数据目录下，不和音效库混在一起。"""
    return Path(config.get_user_data_dir()) / DUPLICATE_BACKUP_DIRNAME


def _write_backup_manifest(entries, action: str, target_dir: str) -> Path:
    import json as _json
    import time as _time

    root = _duplicate_backup_root()
    (root / "manifests").mkdir(parents=True, exist_ok=True)
    stamp = _time.strftime("%Y%m%d-%H%M%S")
    manifest = root / "manifests" / f"{stamp}-{action}.json"
    index = 1
    while manifest.exists():
        manifest = root / "manifests" / f"{stamp}-{action}-{index}.json"
        index += 1
    manifest.write_text(
        _json.dumps(
            {
                "created_at": _time.strftime("%Y-%m-%dT%H:%M:%S"),
                "action": action,
                "target_dir": target_dir,
                "entries": entries,
            },
            ensure_ascii=False,
            indent=1,
        ),
        encoding="utf-8",
    )
    return manifest


@app.post("/api/v1/db/duplicates/resolve")
async def resolve_duplicates(payload: Dict[str, Any], project_id: str = Query(default="default")):
    """处理重复文件的"多余副本"。

    - backup：**复制**到备份目录（原文件与库记录都保留），并写一份可撤回的清单
    - records：只删库内记录，磁盘文件保留（重新导入即恢复）
    - source：源文件移入回收站并删记录（回收站可还原）

    判定重复用 sha256（字节级一致），所以留哪一份都不会丢内容。
    """
    import shutil
    from pathlib import Path

    paths = [str(item) for item in (payload.get("paths") or []) if str(item).strip()]
    action = str(payload.get("action") or "records").strip()
    target_dir = str(payload.get("target_dir") or "").strip()

    if not paths:
        raise HTTPException(status_code=422, detail="paths 不能为空")
    if action not in ("records", "source", "backup"):
        raise HTTPException(status_code=422, detail="action 只能是 records / source / backup")
    if action == "backup":
        if not target_dir:
            target_dir = str(_duplicate_backup_root() / "files")
        try:
            Path(target_dir).mkdir(parents=True, exist_ok=True)
        except Exception as exc:
            raise HTTPException(status_code=400, detail=f"无法创建备份目录: {exc}")

    db_manager = get_db_manager()
    moved = 0
    removed = 0
    failed = 0
    entries = []
    errors: List[str] = []

    for raw_path in paths:
        try:
            source = Path(raw_path)
            if action == "backup":
                if not source.exists():
                    errors.append(f"{raw_path}: 源文件不存在")
                    continue
                destination = Path(target_dir) / source.name
                index = 1
                while destination.exists():
                    destination = Path(target_dir) / f"{source.stem} ({index}){source.suffix}"
                    index += 1
                shutil.copy2(str(source), str(destination))
                entries.append({"original": raw_path, "backup": str(destination)})
                moved += 1
                continue

            if action == "source" and source.exists():
                _move_to_recycle_bin(source)
                moved += 1
            if db_manager.delete_file(raw_path, project_id):
                removed += 1
        except Exception as exc:
            failed += 1
            errors.append(f"{raw_path}: {exc}")
            logger.warning("处理重复文件失败 %s: %s", raw_path, exc)

    manifest_path = ""
    if action == "backup" and entries:
        manifest_path = str(_write_backup_manifest(entries, action, target_dir))

    try:
        await _get_project_searcher(project_id).clear_cache()
    except Exception as exc:
        logger.debug("清理搜索缓存失败: %s", exc)

    return {
        "success": True,
        "action": action,
        "requested": len(paths),
        "moved": moved,
        "removed": removed,
        "failed": failed,
        "errors": errors[:10],
        "target_dir": target_dir or None,
        "manifest": manifest_path,
    }



@app.post("/api/v1/db/folder/precheck")
async def precheck_folder_import(payload: Dict[str, Any], project_id: str = Query(default="default")):
    """导入前的重复预检：这个目录里有多少文件已经以"同名同大小"存在于库里。

    只看文件名 + 字节数，不读内容，所以很快；用来提醒"这个包可能已经导入过"。
    """
    from pathlib import Path

    folder = str(payload.get("path") or "").strip()
    if not folder:
        raise HTTPException(status_code=422, detail="path 不能为空")
    root = Path(folder)
    if not root.is_dir():
        raise HTTPException(status_code=404, detail="目录不存在")

    audio_exts = {'.wav', '.mp3', '.aac', '.m4a', '.wma', '.ogg', '.aiff', '.aif', '.flac', '.opus', '.ape', '.caf'}
    files = []
    try:
        for entry in root.rglob("*"):
            if not entry.is_file():
                continue
            if entry.suffix.lower() not in audio_exts:
                continue
            try:
                files.append((entry.name.lower(), entry.stat().st_size, str(entry)))
            except OSError:
                continue
            if len(files) >= 20000:
                break
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"读取目录失败: {exc}")

    if not files:
        return {"success": True, "total": 0, "existing": 0, "ratio": 0.0, "samples": [], "already_imported": False}

    db_manager = get_db_manager()
    names = sorted({name for name, _size, _path in files})
    existing_pairs = set()
    with db_manager.get_cursor() as cursor:
        for start in range(0, len(names), 400):
            chunk = names[start:start + 400]
            marks = ",".join("?" * len(chunk))
            rows = cursor.execute(
                f"SELECT LOWER(filename), COALESCE(file_size,0) FROM files "
                f"WHERE project_id=? AND LOWER(filename) IN ({marks})",
                (project_id, *chunk),
            ).fetchall()
            existing_pairs.update((str(row[0]), int(row[1] or 0)) for row in rows)

    matched = [path for name, size, path in files if (name, size) in existing_pairs]
    ratio = len(matched) / len(files)
    return {
        "success": True,
        "total": len(files),
        "existing": len(matched),
        "ratio": round(ratio, 3),
        "already_imported": ratio >= 0.9,
        "samples": matched[:5],
    }

async def _run_hash_backfill(project_id: str) -> None:
    """补算 sha256（大文件优先，限速避免打满机械盘）。可重复调用，跑完即退出。"""
    global _hash_task_running
    if _hash_task_running:
        return
    _hash_task_running = True
    try:
        from core.content_hash import sha256_file

        db = get_db_manager()
        while not _shutting_down:
            batch = await asyncio.to_thread(db.files_needing_hash, project_id, 60)
            if not batch:
                break
            for item in batch:
                digest = await asyncio.to_thread(sha256_file, item["path"])
                await asyncio.to_thread(
                    db.set_file_hash,
                    item["file_uuid"],
                    digest,
                    1 if digest else 2,
                )
            await asyncio.sleep(0.2)
        progress = await asyncio.to_thread(db.hash_progress, project_id)
        logger.info(
            "[Hash] 内容哈希补算完成：%s/%s",
            progress.get("done"),
            progress.get("total"),
        )
    except Exception as exc:
        logger.warning("[Hash] 补算失败: %s", exc)
    finally:
        _hash_task_running = False

async def _backfill_content_hashes() -> None:
    await asyncio.sleep(12)
    await _run_hash_backfill(getattr(config, "CURRENT_PROJECT_ID", "default"))



_rescan_state = {"running": False, "scanned": 0, "added": 0, "roots": [], "error": ""}


async def _run_library_rescan(project_id: str, roots: List[str]) -> None:
    """扫描库目录，把磁盘上有、库里没有的音频补录进来（回收站还原、手动拷贝）。"""
    import asyncio as _asyncio
    from pathlib import Path as _Path

    global _rescan_state
    _rescan_state = {"running": True, "scanned": 0, "added": 0, "roots": roots, "error": ""}
    try:
        audio_exts = {'.wav', '.mp3', '.aac', '.m4a', '.wma', '.ogg', '.aiff', '.aif', '.flac', '.opus', '.ape', '.caf'}
        db_manager = get_db_manager()
        known = set()
        with db_manager.get_cursor() as cursor:
            for (path,) in cursor.execute("SELECT path FROM files WHERE project_id=?", (project_id,)):
                if path:
                    known.add(canonicalize_path(str(path)))

        added = 0
        scanned = 0
        for root_dir in roots:
            base = _Path(root_dir)
            if not base.is_dir():
                continue
            for entry in base.rglob("*"):
                if not entry.is_file() or entry.suffix.lower() not in audio_exts:
                    continue
                scanned += 1
                _rescan_state["scanned"] = scanned
                try:
                    if canonicalize_path(str(entry)) in known:
                        continue
                    stat = entry.stat()
                    record = AudioFileRecord(
                        path=str(entry),
                        filename=entry.name,
                        file_size=stat.st_size,
                    )
                    if db_manager.upsert_file(record, project_id):
                        added += 1
                        _rescan_state["added"] = added
                except Exception as exc:
                    logger.debug("补录失败 %s: %s", entry, exc)
                if scanned % 500 == 0:
                    await _asyncio.sleep(0.05)
        logger.info("[Rescan] 扫描 %d 个音频，补录 %d 个", scanned, added)
        if added:
            await _run_hash_backfill(project_id)
    except Exception as exc:
        logger.error("[Rescan] 失败: %s", exc)
        _rescan_state["error"] = str(exc)
    finally:
        _rescan_state["running"] = False


@app.get("/api/v1/db/library/rescan")
async def rescan_status():
    return {"success": True, **_rescan_state}


@app.post("/api/v1/db/library/rescan")
async def start_library_rescan(payload: Dict[str, Any] = None, background_tasks: BackgroundTasks = None,
                               project_id: str = Query(default="default")):
    """扫描库目录，找回"磁盘上有、库里没有"的文件（比如从回收站还原的）。

    传 dry_run=true 只统计不写入。
    """
    from pathlib import Path as _Path

    payload = payload or {}
    dry_run = bool(payload.get("dry_run"))
    roots = [str(item) for item in (payload.get("roots") or []) if str(item).strip()]
    db_manager = get_db_manager()
    if not roots:
        roots = db_manager.list_library_roots(project_id)
    roots = [item for item in roots if _Path(item).is_dir()]
    if not roots:
        raise HTTPException(status_code=404, detail="没有可扫描的库目录")

    if dry_run:
        audio_exts = {'.wav', '.mp3', '.aac', '.m4a', '.wma', '.ogg', '.aiff', '.aif', '.flac', '.opus', '.ape', '.caf'}
        known = set()
        with db_manager.get_cursor() as cursor:
            for (path,) in cursor.execute("SELECT path FROM files WHERE project_id=?", (project_id,)):
                if path:
                    known.add(canonicalize_path(str(path)))
        missing_count = 0
        samples: List[str] = []
        scanned = 0
        for root_dir in roots:
            base = _Path(root_dir)
            if not base.is_dir():
                continue
            for entry in base.rglob("*"):
                if entry.is_file() and entry.suffix.lower() in audio_exts:
                    scanned += 1
                    if canonicalize_path(str(entry)) not in known:
                        missing_count += 1
                        if len(samples) < 20:
                            samples.append(str(entry))
        return {
            "success": True,
            "dry_run": True,
            "roots": roots,
            "scanned": scanned,
            "missing": missing_count,
            "missing_sample": samples,
        }

    if _rescan_state.get("running"):
        return {"success": True, "already_running": True}
    background_tasks.add_task(_run_library_rescan, project_id, roots)
    return {"success": True, "started": True, "roots": roots}


@app.get("/api/v1/index/hash")
async def get_hash_status(project_id: str = Query(default="default")):
    """内容哈希（sha256）补算进度。重复检测依赖它，没算完就查不全。"""
    db_manager = get_db_manager()
    progress = db_manager.hash_progress(project_id)
    pending = max(0, progress["total"] - progress["done"])
    return {
        "success": True,
        "total": progress["total"],
        "done": progress["done"],
        "pending": pending,
        "running": _hash_task_running,
    }


@app.post("/api/v1/index/hash")
async def start_hash_backfill(background_tasks: BackgroundTasks, project_id: str = Query(default="default")):
    """手动触发哈希补算（导入完成后、或想立刻查重时调用）。"""
    if _hash_task_running:
        return {"success": True, "already_running": True}
    background_tasks.add_task(_run_hash_backfill, project_id)
    return {"success": True, "started": True}




GENERIC_FOLDER_NAMES = {"音效", "音效素材", "音效库", "声音", "音频", "新文件夹", "新建文件夹", "下载"}


def _folder_tag_name(path: str) -> str:
    """从文件路径推出一个可读的分类标签（目录名）。"""
    from pathlib import Path as _Path

    parts = [p for p in _Path(str(path)).parent.parts if p]
    for name in reversed(parts):
        cleaned = name.strip().strip('[]【】()（）')
        if not cleaned or cleaned in GENERIC_FOLDER_NAMES:
            continue
        if cleaned.replace(' ', '').replace('-', '').replace('_', '').isdigit():
            continue
        return cleaned[:24]
    return ""


@app.post("/api/v1/duplicates/merge-tags")
async def merge_duplicates_into_tags(payload: Dict[str, Any], project_id: str = Query(default="default")):
    """把"副本所在目录名"变成保留文件的标签，然后删掉副本。

    这样一个音效只留一份物理文件，多分类归属靠标签表达，不再占双倍空间。
    """
    import json as _json
    from pathlib import Path as _Path

    keep_path = str(payload.get("keep_path") or "").strip()
    remove_paths = [str(item) for item in (payload.get("paths") or []) if str(item).strip()]
    delete_source = payload.get("delete_source", True) is not False
    extra_tags = [str(t).strip() for t in (payload.get("tags") or []) if str(t).strip()]

    if not keep_path or not remove_paths:
        raise HTTPException(status_code=422, detail="keep_path 和 paths 都不能为空")

    db_manager = get_db_manager()

    derived = []
    for path in remove_paths:
        name = _folder_tag_name(path)
        if name and name not in derived:
            derived.append(name)
    for tag in extra_tags:
        if tag not in derived:
            derived.append(tag)

    merged_tags = []
    with db_manager.get_cursor() as cursor:
        row = cursor.execute(
            "SELECT tags FROM files WHERE project_id=? AND canonical_path=?",
            (project_id, canonicalize_path(keep_path)),
        ).fetchone()
        try:
            merged_tags = [str(t) for t in (_json.loads(row[0]) if row and row[0] else []) if str(t).strip()]
        except Exception:
            merged_tags = []
    for tag in derived:
        if tag not in merged_tags:
            merged_tags.append(tag)

    if merged_tags:
        db_manager.update_tags(keep_path, merged_tags, project_id)

    moved = 0
    removed = 0
    failed = 0
    for path in remove_paths:
        try:
            source = _Path(path)
            if delete_source and source.exists():
                _move_to_recycle_bin(source)
                moved += 1
            if db_manager.delete_file(path, project_id):
                removed += 1
        except Exception as exc:
            failed += 1
            logger.warning("合并标签后删除失败 %s: %s", path, exc)

    try:
        await _get_project_searcher(project_id).clear_cache()
    except Exception:
        pass

    return {
        "success": True,
        "keep_path": keep_path,
        "tags_added": derived,
        "tags_total": merged_tags,
        "moved": moved,
        "removed": removed,
        "failed": failed,
    }



# ==================== 转码 / 损坏文件修复 ====================

class TranscodeRequest(BaseModel):
    paths: List[str]
    target_format: str = "wav"
    bitrate: Optional[str] = None
    out_dir: Optional[str] = None
    overwrite: bool = False
    # 转码后用新文件替换源文件，并同步库里的路径（保留标签/索引）
    replace_source: bool = False


def _transcode_one(
    source: str,
    target_format: str,
    bitrate: Optional[str],
    out_dir: Optional[str],
    overwrite: bool,
    replace_source: bool = False,
) -> Dict[str, Any]:
    from core.transcode import target_extension, transcode_file

    try:
        extension = target_extension(target_format)
    except ValueError as exc:
        return {"source": source, "ok": False, "error": str(exc)}

    source_path = Path(source)
    if not source_path.is_file():
        return {"source": source, "ok": False, "error": "文件不存在"}

    # 替换模式：输出到源文件同级目录（同主名 + 新扩展名）
    destination_dir = Path(out_dir) if out_dir else source_path.parent / "_转码"
    if replace_source:
        destination_dir = source_path.parent
    destination = destination_dir / (source_path.stem + extension)
    if destination.exists() and not overwrite:
        index = 2
        while destination.exists():
            destination = destination_dir / f"{source_path.stem} ({index}){extension}"
            index += 1

    result = transcode_file(str(source_path), str(destination), target_format, bitrate=bitrate, tolerate_errors=True)
    payload = {
        "source": source,
        "destination": str(destination),
        "ok": bool(result.get("ok")),
        "salvaged": bool(result.get("salvaged")),
        "frames": int(result.get("frames") or 0),
        "error": result.get("error") or "",
        "replaced": False,
    }

    if payload["ok"] and replace_source and destination.resolve() != source_path.resolve():
        # 先改库里的路径，再删源文件：顺序反了会导致记录瞬间指向不存在的文件
        try:
            from core.database import canonicalize_path

            db_manager = get_db_manager()
            project_id = getattr(config, "CURRENT_PROJECT_ID", "default")
            new_canon = canonicalize_path(str(destination))
            with db_manager.get_cursor() as cursor:
                cursor.execute(
                    "UPDATE files SET path=?, canonical_path=?, filename=? "
                    "WHERE project_id=? AND canonical_path=?",
                    (str(destination), new_canon, destination.name, project_id,
                     canonicalize_path(str(source_path))),
                )
            try:
                source_path.unlink()
            except Exception as exc:
                logger.warning("[转码] 删除源文件失败: %s", exc)
            payload["replaced"] = True
            logger.info("[转码] 已替换源文件: %s -> %s", source_path.name, destination.name)
        except Exception as exc:
            payload["error"] = f"替换源文件失败：{exc}"
            payload["replaced"] = False

    return payload





class BatchDeleteRequest(BaseModel):
    paths: List[str]
    delete_source: bool = False



class ReviewMoveRequest(BaseModel):
    file_uuid: str
    target_dir: str


@app.get("/api/v1/db/review/unclassified")
async def review_unclassified(
    limit: int = Query(default=50, ge=1, le=200),
    offset: int = Query(default=0, ge=0),
    keyword: str = Query(default=""),
    project_id: str = Query(default="default"),
):
    """待归类文件列表（_待归类 / 待人工判断 目录下的文件）。"""
    db_manager = get_db_manager()
    where = "project_id=? AND (path LIKE '%_待归类%' OR path LIKE '%待人工判断%')"
    params: list = [project_id]
    if keyword.strip():
        where += " AND (filename LIKE ? OR COALESCE(ai_description,'') LIKE ?)"
        like = f"%{keyword.strip()}%"
        params += [like, like]
    with db_manager.get_cursor() as cursor:
        total = cursor.execute(f"SELECT COUNT(*) FROM files WHERE {where}", params).fetchone()[0]
        rows = cursor.execute(
            f"SELECT file_uuid, path, filename, COALESCE(duration,0), COALESCE(tags,'[]'), "
            f"COALESCE(ai_description,'') FROM files WHERE {where} ORDER BY path LIMIT ? OFFSET ?",
            (*params, limit, offset),
        ).fetchall()
    return {
        "success": True,
        "total": total,
        "items": [
            {
                "file_uuid": r[0], "path": r[1], "filename": r[2],
                "duration": float(r[3] or 0), "tags": r[4], "description": r[5],
            }
            for r in rows
        ],
    }


@app.post("/api/v1/db/review/move")
async def review_move_file(payload: ReviewMoveRequest):
    """把待归类文件移动到目标目录，并同步库内路径（file_uuid 不变，索引保留）。"""
    import shutil

    from core.database import canonicalize_path

    db_manager = get_db_manager()
    project_id = getattr(config, "CURRENT_PROJECT_ID", "default")
    with db_manager.get_cursor() as cursor:
        row = cursor.execute(
            "SELECT path, filename FROM files WHERE project_id=? AND file_uuid=?",
            (project_id, payload.file_uuid),
        ).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="文件记录不存在")
    source = Path(row[0])
    if not source.is_file():
        raise HTTPException(status_code=404, detail="源文件不存在")
    target_dir = Path(payload.target_dir)
    if not target_dir.is_dir():
        raise HTTPException(status_code=400, detail="目标目录不存在")
    target = target_dir / source.name
    if target.exists() and target.resolve() != source.resolve():
        raise HTTPException(status_code=409, detail="目标目录已有同名文件")
    try:
        if target.resolve() != source.resolve():
            shutil.move(str(source), str(target))
        with db_manager.get_cursor() as cursor:
            cursor.execute(
                "UPDATE files SET path=?, canonical_path=? WHERE project_id=? AND file_uuid=?",
                (str(target), canonicalize_path(str(target)), project_id, payload.file_uuid),
            )
    except Exception as exc:
        logger.warning("[归类] 移动失败 %s -> %s: %s", source, target, exc)
        raise SoundBotAPIError("move_failed", f"移动失败：{exc}", status_code=500)
    return {"success": True, "path": str(target), "filename": target.name}


@app.post("/api/v1/db/files/delete")
async def batch_delete_db_files(payload: BatchDeleteRequest):
    """批量删除文件记录。

    设计要点：
    - **记录立即删**（几十毫秒级），界面不会卡在"正在删除"；
    - 向量清理放后台任务（fire-and-forget），失败只记日志，不影响删除结果；
    - 源文件删除由 Electron 主进程送回收站，这里不碰磁盘。
    """
    if not payload.paths:
        raise HTTPException(status_code=422, detail="paths 不能为空")
    project_id = getattr(config, "CURRENT_PROJECT_ID", "default")
    if project_id in _projects_deleting:
        raise SoundBotAPIError("project_deleting", "工程正在删除", status_code=409)

    db_manager = get_db_manager()
    removed = 0
    failed = 0
    cleanup: list = []
    for raw_path in payload.paths:
        record = db_manager.get_file(str(raw_path), project_id)
        if not record:
            failed += 1
            continue
        try:
            with db_manager.get_cursor() as cursor:
                cursor.execute(
                    "DELETE FROM files WHERE project_id=? AND file_uuid=?",
                    (project_id, record.file_uuid),
                )
            removed += 1
            cleanup.append((record.path, record.file_uuid))
        except Exception as exc:
            logger.warning("[批量删除] 删除记录失败 %s: %s", record.path, exc)
            failed += 1

    if cleanup:
        asyncio.create_task(_cleanup_vectors_after_delete(project_id, cleanup))

    return {"success": True, "removed": removed, "failed": failed, "total": len(payload.paths)}


async def _cleanup_vectors_after_delete(project_id: str, items) -> None:
    """后台清理已删除记录的向量；失败只记日志，避免影响用户体验。"""
    try:
        await asyncio.sleep(0.5)
        audio_removed = 0
        text_removed = 0
        for path, file_uuid in items:
            try:
                await _run_model_work(
                    _get_active_audio_indexer(project_id).remove_audio, path, file_uuid
                )
                audio_removed += 1
            except Exception as exc:
                logger.debug("[批量删除] 音频向量清理失败 %s: %s", path, exc)
            try:
                await _run_model_work(
                    _get_active_text_indexer(project_id).remove, file_id=file_uuid
                )
                text_removed += 1
            except Exception as exc:
                logger.debug("[批量删除] 文本向量清理失败 %s: %s", file_uuid, exc)
        logger.info(
            "[批量删除] 向量清理完成：音频 %d/%d，文本 %d/%d",
            audio_removed, len(items), text_removed, len(items),
        )
    except Exception as exc:
        logger.warning("[批量删除] 向量清理任务失败: %s", exc)


@app.get("/api/v1/db/library/folder-health")
async def library_folder_health(project_id: str = Query(default="default"), limit: int = 200):
    """检测库里的目录是否还存在于磁盘（改名/移动会导致不一致）。"""
    from core.library_health import folder_health

    db_manager = get_db_manager()
    with db_manager.get_cursor() as cursor:
        rows = cursor.execute(
            "SELECT path FROM files WHERE project_id=?", (project_id,)
        ).fetchall()
    paths = [row[0] for row in rows] if rows else []
    result = await asyncio.to_thread(folder_health, paths, limit)
    return {"success": True, **result}



class RetryFolderRequest(BaseModel):
    path_prefix: str
    kinds: List[str] = ["audio_vector", "text_vector"]
    start_job: bool = True


@app.post("/api/v1/db/index/retry-folder")
async def retry_folder_index(payload: RetryFolderRequest, background_tasks: BackgroundTasks):
    """把某个文件夹下失败的产物重置为 pending，并立刻起一轮修复索引。

    用于「先按文件夹分批重试」：一次只跑一个目录，出问题的文件立刻能定位。
    """
    project_id = getattr(config, "CURRENT_PROJECT_ID", "default")
    prefix = str(payload.path_prefix or "").strip()
    if not prefix:
        raise HTTPException(status_code=422, detail="path_prefix 不能为空")

    db_manager = get_db_manager()
    kinds = [k for k in (payload.kinds or []) if k in ("audio_vector", "text_vector")]
    if not kinds:
        kinds = ["audio_vector", "text_vector"]

    with db_manager.get_cursor() as cursor:
        reset = cursor.execute(
            "UPDATE file_artifacts SET state='pending', error_code=NULL, error_message=NULL "
            "WHERE project_id=? AND kind IN (%s) AND state IN ('failed','stale') "
            "AND file_uuid IN (SELECT file_uuid FROM files WHERE project_id=? AND path LIKE ?)"
            % ",".join("?" * len(kinds)),
            (project_id, *kinds, project_id, prefix + "%"),
        ).rowcount

    job = None
    if reset and payload.start_job:
        job = await _start_index_job(project_id, kinds, "reconcile", background_tasks)
    return {"success": True, "reset": reset, "job": job, "kinds": kinds}


@app.post("/api/v1/db/library/repair-paths")
async def repair_library_paths(payload: Dict[str, Any] = Body(default={}), project_id: str = Query(default="default")):
    """磁盘上文件夹改名/移动后，把数据库里的旧路径按"同名同大小"修正回来。

    dry_run=True 只返回计划，不动数据库。
    """
    from core.database import canonicalize_path

    dry_run = bool(payload.get("dry_run", True))
    roots = payload.get("roots") or []
    db_manager = get_db_manager()

    with db_manager.get_cursor() as cursor:
        rows = cursor.execute(
            "SELECT file_uuid, path, filename, file_size FROM files WHERE project_id=?",
            (project_id,),
        ).fetchall()

    missing = []
    by_name_size = {}
    for file_uuid, path, filename, size in rows:
        if os.path.exists(path):
            by_name_size.setdefault((str(filename), int(size or 0)), []).append(path)
        else:
            missing.append((file_uuid, path, filename, size))

    # 磁盘扫描：在指定根目录（或旧路径的盘符根）下找同名同大小的文件
    search_roots = [str(item) for item in roots if item]
    if not search_roots:
        seen = set()
        for _uuid, path, _fn, _size in missing:
            drive = os.path.splitdrive(path)[0]
            if drive and drive not in seen:
                seen.add(drive)
                search_roots.append(drive + os.sep)

    disk_index = {}
    scanned = 0
    for search_root in search_roots:
        if not os.path.isdir(search_root):
            continue
        for dirpath, _dirnames, filenames in os.walk(search_root):
            for name in filenames:
                full = os.path.join(dirpath, name)
                try:
                    disk_index.setdefault((name, os.path.getsize(full)), []).append(full)
                except OSError:
                    continue
                scanned += 1
                if scanned % 20000 == 0:
                    logger.info("路径修复扫描中: %d", scanned)

    plan = []
    ambiguous = 0
    not_found = 0
    for file_uuid, path, filename, size in missing:
        candidates = disk_index.get((str(filename), int(size or 0)), [])
        if not candidates:
            not_found += 1
            continue
        if len(candidates) > 1:
            # 优先同盘
            same_drive = [c for c in candidates if os.path.splitdrive(c)[0] == os.path.splitdrive(path)[0]]
            candidates = same_drive or candidates
        if len(candidates) > 1:
            ambiguous += 1
            continue
        plan.append({"file_uuid": file_uuid, "old": path, "new": candidates[0]})

    if dry_run:
        return {
            "success": True,
            "dry_run": True,
            "missing": len(missing),
            "scanned": scanned,
            "fixable": len(plan),
            "ambiguous": ambiguous,
            "not_found": not_found,
            "samples": plan[:20],
        }

    updated = 0
    with db_manager.get_cursor() as cursor:
        for item in plan:
            cursor.execute(
                "UPDATE files SET path=?, canonical_path=?, updated_at=? WHERE file_uuid=?",
                (item["new"], canonicalize_path(item["new"]), datetime.now().isoformat(), item["file_uuid"]),
            )
            updated += cursor.rowcount
    return {
        "success": True,
        "dry_run": False,
        "missing": len(missing),
        "fixable": len(plan),
        "updated": updated,
        "ambiguous": ambiguous,
        "not_found": not_found,
    }








# ==================== 声音克隆 ====================

class VoiceCloneRequest(BaseModel):
    path: str
    name: str = ""
    duration: Optional[float] = 0.0


class VoiceSpeakRequest(BaseModel):
    text: str
    speaker_id: str
    save_dir: Optional[str] = None


@app.get("/api/v1/voice/profiles")
async def voice_profiles():
    """已克隆的音色列表。"""
    from core.voice_clone import load_profiles, engine_name

    return {"success": True, "engine": engine_name(), "profiles": load_profiles()}


@app.post("/api/v1/voice/clone")
async def voice_clone_endpoint(payload: VoiceCloneRequest):
    """用一段人声复刻音色。"""
    from core.voice_clone import clone_voice

    if not payload.path:
        raise HTTPException(status_code=422, detail="path 不能为空")
    loop = asyncio.get_running_loop()
    result = await loop.run_in_executor(None, clone_voice, payload.path, payload.name, payload.duration or 0.0)
    if not result.get("ok"):
        raise SoundBotAPIError("voice_clone_failed", str(result.get("error") or "复刻失败"), status_code=400)
    return {"success": True, **result}


@app.post("/api/v1/voice/speak")
async def voice_speak_endpoint(payload: VoiceSpeakRequest):
    """用克隆音色合成语音。"""
    from core.voice_clone import speak

    loop = asyncio.get_running_loop()
    result = await loop.run_in_executor(None, speak, payload.text, payload.speaker_id, payload.save_dir)
    if not result.get("ok"):
        raise SoundBotAPIError("voice_speak_failed", str(result.get("error") or "合成失败"), status_code=400)
    return {"success": True, **result}


@app.delete("/api/v1/voice/profiles/{profile_id}")
async def voice_delete_profile(profile_id: str):
    from core.voice_clone import delete_profile

    if not delete_profile(profile_id):
        raise HTTPException(status_code=404, detail="音色不存在")
    return {"success": True}


# ==================== 效果器（混响） ====================

class EffectRequest(BaseModel):
    path: str
    preset: str = "room_large"
    wet: Optional[float] = None


class EffectExportRequest(BaseModel):
    path: str
    preset: str = "room_large"
    wet: Optional[float] = None
    out_dir: Optional[str] = None


@app.post("/api/v1/audio/export-effect")
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


@app.get("/api/v1/audio/effect-presets")
async def list_effect_presets():
    """可用效果器预设（混响空间）。"""
    from core.effects import PRESETS

    items = [
        {"id": key, "name": value["name"], "decay": value["decay"], "wet": value["wet"]}
        for key, value in PRESETS.items()
    ]
    return {"success": True, "presets": items}


@app.post("/api/v1/audio/apply-effect")
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


# ==================== 多声道 ====================

class ChannelMixRequest(BaseModel):
    path: str
    audible: List[int]


@app.get("/api/v1/audio/channels")
async def audio_channels(path: str = Query(...), points: int = 400):
    """逐声道波形峰值（最多 8 条），用于播放器下方的声道条。"""
    from core.channel_tools import channel_peaks

    loop = asyncio.get_running_loop()
    result = await loop.run_in_executor(None, channel_peaks, path, points)
    if not result.get("ok"):
        raise SoundBotAPIError("channels_failed", str(result.get("error") or "读取声道失败"), status_code=500)
    return {"success": True, **result}


@app.post("/api/v1/audio/channel-mix")
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


# ==================== 倒放 ====================

class ReverseRequest(BaseModel):
    path: str


@app.post("/api/v1/audio/reverse")
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


# ==================== 皮肤 / 主题包 ====================

class SkinImportRequest(BaseModel):
    path: str


@app.get("/api/v1/skins")
async def list_skins_endpoint():
    """列出内置 + 用户导入的皮肤。"""
    from core.skins import list_skins

    items = await asyncio.to_thread(list_skins)
    return {"success": True, "skins": items, "total": len(items)}


@app.post("/api/v1/skins/import")
async def import_skin_endpoint(payload: SkinImportRequest):
    """把用户选的皮肤文件夹复制到 skins 目录。"""
    from core.skins import import_skin

    try:
        skin = await asyncio.to_thread(import_skin, payload.path)
        return {"success": True, "skin": skin}
    except ValueError as exc:
        raise SoundBotAPIError("invalid_skin", str(exc), status_code=400)
    except Exception as exc:
        logger.error("导入皮肤失败: %s", exc)
        raise HTTPException(status_code=500, detail=str(exc))


@app.delete("/api/v1/skins/{skin_id}")
async def delete_skin_endpoint(skin_id: str):
    from core.skins import delete_skin

    try:
        removed = await asyncio.to_thread(delete_skin, skin_id)
        if not removed:
            raise SoundBotAPIError("skin_not_found", "皮肤不存在", status_code=404)
        return {"success": True}
    except ValueError as exc:
        raise SoundBotAPIError("builtin_skin", str(exc), status_code=400)


# ==================== 去人声（中置声道消除） ====================

class RemoveVocalsRequest(BaseModel):
    paths: List[str]
    out_dir: Optional[str] = None
    strength: float = 1.0



# ==================== AI 分轨（Demucs） ====================

class SeparateRequest(BaseModel):
    paths: List[str]
    out_dir: Optional[str] = None
    model: str = "htdemucs"
    stems: Optional[List[str]] = None


@app.post("/api/v1/audio/separate")
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
        out_dir = Path(payload.out_dir) if payload.out_dir else source.parent / "_分轨"
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


@app.post("/api/v1/audio/remove-vocals")
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
        out_dir = Path(payload.out_dir) if payload.out_dir else source.parent / "_去人声"
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


@app.post("/api/v1/transcode")
async def transcode_files(payload: TranscodeRequest):
    """把一批音频转成 WAV/MP3；坏文件尽量救回能解的部分。"""
    if not payload.paths:
        raise HTTPException(status_code=422, detail="paths 不能为空")
    if len(payload.paths) > 500:
        raise HTTPException(status_code=422, detail="单次最多 500 个文件")
    if payload.target_format.lower() not in ("wav", "mp3"):
        raise HTTPException(status_code=422, detail="只支持 wav / mp3")

    loop = asyncio.get_running_loop()
    results = []
    for path in payload.paths:
        results.append(
            await loop.run_in_executor(
                None,
                _transcode_one,
                str(path),
                payload.target_format,
                payload.bitrate,
                payload.out_dir,
                payload.overwrite,
                bool(getattr(payload, "replace_source", False)),
            )
        )
    ok = sum(1 for item in results if item["ok"])
    salvaged = sum(1 for item in results if item.get("salvaged"))
    return {
        "success": True,
        "total": len(results),
        "ok": ok,
        "failed": len(results) - ok,
        "salvaged": salvaged,
        "results": results,
    }


@app.post("/api/v1/transcode/scan-broken")
async def scan_broken_files(project_id: str = Query(default="default")):
    """列出解码失败的文件，附真实容器格式，便于判断是"格式不支持"还是"文件损坏"。"""
    from core.transcode import probe_format

    db_manager = get_db_manager()
    with db_manager.get_cursor() as cursor:
        rows = cursor.execute(
            """
            SELECT f.path, f.filename, f.file_size, a.error_message
            FROM files f
            JOIN file_artifacts a ON a.file_uuid = f.file_uuid AND a.project_id = f.project_id
            WHERE f.project_id = ? AND a.kind='waveform' AND a.state='failed'
            ORDER BY f.filename
            """,
            (project_id,),
        ).fetchall()

    items = []
    for row in rows:
        path = row[0]
        items.append({
            "path": path,
            "filename": row[1],
            "size": int(row[2] or 0),
            "error": row[3] or "",
            "container": probe_format(path) if os.path.exists(path) else "",
        })
    return {"success": True, "total": len(items), "files": items}



@app.get("/api/v1/tags/auto-backup")
async def tag_auto_backup_stats(project_id: str = Query(default="default")):
    """查看自动补全标签的备份情况（支持撤销的依据）。"""
    db_manager = get_db_manager()
    with db_manager.get_cursor() as cursor:
        try:
            row = cursor.execute(
                "SELECT COUNT(*), COUNT(DISTINCT batch), MIN(created_at), MAX(created_at) FROM tag_auto_backup"
            ).fetchone()
        except Exception:
            return {"success": True, "count": 0, "batches": 0}
    return {
        "success": True,
        "count": int(row[0] or 0),
        "batches": int(row[1] or 0),
        "first": row[2],
        "last": row[3],
    }


class TagAutoUndoRequest(BaseModel):
    batch: Optional[str] = None


@app.post("/api/v1/tags/auto-undo")
async def tag_auto_undo(payload: TagAutoUndoRequest, project_id: str = Query(default="default")):
    """撤销自动补全：把 files.tags 还原成补全前的样子。"""
    db_manager = get_db_manager()
    restored = 0
    with db_manager.get_cursor() as cursor:
        try:
            if payload.batch:
                rows = cursor.execute(
                    "SELECT file_uuid, old_tags FROM tag_auto_backup WHERE batch=?", (payload.batch,)
                ).fetchall()
            else:
                rows = cursor.execute("SELECT file_uuid, old_tags FROM tag_auto_backup").fetchall()
        except Exception:
            return {"success": True, "restored": 0}
        for file_uuid, old_tags in rows:
            cursor.execute(
                "UPDATE files SET tags=?, updated_at=? WHERE file_uuid=?",
                (old_tags, datetime.now().isoformat(), file_uuid),
            )
            restored += 1
        if payload.batch:
            cursor.execute("DELETE FROM tag_auto_backup WHERE batch=?", (payload.batch,))
        else:
            cursor.execute("DELETE FROM tag_auto_backup")
        cursor.connection.commit()

    if restored:
        try:
            db_manager.mark_project_artifacts(project_id, ["text_vector"], "stale")
        except Exception:
            pass
    return {"success": True, "restored": restored}


@app.get("/api/v1/tags/usage")
async def get_tag_usage(project_id: str = Query(default="default")):
    """标签 + 使用次数（标签管理面板用）。"""
    db_manager = get_db_manager()
    return {"success": True, "tags": db_manager.list_tag_usage(project_id)}


@app.post("/api/v1/tags/rename")
async def rename_tag(payload: Dict[str, Any], project_id: str = Query(default="default")):
    """按名字改名；新名字已存在则自动合并。"""
    old_name = str(payload.get("old") or "").strip()
    new_name = str(payload.get("new") or "").strip()
    if not old_name or not new_name:
        raise HTTPException(status_code=422, detail="old / new 都不能为空")
    if old_name == new_name:
        return {"success": True, "renamed": 0, "merged": 0, "files": 0}
    db_manager = get_db_manager()
    result = db_manager.rename_tag_by_name(project_id, old_name, new_name)
    try:
        await _get_project_searcher(project_id).clear_cache()
    except Exception:
        pass
    return {"success": True, **result, "old": old_name, "new": new_name}


@app.post("/api/v1/tags/delete")
async def delete_tag_batch(payload: Dict[str, Any], project_id: str = Query(default="default")):
    """删除标签（含文件关联），同步 files.tags。"""
    name = str(payload.get("name") or "").strip()
    if not name:
        raise HTTPException(status_code=422, detail="name 不能为空")
    db_manager = get_db_manager()
    result = db_manager.delete_tag_by_name(project_id, name)
    try:
        await _get_project_searcher(project_id).clear_cache()
    except Exception:
        pass
    return {"success": True, **result, "name": name}


@app.post("/api/v1/tags/merge")
async def merge_tags(payload: Dict[str, Any], project_id: str = Query(default="default")):
    """把多个标签合并到一个（旧的都并进 target）。"""
    target = str(payload.get("target") or "").strip()
    sources = [str(item).strip() for item in (payload.get("sources") or []) if str(item).strip()]
    if not target or not sources:
        raise HTTPException(status_code=422, detail="target / sources 不能为空")
    db_manager = get_db_manager()
    merged = 0
    files = 0
    for name in sources:
        if name == target:
            continue
        result = db_manager.rename_tag_by_name(project_id, name, target)
        merged += result.get("merged", 0) + result.get("renamed", 0)
        files += result.get("files", 0)
    try:
        await _get_project_searcher(project_id).clear_cache()
    except Exception:
        pass
    return {"success": True, "target": target, "merged": merged, "files": files}

@app.get("/api/v1/duplicates/ignored")
async def list_ignored_duplicates(project_id: str = Query(default="default")):
    """被标记为"有意保留多个分类副本"的组。"""
    db_manager = get_db_manager()
    return {"success": True, "groups": db_manager.list_ignored_duplicate_groups(project_id)}


@app.post("/api/v1/duplicates/ignore")
async def ignore_duplicate(payload: Dict[str, Any], project_id: str = Query(default="default")):
    """忽略一组重复：同一个音效本来就要归到多个分类时用。"""
    sha = str(payload.get("sha256") or "").strip()
    if not sha:
        raise HTTPException(status_code=422, detail="sha256 不能为空")
    note = str(payload.get("note") or "").strip()[:200]
    db_manager = get_db_manager()
    db_manager.ignore_duplicate_group(project_id, sha, note)
    return {"success": True, "sha256": sha}


@app.delete("/api/v1/duplicates/ignore/{sha256}")
async def unignore_duplicate(sha256: str, project_id: str = Query(default="default")):
    db_manager = get_db_manager()
    removed = db_manager.unignore_duplicate_group(project_id, sha256)
    return {"success": True, "removed": removed}

@app.get("/api/v1/db/duplicates/backups")
async def list_duplicate_backups(limit: int = Query(default=20, le=100)):
    """列出可撤回的备份清单（新的在前）。"""
    import json as _json

    root = _duplicate_backup_root() / "manifests"
    if not root.is_dir():
        return {"success": True, "manifests": []}
    manifests = []
    for item in sorted(root.glob("*.json"), key=lambda p: p.stat().st_mtime, reverse=True)[:limit]:
        try:
            data = _json.loads(item.read_text(encoding="utf-8"))
            manifests.append({
                "path": str(item),
                "created_at": data.get("created_at", ""),
                "action": data.get("action", ""),
                "target_dir": data.get("target_dir", ""),
                "count": len(data.get("entries") or []),
            })
        except Exception as exc:
            logger.debug("读取备份清单失败 %s: %s", item, exc)
    return {"success": True, "manifests": manifests}


@app.post("/api/v1/db/duplicates/restore")
async def restore_duplicate_backup(payload: Dict[str, Any], project_id: str = Query(default="default")):
    """按备份清单把副本还原回**原来的目录**（仅还原缺失的文件，不覆盖已有文件）。"""
    import json as _json
    import shutil
    from pathlib import Path

    manifest = str(payload.get("manifest") or "").strip()
    if not manifest:
        latest = sorted((_duplicate_backup_root() / "manifests").glob("*.json"),
                        key=lambda p: p.stat().st_mtime, reverse=True) if (_duplicate_backup_root() / "manifests").is_dir() else []
        if not latest:
            raise HTTPException(status_code=404, detail="没有可撤回的备份")
        manifest = str(latest[0])

    path = Path(manifest)
    if not path.is_file():
        raise HTTPException(status_code=404, detail="备份清单不存在")

    try:
        data = _json.loads(path.read_text(encoding="utf-8"))
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"备份清单损坏: {exc}")

    restored = 0
    skipped = 0
    failed = 0
    errors: List[str] = []
    for entry in data.get("entries") or []:
        original = Path(str(entry.get("original") or ""))
        backup = Path(str(entry.get("backup") or ""))
        try:
            if not backup.exists():
                skipped += 1
                continue
            if original.exists():
                skipped += 1
                continue
            original.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(str(backup), str(original))
            restored += 1
        except Exception as exc:
            failed += 1
            errors.append(f"{original}: {exc}")
            logger.warning("还原失败 %s: %s", original, exc)

    return {
        "success": True,
        "manifest": str(path),
        "restored": restored,
        "skipped": skipped,
        "failed": failed,
        "errors": errors[:10],
        "note": "文件已还原；库记录需要重新导入对应目录才会回来",
    }


# ==================== P3：中文文本向量（BGE-M3） ====================

@app.get("/api/v1/embed/status")
async def embed_status():
    from core import zh_embedder

    return {"success": True, **zh_embedder.status()}


@app.post("/api/v1/embed/rebuild")
async def embed_rebuild(payload: Dict[str, Any] = None):
    """后台重建中文文本向量索引（可传 limit 先小规模验证）。"""
    from core import zh_text_index

    limit = (payload or {}).get("limit")
    limit = int(limit) if limit else None
    state = zh_text_index.start_async(limit=limit)
    return {"success": True, **state}


@app.get("/api/v1/embed/rebuild/status")
async def embed_rebuild_status():
    from core import zh_text_index

    return {"success": True, **zh_text_index.status()}


@app.post("/api/v1/embed/preview")
async def embed_preview(payload: Dict[str, Any]):
    """调试用：给几段文本，返回向量维度与两两相似度（验证模型可用）。"""
    from core import zh_embedder

    texts = [str(t) for t in (payload.get("texts") or [])]
    if not texts:
        raise HTTPException(status_code=422, detail="texts 不能为空")
    vectors = await asyncio.to_thread(zh_embedder.encode, texts)
    if vectors is None:
        raise HTTPException(status_code=503, detail="BGE-M3 模型未就绪")
    matrix = np.asarray(vectors, dtype=np.float32)
    sims = (matrix @ matrix.T).round(3).tolist()
    return {
        "success": True,
        "dim": int(matrix.shape[1]),
        "count": int(matrix.shape[0]),
        "similarity": sims,
    }


# ==================== M4：标签双层（scene / attr） ====================

@app.get("/api/v1/tags")
async def list_tags(project_id: str = Query(default="default")):
    from core import tag_layers

    db_manager = get_db_manager()
    with db_manager.get_cursor() as cursor:
        tags = tag_layers.list_tags(cursor, project_id)
    return {
        "success": True,
        "scene": [t for t in tags if t["layer"] == "scene"],
        "attr": [t for t in tags if t["layer"] == "attr"],
        "total": len(tags),
    }


@app.post("/api/v1/tags")
async def create_tag(payload: Dict[str, Any], project_id: str = Query(default="default")):
    import uuid as _uuid

    from core import tag_layers

    name = str(payload.get("name") or "").strip()
    layer = str(payload.get("layer") or tag_layers.LAYER_ATTR)
    if not name:
        raise HTTPException(status_code=422, detail="标签名不能为空")
    if layer not in tag_layers.VALID_LAYERS:
        raise HTTPException(status_code=422, detail="layer 只能是 scene 或 attr")
    db_manager = get_db_manager()
    tag_id = "tag_" + _uuid.uuid4().hex[:10]
    with db_manager.get_cursor() as cursor:
        try:
            cursor.execute(
                "INSERT INTO tags (id, project_id, name, layer, sort_order, created_at) "
                "VALUES (?,?,?,?,?,?)",
                (tag_id, project_id, name, layer, 0, datetime.now().isoformat()),
            )
            cursor.connection.commit()
        except Exception as exc:
            raise HTTPException(status_code=409, detail=f"标签已存在: {exc}") from exc
    return {"success": True, "id": tag_id, "name": name, "layer": layer}


@app.patch("/api/v1/tags/{tag_id}")
async def update_tag(
    tag_id: str,
    payload: Dict[str, Any],
    background_tasks: BackgroundTasks,
    project_id: str = Query(default="default"),
):
    from core import tag_layers

    db_manager = get_db_manager()
    affected = db_manager.list_file_uuids_by_tag(project_id, tag_id)
    with db_manager.get_cursor() as cursor:
        ok = True
        named = payload.get("name") is not None
        if named:
            ok = tag_layers.rename_tag(cursor, project_id, tag_id, payload["name"]) and ok
        if payload.get("layer") is not None:
            ok = tag_layers.set_layer(cursor, project_id, tag_id, payload["layer"]) and ok
        cursor.connection.commit()
    if ok and named:
        # 只改「我的标签」，不动音效自带的 6 维标签
        background_tasks.add_task(_deferred_reconcile, project_id, ["text_vector"], "tags")
    return {"success": ok}


@app.delete("/api/v1/tags/{tag_id}")
async def delete_tag(
    tag_id: str,
    background_tasks: BackgroundTasks,
    project_id: str = Query(default="default"),
):
    from core import tag_layers

    db_manager = get_db_manager()
    affected = db_manager.list_file_uuids_by_tag(project_id, tag_id)
    with db_manager.get_cursor() as cursor:
        ok = tag_layers.delete_tag(cursor, project_id, tag_id)
        cursor.connection.commit()
    if ok:
        # 只删「我的标签」，不影响 files.tags
        background_tasks.add_task(_deferred_reconcile, project_id, ["text_vector"], "tags")
    return {"success": ok}


@app.post("/api/v1/files/{file_uuid}/description")
async def set_file_description(
    file_uuid: str,
    payload: Dict[str, Any],
    background_tasks: BackgroundTasks,
    project_id: str = Query(default="default"),
):
    """单条改「一句话描述」：写库 + 同步 FTS，并把这条的文本向量标脏。"""
    description = str(payload.get("description") or "").strip()[:500]
    db_manager = get_db_manager()
    record = db_manager.get_file_by_uuid(file_uuid, project_id)
    if not record:
        raise HTTPException(status_code=404, detail="文件不存在")
    path = getattr(record, "path", None) or getattr(record, "file_path", None)
    if not path:
        raise HTTPException(status_code=500, detail="文件路径缺失")
    if not db_manager.update_ai_description(path, description, project_id):
        raise HTTPException(status_code=500, detail="写入描述失败")
    # 描述变了，这一行的 text_vector 已经被标脏。关键词搜索（FTS）当场就更新了，
    # 但语义检索用的是向量，得让增量对账把这一条重新算一遍 —— 只跑 stale 的行，
    # 不是全库重建。同一工程并发触发会自动合并成一个任务。
    background_tasks.add_task(_deferred_reconcile, project_id, ["text_vector"], "description")
    return {"success": True, "description": description, "reindex_queued": True}


@app.get("/api/v1/files/{file_uuid}/user-tags")
async def get_file_user_tags(file_uuid: str, project_id: str = Query(default="default")):
    """读取某个文件的「我的标签」（用户自定义，和 6 维系统标签分开）。"""
    from core import tag_layers

    db_manager = get_db_manager()
    with db_manager.get_cursor() as cursor:
        names = tag_layers.file_tag_names(cursor, project_id, file_uuid)
    return {"success": True, "names": names}


@app.post("/api/v1/files/{file_uuid}/tags")
async def set_file_tags(
    file_uuid: str,
    payload: Dict[str, Any],
    background_tasks: BackgroundTasks,
    project_id: str = Query(default="default"),
):
    from core import tag_layers

    tag_ids = payload.get("tag_ids") or []
    names = payload.get("names")
    if not isinstance(tag_ids, list):
        raise HTTPException(status_code=422, detail="tag_ids 必须是数组")
    db_manager = get_db_manager()
    with db_manager.get_cursor() as cursor:
        # 允许前端直接传名字：不存在的标签自动建（attr 层）
        if isinstance(names, list):
            resolved = []
            for raw in names:
                name = str(raw or "").strip()
                if not name:
                    continue
                row = cursor.execute(
                    "SELECT id FROM tags WHERE project_id=? AND name=?", (project_id, name)
                ).fetchone()
                if row:
                    resolved.append(str(row[0]))
                else:
                    tag_id = uuid.uuid4().hex
                    cursor.execute(
                        "INSERT INTO tags (id, project_id, name, layer, created_at) VALUES (?,?,?,?,?)",
                        (tag_id, project_id, name, "attr", datetime.now().isoformat()),
                    )
                    resolved.append(tag_id)
            tag_ids = resolved
        try:
            tag_layers.set_file_tags(cursor, project_id, file_uuid, [str(t) for t in tag_ids])
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

    # 改完用户标签：刷新这一行的 FTS（关键词搜索能命中），并把文本向量标脏
    try:
        db_manager.update_fts_row(project_id, file_uuid)
    except Exception as exc:
        logger.debug("刷新 FTS 失败: %s", exc)
    try:
        with db_manager.get_cursor() as cursor:
            cursor.execute(
                "UPDATE file_artifacts SET state='stale' WHERE kind='text_vector' AND file_uuid=?",
                (file_uuid,),
            )
    except Exception:
        pass
    background_tasks.add_task(_deferred_reconcile, project_id, ["text_vector"], "user_tags")
    return {"success": True, "reindex_queued": True}


@app.get("/api/v1/db/folder/stats")
async def folder_stats(path: str = Query(...), project_id: str = Query(default="default")):
    """目录统计：文件数 / 有描述数 / 有标签数 / 总大小。"""
    db_manager = get_db_manager()
    stats = db_manager.folder_stats(project_id, path)
    stats["path"] = path
    return {"success": True, **stats}


def _assert_safe_delete_target(path: str, stats: Dict[str, Any]) -> Path:
    """删除源文件前的硬性护栏。

    必须挡住：盘符根目录、程序目录、用户数据目录、以及任何"库里没有文件"的
    目录 —— 后者通常说明前端传错了路径（真实事故：误传库根/安装目录）。
    """
    target = Path(path).resolve()
    if not target.exists():
        raise HTTPException(status_code=404, detail="目录不存在")
    if target.parent == target or len(target.parts) < 3:
        raise HTTPException(status_code=400, detail="不能删除盘符根目录或过浅的目录")
    if int(stats.get("files") or 0) <= 0:
        raise HTTPException(status_code=400, detail="该目录下没有已导入的音效，已阻止删除")

    protected: List[Path] = []
    try:
        protected.append(Path(sys.executable).resolve().parent)
    except Exception:
        pass
    try:
        protected.append((Path(os.environ.get("APPDATA", "")) / "EchoMind").resolve())
    except Exception:
        pass
    try:
        protected.append(Path(config.get_models_dir()).resolve())
    except Exception:
        pass

    for guard in protected:
        if target == guard or target in guard.parents or guard in target.parents:
            raise HTTPException(
                status_code=400,
                detail="该目录包含程序或数据目录，出于安全考虑已阻止删除",
            )
    return target


def _move_to_recycle_bin(target: Path) -> None:
    """移入回收站而不是直接 rmtree —— 误删还能恢复。"""
    import ctypes
    from ctypes import wintypes

    FO_DELETE = 3
    FOF_SILENT = 0x0004
    FOF_NOCONFIRMATION = 0x0010
    FOF_ALLOWUNDO = 0x0040
    FOF_NOERRORUI = 0x0400

    class SHFILEOPSTRUCTW(ctypes.Structure):
        _fields_ = [
            ("hwnd", wintypes.HWND),
            ("wFunc", wintypes.UINT),
            ("pFrom", wintypes.LPCWSTR),
            ("pTo", wintypes.LPCWSTR),
            ("fFlags", wintypes.WORD),
            ("fAnyOperationsAborted", wintypes.BOOL),
            ("hNameMappings", wintypes.LPVOID),
            ("lpszProgressTitle", wintypes.LPCWSTR),
        ]

    operation = SHFILEOPSTRUCTW()
    operation.hwnd = None
    operation.wFunc = FO_DELETE
    operation.pFrom = str(target) + "\0\0"
    operation.pTo = None
    operation.fFlags = FOF_ALLOWUNDO | FOF_NOCONFIRMATION | FOF_SILENT | FOF_NOERRORUI
    result = ctypes.windll.shell32.SHFileOperationW(ctypes.byref(operation))
    if result != 0:
        raise RuntimeError(f"移入回收站失败，错误码 {result}")


@app.post("/api/v1/db/folder/delete")
async def delete_folder_records(payload: Dict[str, Any], project_id: str = Query(default="default")):
    """删除目录下的文件记录。

    默认只删库内记录（描述、标签、索引一起删），保留磁盘源文件；
    delete_source=true 时同时删除磁盘文件（不可恢复，前端需二次确认）。
    """
    import shutil

    folder = str(payload.get("path") or "").strip()
    delete_source = bool(payload.get("delete_source"))
    if not folder:
        raise HTTPException(status_code=422, detail="path 不能为空")

    db_manager = get_db_manager()
    stats = db_manager.folder_stats(project_id, folder)
    removed = 0
    deleted_files = 0
    failed: List[str] = []

    if delete_source:
        target = _assert_safe_delete_target(folder, stats)
        try:
            _move_to_recycle_bin(target)
            deleted_files = stats.get("files", 0)
        except Exception as exc:
            logger.error("删除目录源文件失败 %s: %s", folder, exc)
            raise HTTPException(status_code=500, detail=f"删除源文件失败: {exc}")

    records = db_manager.delete_files_in_folder(project_id, folder)
    removed = len(records)
    # 顺带清掉「我的文件夹」里指向这个目录的映射，否则左侧还会挂着一个空目录
    mappings_removed = db_manager.remove_mappings_under(project_id, folder)
    try:
        await _get_project_searcher(project_id).clear_cache()
    except Exception as exc:
        logger.debug("清理搜索缓存失败: %s", exc)

    return {
        "success": True,
        "removed": removed,
        "deleted_source": delete_source,
        "deleted_files": deleted_files,
        "failed": failed,
        "mappings_removed": mappings_removed,
        "stats": stats,
    }


@app.delete("/api/v1/db/file/{path:path}")
async def delete_db_file(path: str):
    """
    从数据库删除文件记录

    - **path**: URL 编码的文件路径
    """
    file_path = path

    db_manager = get_db_manager()
    current_project_id = getattr(config, 'CURRENT_PROJECT_ID', 'default')
    if current_project_id in _projects_deleting:
        raise SoundBotAPIError("project_deleting", "工程正在删除", status_code=409)
    async with _get_project_index_lock(current_project_id):
        record = db_manager.get_file(file_path, current_project_id)
        if not record:
            raise HTTPException(status_code=404, detail="文件不存在")
        try:
            await _run_model_work(
                _get_active_audio_indexer(current_project_id).remove_audio,
                file_path,
                record.file_uuid,
            )
            await _run_model_work(
                _get_active_text_indexer(current_project_id).remove,
                file_id=record.file_uuid,
            )
        except Exception as exc:
            db_manager.set_artifact_state(
                current_project_id,
                record.file_uuid,
                "audio_vector",
                "stale",
                error_code="delete_sync_failed",
                error_message=str(exc),
            )
            db_manager.set_artifact_state(
                current_project_id,
                record.file_uuid,
                "text_vector",
                "stale",
                error_code="delete_sync_failed",
                error_message=str(exc),
            )
            raise SoundBotAPIError(
                "delete_sync_failed",
                "向量删除未完成，文件记录已保留，可重试",
                status_code=503,
                retryable=True,
            ) from exc

        success = db_manager.delete_file(file_path, current_project_id)
        if not success:
            for kind in ("audio_vector", "text_vector"):
                db_manager.set_artifact_state(
                    current_project_id,
                    record.file_uuid,
                    kind,
                    "stale",
                    error_code="delete_metadata_failed",
                    error_message="SQLite delete returned false after vector removal",
                )
            raise SoundBotAPIError(
                "delete_metadata_failed",
                "元数据删除失败；已删除的向量会由修复任务恢复",
                status_code=503,
                retryable=True,
            )

        for kind in ("audio_vector", "text_vector"):
            db_manager.upsert_index_manifest(
                current_project_id, kind, revision_increment=1
            )
        try:
            await _get_project_searcher(current_project_id).clear_cache()
        except Exception as exc:
            logger.debug(f"清理搜索缓存失败: {exc}")
    return {"success": True, "message": "文件已删除"}


@app.get("/api/v1/db/folder-stats")
async def get_folder_stats(project_id: str = Query(default="default")):
    """返回库内所有目录及其直接文件数，供左侧文件夹树构建。

    前端只拿到分页加载的文件，用它们反推目录树会得到不完整、不稳定的结果
    （实测只显示出 7/8/9 三个子目录）。这里直接返回全库聚合。
    """
    try:
        db_manager = get_db_manager()
        folders = db_manager.get_folder_counts(project_id)
        return {
            "success": True,
            "folders": [{"path": path, "count": count} for path, count in folders],
        }
    except Exception as exc:
        logger.error("获取文件夹统计失败: %s", exc)
        raise HTTPException(status_code=500, detail=str(exc))


@app.get("/api/v1/db/broken-files")
async def list_broken_files():
    """列出所有损坏/无法索引的文件（仅从软件库移除，保留磁盘原文件）。"""
    db_manager = get_db_manager()
    current_project_id = getattr(config, "CURRENT_PROJECT_ID", "default")
    broken = db_manager.get_broken_files(current_project_id)
    return {
        "success": True,
        "count": len(broken),
        "files": broken,
        "note": "清理仅从软件库移除记录，保留磁盘上的原始文件",
    }


@app.delete("/api/v1/db/broken/{path:path}")
async def delete_broken_file(path: str):
    """清理单个损坏文件：仅从软件库移除记录（保留磁盘原文件）。"""
    return await delete_db_file(path)


@app.post("/api/v1/db/broken/cleanup")
async def cleanup_broken_files(background_tasks: BackgroundTasks):
    """一键清理全部损坏文件：仅从软件库移除记录，保留磁盘原文件。

    后台任务执行（几万文件时也能稳定跑），返回 job_id 供轮询进度。
    """
    db_manager = get_db_manager()
    current_project_id = getattr(config, "CURRENT_PROJECT_ID", "default")
    broken = db_manager.get_broken_files(current_project_id)
    if not broken:
        return {"success": True, "job_id": None, "count": 0, "message": "没有损坏文件"}
    job_id = db_manager.create_job(current_project_id, "broken_cleanup", len(broken))
    background_tasks.add_task(_broken_cleanup_task, job_id, current_project_id, [b["path"] for b in broken])
    return {
        "success": True,
        "job_id": job_id,
        "count": len(broken),
        "message": f"已提交清理 {len(broken)} 个损坏文件",
    }


async def _broken_cleanup_task(job_id: str, project_id: str, paths: List[str]) -> None:
    """逐个清理损坏文件（仅移除软件库记录）。"""
    db_manager = get_db_manager()
    ws_manager = get_ws_manager()
    db_manager.update_job(job_id, state="running", stage="removing")
    removed = 0
    failed = 0
    try:
        for index, file_path in enumerate(paths):
            job = db_manager.get_job(job_id)
            if (job and job["cancel_requested"]) or ws_manager.is_task_cancelled(job_id):
                db_manager.update_job(
                    job_id, state="cancelled", stage="cancelled", processed=index
                )
                return
            try:
                record = db_manager.get_file(file_path, project_id)
                if not record:
                    failed += 1
                    continue
                try:
                    await _run_model_work(
                        _get_active_audio_indexer(project_id).remove_audio,
                        file_path,
                        record.file_uuid,
                    )
                except Exception as exc:
                    logger.warning("损坏文件音频向量移除失败 %s: %s", file_path, exc)
                try:
                    await _run_model_work(
                        _get_active_text_indexer(project_id).remove,
                        file_id=record.file_uuid,
                    )
                except Exception as exc:
                    logger.warning("损坏文件文本索引移除失败 %s: %s", file_path, exc)
                if db_manager.delete_file(file_path, project_id):
                    removed += 1
                else:
                    failed += 1
            except Exception as exc:
                logger.error("清理损坏文件失败 %s: %s", file_path, exc)
                failed += 1
            db_manager.update_job(job_id, processed=index + 1)
        db_manager.update_job(
            job_id,
            state="completed" if failed == 0 else "failed",
            stage=f"done removed={removed} failed={failed}",
            processed=len(paths),
        )
    except Exception as exc:
        logger.error("损坏文件清理任务异常: %s", exc)
        db_manager.update_job(
            job_id, state="failed", stage=f"error removed={removed} failed={failed}"
        )
    try:
        await _get_project_searcher(project_id).clear_cache()
    except Exception as exc:
        logger.debug(f"清理搜索缓存失败: {exc}")


@app.get("/api/v1/db/stats")
async def get_db_stats():
    """
    获取数据库统计信息
    """
    try:
        db_manager = get_db_manager()
        current_project_id = getattr(config, 'CURRENT_PROJECT_ID', 'default')
        return {
            "project_id": current_project_id,
            "total_files": db_manager.get_file_count(current_project_id),
            "total_duration": db_manager.get_total_duration(current_project_id)
        }
    except Exception as e:
        logger.error(f"获取统计失败: {e}")
        raise HTTPException(status_code=500, detail=str(e))


# ==================== 语义搜索 ====================


_PROJECT_SEARCHER_CACHE: Dict[tuple, Any] = {}
# 构造检索器要 7~13 秒；启动预热和用户的首个搜索若同时进来会各建一次
# （实测首次搜索 24 秒）。用锁串行化，让后来者等前者建好直接复用。
_SEARCHER_BUILD_LOCK = threading.Lock()


def _get_project_searcher(project_id: str):
    from core.search_engine import get_optimized_searcher_sync

    db_manager = get_db_manager()
    audio_manifest = db_manager.get_index_manifest(project_id, "audio_vector") or {}
    text_manifest = db_manager.get_index_manifest(project_id, "text_vector") or {}
    revision = int(audio_manifest.get("revision", 0)) + int(text_manifest.get("revision", 0))
    fingerprint = "|".join(filter(None, (
        audio_manifest.get("engine_fingerprint"),
        text_manifest.get("engine_fingerprint"),
    ))) or None
    audio_collection = audio_manifest.get("collection_name") or "audio_embeddings"
    text_collection = text_manifest.get("collection_name") or "text_metadata_embeddings"

    # 构造 searcher 要打开 Chroma 集合、初始化各层索引，实测 7~13 秒；
    # 每次搜索都重建就是搜索慢的真正原因。按「工程 + 索引版本 + 集合名」缓存。
    # 键里不带 revision：索引每写一批 revision 就变一次，带上会导致每次
    # 重建检索器（7~13 秒）。集合名变化（影子激活）才真正需要新实例。
    cache_key = (project_id, audio_collection, text_collection)
    cached = _PROJECT_SEARCHER_CACHE.get(cache_key)
    if cached is not None:
        return cached

    with _SEARCHER_BUILD_LOCK:
        cached = _PROJECT_SEARCHER_CACHE.get(cache_key)
        if cached is not None:
            return cached
        searcher = get_optimized_searcher_sync(
            project_id=project_id,
            collection_name=audio_collection,
            text_collection_name=text_collection,
            index_revision=revision,
            model_fingerprint=fingerprint,
        )
        _PROJECT_SEARCHER_CACHE[cache_key] = searcher
    if len(_PROJECT_SEARCHER_CACHE) > 8:
        _PROJECT_SEARCHER_CACHE.pop(next(iter(_PROJECT_SEARCHER_CACHE)), None)
    return searcher

@app.post("/api/v1/search", response_model=schemas.SearchResponse)
async def search_audio(request: schemas.SearchRequest):
    """
    语义搜索音频（同步版本，保持向后兼容）

    - **query**: 自然语言查询（如"清脆的铃铛声"）
    - **top_k**: 返回结果数量（默认 20）
    - **threshold**: 相似度阈值（默认 0.15）
    """
    _t_handler_start = time.time()
    try:
        project_id = request.project_id
        if not is_safe_project_id(project_id) or not get_db_manager().get_project(project_id):
            raise SoundBotAPIError("project_not_found", "工程不存在", status_code=404)
        searcher = _get_project_searcher(project_id)

        filters = {}
        if request.min_duration is not None:
            filters["duration"] = {"$gte": request.min_duration}
        if request.max_duration is not None:
            if "duration" in filters:
                filters["duration"]["$lte"] = request.max_duration
            else:
                filters["duration"] = {"$lte": request.max_duration}
        if request.sample_rate is not None:
            filters["sample_rate"] = request.sample_rate
        if request.channels is not None:
            filters["channels"] = request.channels
        if request.format is not None:
            filters["format"] = request.format

        # 使用异步搜索但不推送进度
        results, stats = await searcher.search_async(
            query=request.query,
            top_k=request.top_k,
            min_similarity=request.threshold,
            filters=filters if filters else None,
            use_cache=True,
            fast=bool(getattr(request, "fast", False)),
        )

        logger.info(f"搜索 '{request.query}': 找到 {len(results)} 个结果, 耗时 {stats.get('duration', 0):.3f}s, 缓存命中: {stats.get('cache_hit', False)}")

        _t_after_search = time.time()
        # 转换为响应格式：先把缺 file_id 的路径一次性查出来，避免逐条查库
        missing_paths = [
            r.file_path for r in results if not r.metadata.get("file_id") and r.file_path
        ]
        id_by_path = {}
        if missing_paths:
            try:
                id_by_path = db_manager.get_file_ids_by_paths(missing_paths, project_id)
            except Exception as exc:
                logger.warning("批量解析 file_id 失败: %s", exc)
        search_results = []
        for r in results:
            # 使用 getattr 避免与 Python 内置 format 函数冲突
            file_format = getattr(r, 'format', '') or ''
            file_uuid = r.metadata.get("file_id") or id_by_path.get(r.file_path)
            if not file_uuid:
                matched_record = db_manager.get_file(r.file_path, project_id)
                file_uuid = matched_record.file_uuid if matched_record else None
            audio_file = schemas.AudioFile(
                id=file_uuid,
                path=r.file_path,
                filename=r.filename,
                duration=r.duration,
                sample_rate=r.metadata.get("sample_rate", 0),
                channels=r.metadata.get("channels", 0),
                format=file_format,
                size=r.metadata.get("size", 0)
            )
            search_results.append(schemas.SearchResult(
                audio_file=audio_file,
                score=r.similarity,
                distance=1.0 - r.similarity,
                metadata={
                    "project_id": project_id,
                    "audio_score": r.metadata.get("audio_score", r.metadata.get("semantic_score", 0.0)),
                    "text_score": r.metadata.get("text_score", 0.0),
                    "keyword_score": r.metadata.get("keyword_score", 0.0),
                    "score_weights": r.metadata.get("score_weights", {
                        "audio": 0.55, "text": 0.30, "keyword": 0.15,
                    }),
                }
            ))

        # 分页处理
        total = len(search_results)
        page = request.page
        page_size = request.page_size
        start_idx = (page - 1) * page_size
        end_idx = start_idx + page_size
        paginated_results = search_results[start_idx:end_idx]
        total_pages = (total + page_size - 1) // page_size

        return schemas.SearchResponse(
            query=request.query,
            total=total,
            page=page,
            page_size=page_size,
            total_pages=total_pages,
            results=paginated_results
        )

    except SoundBotAPIError:
        raise
    except Exception as e:
        import traceback
        logger.error(f"搜索失败: {e}")
        logger.error(f"搜索失败详细堆栈: {traceback.format_exc()}")
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/api/v1/search/async")
async def search_audio_async(
    request: schemas.SearchRequest,
    background_tasks: BackgroundTasks,
    client_id: str = Query(default="default")
):
    """
    异步语义搜索（带 WebSocket 进度推送）

    - **query**: 自然语言查询
    - **top_k**: 返回结果数量
    - **threshold**: 相似度阈值
    - **client_id**: WebSocket 客户端标识

    返回搜索任务ID，通过 WebSocket 接收进度和结果
    """
    try:
        project_id = request.project_id
        db_manager = get_db_manager()
        if not is_safe_project_id(project_id) or not db_manager.get_project(project_id):
            raise SoundBotAPIError(
                "project_not_found",
                "工程不存在",
                status_code=404,
                details={"project_id": project_id},
            )
        search_id = f"search_{int(time.time() * 1000)}"

        # 后台执行搜索
        background_tasks.add_task(
            _search_task,
            search_id=search_id,
            query=request.query,
            top_k=request.top_k,
            min_similarity=request.threshold,
            filters={
                k: v for k, v in {
                    "min_duration": request.min_duration,
                    "max_duration": request.max_duration,
                    "sample_rate": request.sample_rate,
                    "channels": request.channels,
                    "format": request.format
                }.items() if v is not None
            },
            client_id=client_id,
            project_id=project_id,
        )

        return {"search_id": search_id, "message": "搜索任务已启动"}

    except SoundBotAPIError:
        raise
    except Exception as e:
        logger.error(f"启动搜索任务失败: {e}")
        raise HTTPException(status_code=500, detail=str(e))


async def _search_task(
    search_id: str,
    query: str,
    top_k: Optional[int],
    min_similarity: Optional[float],
    filters: Dict[str, Any],
    client_id: str,
    project_id: str,
):
    """
    后台搜索任务（带 WebSocket 进度推送）
    """
    ws_manager = get_ws_manager()
    searcher = _get_project_searcher(project_id)

    # 构建过滤条件
    where_clause = {}
    if filters.get("min_duration") is not None:
        where_clause["duration"] = {"$gte": filters["min_duration"]}
    if filters.get("max_duration") is not None:
        if "duration" in where_clause:
            where_clause["duration"]["$lte"] = filters["max_duration"]
        else:
            where_clause["duration"] = {"$lte": filters["max_duration"]}
    if filters.get("sample_rate") is not None:
        where_clause["sample_rate"] = filters["sample_rate"]
    if filters.get("channels") is not None:
        where_clause["channels"] = filters["channels"]
    if filters.get("format") is not None:
        where_clause["format"] = filters["format"]

    try:
        # 定义进度回调
        async def progress_callback(stage: str, progress: float):
            await ws_manager.send_search_progress(
                client_id=client_id,
                search_id=search_id,
                stage=stage,
                progress=progress,
                message=f"搜索阶段: {stage}"
            )

        # 执行搜索
        results, stats = await searcher.search_async(
            query=query,
            top_k=top_k,
            min_similarity=min_similarity,
            filters=where_clause if where_clause else None,
            use_cache=True,
            progress_callback=progress_callback
        )

        # 发送完成消息
        await ws_manager.send_search_complete(
            client_id=client_id,
            search_id=search_id,
            results_count=len(results),
            duration=stats.get("duration", 0),
            cache_hit=stats.get("cache_hit", False)
        )

        # 发送搜索结果
        search_results_data = []
        for r in results:
            file_uuid = r.metadata.get("file_id")
            if not file_uuid:
                record = get_db_manager().get_file(r.file_path, project_id)
                file_uuid = record.file_uuid if record else None
            search_results_data.append({
                "file_id": file_uuid,
                "path": r.file_path,
                "filename": r.filename,
                "duration": r.duration,
                "format": r.format,
                "similarity": r.similarity,
                "metadata": r.metadata
            })

        await ws_manager.broadcast({
            "type": "search_results",
            "search_id": search_id,
            "data": {
                "query": query,
                "total": len(results),
                "results": search_results_data,
                "stats": stats
            }
        }, client_id)

        logger.info(f"异步搜索 '{query}' 完成: 找到 {len(results)} 个结果, 耗时 {stats.get('duration', 0):.3f}s")

    except Exception as e:
        logger.error(f"异步搜索失败: {e}")
        await ws_manager.send_search_error(
            client_id=client_id,
            search_id=search_id,
            error=str(e)
        )


@app.get("/api/v1/search/cache/stats")
async def get_search_cache_stats():
    """
    获取搜索缓存统计信息
    """
    try:
        project_id = getattr(config, 'CURRENT_PROJECT_ID', 'default')
        searcher = _get_project_searcher(project_id)
        stats = searcher.get_cache_stats()
        return {
            "status": "success",
            "cache_stats": stats
        }
    except Exception as e:
        logger.error(f"获取缓存统计失败: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/api/v1/search/cache/clear")
async def clear_search_cache():
    """
    清空搜索缓存
    """
    try:
        project_id = getattr(config, 'CURRENT_PROJECT_ID', 'default')
        searcher = _get_project_searcher(project_id)
        await searcher.clear_cache()
        return {
            "status": "success",
            "message": "搜索缓存已清空"
        }
    except Exception as e:
        logger.error(f"清空缓存失败: {e}")
        raise HTTPException(status_code=500, detail=str(e))


# ==================== 音频波形 ====================

@app.get("/api/waveform")
async def get_waveform(path: str = Query(..., description="音频文件路径")):
    """
    获取音频波形数据

    优先从 SQLite 数据库读取缓存的波形数据，如果没有则实时计算并缓存。
    将原始波形降采样到 2000 个峰值点，用于前端波形显示。

    返回格式：
    {
        "peaks": [0.1, 0.4, -0.3, ...],  # 降采样后的峰值数组
        "duration": 12.4,                  # 时长（秒）
        "sample_rate": 48000,               # 采样率
        "channels": 2,                       # 声道数
        "cached": true                       # 是否从缓存读取
    }
    """
    current_project_id = getattr(config, 'CURRENT_PROJECT_ID', 'default') or 'default'
    return await _waveform_payload(path, current_project_id)


async def _waveform_payload(file_path: str, project_id: str) -> Dict[str, Any]:
    from core.audio_service import get_audio_service, AudioServiceError

    service = get_audio_service()
    db_manager = get_db_manager()
    record = db_manager.get_file(file_path, project_id)
    try:
        fingerprint = await _run_audio_work(service.fingerprint, file_path)
        cached_peaks = record.get_peaks() if record else None
        artifact = (
            db_manager.get_artifact(project_id, record.file_uuid, "waveform")
            if record else None
        )
        if (
            record
            and cached_peaks
            and len(cached_peaks) == config.WAVEFORM_PEAK_COUNT
            and all(
                isinstance(value, (int, float))
                and math.isfinite(value)
                and 0 <= value <= 1
                for value in cached_peaks
            )
            and artifact
            and artifact.get("state") == "ready"
            and record.source_fingerprint == fingerprint.source_key
            and record.waveform_fingerprint == fingerprint.key
            and str(record.waveform_version) == str(fingerprint.waveform_version)
        ):
            return {
                "file_id": record.file_uuid,
                "peaks": cached_peaks,
                "duration": record.duration,
                "sample_rate": record.sample_rate,
                "channels": record.channels,
                "cached": True,
                "source_fingerprint": fingerprint.source_key,
                "waveform_version": fingerprint.waveform_version,
            }

        waveform = await _run_audio_work(service.waveform, file_path)
        metadata = (
            None if record else await _run_audio_work(service.probe, file_path)
        )
        if record:
            source_changed = (
                record.source_fingerprint != waveform.fingerprint.source_key
            )
            updated = db_manager.update_peaks(
                file_path,
                waveform.peaks,
                project_id,
                source_fingerprint=waveform.fingerprint.source_key,
                waveform_fingerprint=waveform.fingerprint.key,
                waveform_version=int(waveform.fingerprint.waveform_version),
            )
            if not updated:
                raise SoundBotAPIError(
                    "waveform_cache_update_failed",
                    "波形已计算，但缓存状态更新失败",
                    status_code=503,
                    retryable=True,
                )
            if source_changed:
                from core.search_engine import reset_optimized_searcher
                from core.ai_chat_service import reset_ai_chat_service

                reset_optimized_searcher(project_id)
                reset_ai_chat_service(project_id)
                _schedule_project_reconcile(
                    project_id,
                    ("audio_vector", "text_vector"),
                    reason="source_changed",
                )
        return {
            "file_id": record.file_uuid if record else None,
            "peaks": waveform.peaks,
            "duration": waveform.duration,
            "sample_rate": waveform.sample_rate,
            "channels": record.channels if record else metadata.channels,
            "cached": False,
            "source_fingerprint": waveform.fingerprint.source_key,
            "waveform_version": waveform.fingerprint.waveform_version,
        }
    except AudioServiceError as exc:
        if record:
            db_manager.set_artifact_state(
                project_id,
                record.file_uuid,
                "waveform",
                "failed",
                error_code=exc.code,
                error_message=exc.message,
            )
        raise SoundBotAPIError(
            exc.code,
            exc.message,
            status_code=404 if exc.code == "audio_not_found" else 422,
            retryable=exc.retryable,
            details=exc.details,
        )


@app.get("/api/v1/files/{file_id}/waveform")
async def get_file_waveform(file_id: str, project_id: Optional[str] = None):
    effective_project = project_id or getattr(config, 'CURRENT_PROJECT_ID', 'default')
    record = get_db_manager().get_file_by_uuid(file_id, effective_project)
    if not record:
        raise SoundBotAPIError("file_not_found", "文件不存在", status_code=404)
    return await _waveform_payload(record.path, effective_project)


@app.post("/api/v1/waveforms/batch")
async def get_waveforms_batch(request: schemas.WaveformBatchRequest):
    project_id = request.project_id or getattr(config, 'CURRENT_PROJECT_ID', 'default')
    semaphore = asyncio.Semaphore(4)

    async def load(file_id: str) -> Dict[str, Any]:
        async with semaphore:
            record = get_db_manager().get_file_by_uuid(file_id, project_id)
            if not record:
                return {
                    "file_id": file_id,
                    "ok": False,
                    "error": {
                        "code": "file_not_found",
                        "message": "文件不存在",
                        "retryable": False,
                        "details": {},
                    },
                }
            try:
                payload = await _waveform_payload(record.path, project_id)
                return {"file_id": file_id, "ok": True, **payload}
            except SoundBotAPIError as exc:
                return {"file_id": file_id, "ok": False, "error": exc.payload}

    items = await asyncio.gather(*(load(file_id) for file_id in request.file_ids))
    return {"project_id": project_id, "items": items}


@app.get("/api/v1/files/{file_id}/playback-source")
async def get_playback_source(file_id: str, project_id: Optional[str] = None):
    """Return an original path or a cached PCM WAV for Chromium-incompatible files."""
    from core.audio_service import get_audio_service, AudioServiceError

    effective_project = project_id or getattr(config, 'CURRENT_PROJECT_ID', 'default')
    record = get_db_manager().get_file_by_uuid(file_id, effective_project)
    if not record:
        raise SoundBotAPIError("file_not_found", "文件不存在", status_code=404)
    service = get_audio_service()
    try:
        if service.requires_playback_transcode(record.path):
            source = await _run_audio_work(service.prepare_playback_wav, record.path)
            mode = "transcoded_wav"
        else:
            source = Path(record.path)
            mode = "original"
        return {
            "file_id": file_id,
            "path": str(source),
            "mode": mode,
            "source_fingerprint": (
                await _run_audio_work(service.fingerprint, record.path)
            ).source_key,
        }
    except AudioServiceError as exc:
        raise SoundBotAPIError(
            exc.code,
            exc.message,
            status_code=422,
            retryable=exc.retryable,
            details=exc.details,
        )


# ==================== 通用音频文件服务 ====================

@app.get("/api/v1/audio/{file_path:path}")
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


# ==================== 索引状态 ====================

async def _run_automatic_reconcile(
    job_id: str,
    project_id: str,
    kinds: List[str],
) -> None:
    try:
        await _repair_index_task(job_id, project_id, kinds, "reconcile")
    finally:
        current = _automatic_index_tasks.get(project_id)
        if current and current.get("job_id") == job_id:
            _automatic_index_tasks.pop(project_id, None)


def _schedule_project_reconcile(
    project_id: str,
    kinds: Sequence[str],
    *,
    reason: str,
) -> Optional[str]:
    """Create one durable automatic reconcile job per project at a time."""
    if _shutting_down or project_id in _projects_deleting:
        return None
    db_manager = get_db_manager()
    if not is_safe_project_id(project_id) or not db_manager.get_project(project_id):
        return None
    valid_kinds = [
        kind for kind in dict.fromkeys(kinds)
        if kind in {"waveform", "audio_vector", "text_vector"}
    ]
    if not valid_kinds:
        return None
    current = _automatic_index_tasks.get(project_id)
    if current and not current["task"].done():
        return str(current["job_id"])
    work = db_manager.list_artifacts_for_work(
        project_id, valid_kinds, limit=100000
    )
    if not work:
        return None
    job_id = db_manager.create_job(
        project_id, f"index_auto_{reason}", len(work)
    )
    task = asyncio.create_task(
        _run_automatic_reconcile(job_id, project_id, valid_kinds),
        name=f"soundbot-index-{project_id}-{reason}",
    )
    _automatic_index_tasks[project_id] = {"job_id": job_id, "task": task}
    return job_id


async def _deferred_reconcile(project_id: str, kinds: List[str], reason: str) -> None:
    """响应已经发出之后再去创建对账任务。

    直接在保存接口里调度会把 4.8 万行的扫描算在请求里，实测保存描述要等 17 秒
    才拿到响应；丢进 BackgroundTasks 之后接口 <300ms 返回，索引照样在后台补。

    再等一小会儿是有意的：连着改三条描述时，三次都会走到这里，但真正建出来的
    只有一个对账任务（_schedule_project_reconcile 自带去重）。否则用户第二次保存
    会正撞上一次还在跑的对账，又变成十几秒。
    """
    try:
        await asyncio.sleep(2.5)
        _schedule_project_reconcile(project_id, kinds, reason=reason)
    except Exception as exc:  # 后台失败不能影响用户已经保存的数据
        logger.debug(f"调度索引对账失败({reason}): {exc}")


def _schedule_model_ready_reconcile() -> None:
    """Backfill vector artifacts after a newly available CLAP model loads.

    每次启动都全量对账会把 5 万文件重扫一遍，期间接口明显变慢、启动像卡住。
    这里加一个 24 小时节流：首次安装/导入仍会自动建索引，但不会每次开软件都跑。
    """
    if _shutting_down:
        return
    # 如果有积压（上次导入/索引被进程退出打断），必须立刻补，不能被 24h 节流挡住。
    pending_backlog = 0
    try:
        counts = get_db_manager().get_artifact_counts(
            getattr(config, "CURRENT_PROJECT_ID", "default")
        )
        for kind in ("audio_vector", "text_vector"):
            pending_backlog += int(counts.get(kind, {}).get("pending", 0) or 0)
    except Exception as exc:
        logger.debug("读取积压数量失败: %s", exc)
    if pending_backlog:
        logger.info("检测到 %d 条待补索引，跳过 24 小时节流直接补", pending_backlog)

    marker = config.get_user_data_dir() / ".last_auto_reconcile"
    try:
        if marker.exists() and not pending_backlog:
            last = float(marker.read_text(encoding="utf-8").strip() or 0)
            if (time.time() - last) < 24 * 3600:
                logger.info("自动对账已在本日内执行过，跳过本轮")
                return
    except Exception as exc:
        logger.debug("读取自动对账时间戳失败: %s", exc)
    db_manager = get_db_manager()
    scheduled = 0
    for project in db_manager.get_all_projects():
        project_id = str(project["id"])
        job_id = _schedule_project_reconcile(
            project_id,
            ("audio_vector", "text_vector"),
            reason="model_ready",
        )
        if job_id:
            scheduled += 1
    if scheduled:
        try:
            marker.write_text(str(time.time()), encoding="utf-8")
        except Exception as exc:
            logger.debug("写入自动对账时间戳失败: %s", exc)

@app.get("/api/v1/index/status", response_model=schemas.IndexStatus)
async def get_index_status():
    """获取当前索引状态"""
    try:
        project_id = getattr(config, 'CURRENT_PROJECT_ID', 'default')
        db_manager = get_db_manager()
        artifacts = db_manager.get_artifact_counts(project_id)
        audio_ready = artifacts["audio_vector"]["ready"]
        return schemas.IndexStatus(
            project_id=project_id,
            total_files=db_manager.get_file_count(project_id),
            indexed_files=audio_ready,
            artifacts=artifacts,
            manifests={
                kind: db_manager.get_index_manifest(project_id, kind) or {}
                for kind in ("audio_vector", "text_vector")
            },
        )
    except Exception as e:
        logger.error(f"获取索引状态失败: {e}")
        return schemas.IndexStatus(total_files=0, indexed_files=0)


@app.get("/api/v1/projects/{project_id}/index/status")
async def get_project_index_status(project_id: str):
    db_manager = get_db_manager()
    if not is_safe_project_id(project_id) or not db_manager.get_project(project_id):
        raise SoundBotAPIError("project_not_found", "工程不存在", status_code=404)
    if project_id in _projects_deleting:
        raise SoundBotAPIError("project_deleting", "工程正在删除", status_code=409)
    # 当前正在跑的索引任务（前端用来显示 已处理/总数，实时看到进度）
    active_job = None
    try:
        with db_manager.get_cursor() as cursor:
            row = cursor.execute(
                "SELECT kind, state, processed, total, stage FROM jobs "
                "WHERE project_id=? AND state IN ('running','pending') "
                "ORDER BY created_at DESC LIMIT 1",
                (project_id,),
            ).fetchone()
        if row:
            active_job = {
                "kind": row[0], "state": row[1], "processed": int(row[2] or 0),
                "total": int(row[3] or 0), "stage": row[4],
            }
    except Exception as exc:
        logger.debug("读取活跃索引任务失败: %s", exc)

    return {
        "project_id": project_id,
        "total_files": db_manager.get_file_count(project_id),
        "artifacts": db_manager.get_artifact_counts(project_id),
        "active_job": active_job,
        "progress": {**_index_progress, **(lambda: __import__("core.index_progress", fromlist=["stats"]).stats())()},
        "manifests": {
            kind: db_manager.get_index_manifest(project_id, kind) or {}
            for kind in ("audio_vector", "text_vector")
        },
    }


@app.post("/api/v1/projects/{project_id}/index/reconcile")
async def reconcile_project_index(
    project_id: str,
    request: schemas.IndexActionRequest,
    background_tasks: BackgroundTasks,
):
    return await _start_index_job(project_id, request.kinds, "reconcile", background_tasks)


@app.post("/api/v1/projects/{project_id}/index/rebuild")
async def rebuild_project_index(
    project_id: str,
    request: schemas.IndexActionRequest,
    background_tasks: BackgroundTasks,
):
    return await _start_index_job(project_id, request.kinds, "rebuild", background_tasks)


async def _start_index_job(
    project_id: str,
    kinds: List[str],
    mode: str,
    background_tasks: BackgroundTasks,
) -> Dict[str, Any]:
    db_manager = get_db_manager()
    if not is_safe_project_id(project_id) or not db_manager.get_project(project_id):
        raise SoundBotAPIError("project_not_found", "工程不存在", status_code=404)
    if project_id in _projects_deleting:
        raise SoundBotAPIError("project_deleting", "工程正在删除", status_code=409)
    valid_kinds = [
        kind for kind in dict.fromkeys(kinds)
        if kind in {"waveform", "audio_vector", "text_vector"}
    ]
    if not valid_kinds:
        raise SoundBotAPIError("invalid_index_kinds", "没有有效的索引类型")
    if mode == "rebuild" and "waveform" in valid_kinds:
        # Waveforms have no shadow store, so an explicit rebuild invalidates
        # them immediately. Vector rebuilds keep the old active artifacts
        # ready until a verified shadow is atomically activated.
        db_manager.mark_project_artifacts(project_id, ["waveform"], "stale")
    if mode == "rebuild":
        total = 0
        if "waveform" in valid_kinds:
            total += len(db_manager.list_artifacts_for_work(
                project_id, ["waveform"], limit=100000
            ))
        for kind in ("audio_vector", "text_vector"):
            if kind in valid_kinds:
                total += len(db_manager.list_artifacts_for_work(
                    project_id,
                    [kind],
                    states=("pending", "processing", "ready", "failed", "stale"),
                    limit=100000,
                ))
    else:
        total = len(db_manager.list_artifacts_for_work(
            project_id, valid_kinds, limit=100000
        ))
    job_id = db_manager.create_job(project_id, f"index_{mode}", total)
    background_tasks.add_task(
        _repair_index_task, job_id, project_id, valid_kinds, mode
    )
    return {
        "job_id": job_id,
        "project_id": project_id,
        "state": "pending",
        "mode": mode,
        "kinds": valid_kinds,
        "total": total,
    }


async def _repair_index_task(
    job_id: str,
    project_id: str,
    kinds: List[str],
    mode: str,
) -> None:
    if project_id in _projects_deleting:
        get_db_manager().update_job(
            job_id, state="cancelled", stage="project_deleting"
        )
        return
    async with _get_project_index_lock(project_id):
        if project_id in _projects_deleting or not get_db_manager().get_project(project_id):
            get_db_manager().update_job(
                job_id, state="cancelled", stage="project_deleting"
            )
            return
        await _repair_index_task_locked(job_id, project_id, kinds, mode)


async def _repair_index_task_locked(
    job_id: str,
    project_id: str,
    kinds: List[str],
    mode: str,
) -> None:
    from core.audio_service import get_audio_service, AudioServiceError
    from core.index_lifecycle import (
        activate_verified_shadows,
        create_shadow_indexer,
    )
    from core.search_engine import reset_optimized_searcher
    from core.ai_chat_service import reset_ai_chat_service

    db_manager = get_db_manager()
    service = get_audio_service()
    folder_context = _load_logical_folder_context(project_id)
    db_manager.update_job(job_id, state="running", stage="reconciling")
    try:
        _index_progress.update({"audio": 0, "text": 0, "target": 0, "active": False})
    except Exception:
        pass
    try:
        records = db_manager.get_files_by_project(project_id)
        expected = [
            {
                "file_id": record.file_uuid,
                "file_path": record.path,
                "source_fingerprint": record.source_fingerprint,
            }
            for record in records
        ]
        vector_targets: Dict[str, Any] = {}
        shadow_kinds = set()
        if "audio_vector" in kinds:
            active_audio = _get_active_audio_indexer(project_id)
            needs_shadow = mode == "rebuild" or active_audio.get_manifest().get("needs_rebuild")
            if needs_shadow:
                shadow_kinds.add("audio_vector")
                vector_targets["audio_vector"] = create_shadow_indexer(
                    project_id, "audio_vector", job_id
                )
            else:
                vector_targets["audio_vector"] = active_audio
        if "text_vector" in kinds:
            active_text = _get_active_text_indexer(project_id)
            needs_shadow = mode == "rebuild" or active_text.get_manifest().get("needs_rebuild")
            if needs_shadow:
                shadow_kinds.add("text_vector")
                vector_targets["text_vector"] = create_shadow_indexer(
                    project_id, "text_vector", job_id
                )
            else:
                vector_targets["text_vector"] = active_text

        if mode != "rebuild":
            for kind, indexer in vector_targets.items():
                if kind in shadow_kinds:
                    continue
                reconciliation = await _run_model_work(
                    indexer.reconcile, expected, remove_orphans=True
                )
                for file_id in (
                    reconciliation.get("missing", [])
                    + reconciliation.get("stale", [])
                ):
                    db_manager.set_artifact_state(project_id, file_id, kind, "stale")

        direct_kinds = [kind for kind in kinds if kind not in shadow_kinds]
        work = db_manager.list_artifacts_for_work(
            project_id,
            direct_kinds,
            states=("pending", "failed", "stale"),
            limit=100000,
        )
        # A shadow must be a complete snapshot of all currently indexable
        # records, including rows whose old active vectors remain ready.
        # Reading ready rows here does not mutate their online artifact state.
        for kind in sorted(shadow_kinds):
            work.extend(db_manager.list_artifacts_for_work(
                project_id,
                [kind],
                states=("pending", "processing", "ready", "failed", "stale"),
                limit=100000,
            ))
        db_manager.update_job(job_id, total=len(work), stage="processing")
        shadow_success: Dict[str, List[str]] = {
            kind: [] for kind in shadow_kinds
        }
        shadow_outcomes: Dict[str, Dict[str, Dict[str, Any]]] = {
            kind: {} for kind in shadow_kinds
        }
        shadow_candidate_counts = {
            kind: sum(1 for artifact in work if artifact["kind"] == kind)
            for kind in shadow_kinds
        }
        failures: Dict[str, int] = {kind: 0 for kind in kinds}
        # audio_vector 攒批：批量编码一次 GPU forward 处理一批文件
        audio_batch_queue: List[Tuple[str, str, Dict[str, Any], bool, str]] = []
        # text_vector 攒批：CLAP 文本编码一次 GPU forward 处理一批文本
        text_batch_queue: List[Tuple[str, str, Dict[str, Any], bool, str]] = []
        for index, artifact in enumerate(work):
            job = db_manager.get_job(job_id)
            if job and job["cancel_requested"]:
                if artifact["kind"] not in shadow_kinds:
                    db_manager.set_artifact_state(
                        project_id, artifact["file_uuid"], artifact["kind"], "stale"
                    )
                db_manager.update_job(
                    job_id, state="cancelled", stage="cancelled", processed=index
                )
                return
            kind = artifact["kind"]
            file_uuid = artifact["file_uuid"]
            is_shadow = kind in shadow_kinds
            if not is_shadow:
                db_manager.set_artifact_state(project_id, file_uuid, kind, "processing")
            try:
                if kind == "waveform":
                    waveform = await _run_audio_work(service.waveform, artifact["path"])
                    db_manager.update_peaks(
                        artifact["path"],
                        waveform.peaks,
                        project_id,
                        source_fingerprint=waveform.fingerprint.source_key,
                        waveform_fingerprint=waveform.fingerprint.key,
                        waveform_version=int(waveform.fingerprint.waveform_version),
                    )
                elif kind == "audio_vector":
                    if not is_embedder_available():
                        outcome = {
                            "state": "pending",
                            "error_code": "model_unavailable",
                            "error_message": "CLAP model is not installed or ready",
                            "permanent": False,
                        }
                        if is_shadow:
                            shadow_outcomes[kind][file_uuid] = outcome
                        else:
                            db_manager.set_artifact_state(
                                project_id, file_uuid, kind, "pending",
                                error_code=outcome["error_code"],
                                error_message=outcome["error_message"],
                            )
                        failures[kind] += 1
                        continue
                    # 攒批：遍历阶段只登记，由循环尾部统一小批量编码+落库。
                    # 编码在落库阶段按小批（batch_size=8）执行，避开大批量
                    # GPU forward 偶发挂起，同时保证整体吞吐。
                    audio_batch_queue.append((
                        artifact["path"],
                        file_uuid,
                        {
                            "file_id": file_uuid,
                            "filename": artifact["filename"],
                            "duration": artifact["duration"],
                            "sample_rate": artifact["sample_rate"],
                            "channels": artifact["channels"],
                            "size": artifact["file_size"],
                            "tags": artifact["tags"],
                            "project_id": project_id,
                        },
                        is_shadow,
                        artifact["source_fingerprint"],
                    ))
                    continue
                else:
                    metadata = _build_text_metadata_payload(
                        project_id,
                        file_uuid,
                        artifact,
                        tags=artifact["tags"],
                        source_fingerprint=artifact["source_fingerprint"],
                        folder_context=folder_context,
                    )
                    text_batch_queue.append((
                        artifact["path"],
                        file_uuid,
                        metadata,
                        is_shadow,
                        artifact["source_fingerprint"],
                    ))
                    continue
            except AudioServiceError as exc:
                failures[kind] += 1
                if is_shadow:
                    shadow_outcomes[kind][file_uuid] = {
                        "state": "failed",
                        "error_code": exc.code,
                        "error_message": exc.message,
                        "permanent": not exc.retryable,
                    }
                else:
                    db_manager.set_artifact_state(
                        project_id, file_uuid, kind, "failed",
                        error_code=exc.code, error_message=exc.message,
                    )
            except Exception as exc:
                failures[kind] += 1
                if is_shadow:
                    permanent_codes = {
                        "audio_probe_failed",
                        "audio_decode_failed",
                        "unsupported_audio_format",
                    }
                    shadow_outcomes[kind][file_uuid] = {
                        "state": "failed",
                        "error_code": f"{kind}_failed",
                        "error_message": str(exc),
                        "permanent": bool(
                            kind == "audio_vector"
                            and artifact.get("error_code") in permanent_codes
                        ),
                    }
                else:
                    db_manager.set_artifact_state(
                        project_id, file_uuid, kind, "failed",
                        error_code=f"{kind}_failed", error_message=str(exc),
                    )
            finally:
                db_manager.update_job(job_id, processed=index + 1, stage=kind)

        # 循环尾：批量落库攒下的 audio_vector（一次 GPU forward 一批）
        if audio_batch_queue:
            audio_target = vector_targets.get("audio_vector")
            if audio_target is None:
                for _path, file_uuid, _meta, _is_shadow, _fp in audio_batch_queue:
                    failures["audio_vector"] += 1
                    db_manager.set_artifact_state(
                        project_id, file_uuid, "audio_vector", "failed",
                        error_code="audio_index_failed",
                    )
            else:
                entries = [
                    (path, file_uuid, metadata)
                    for path, file_uuid, metadata, _is_shadow, _fp in audio_batch_queue
                ]
                # 分块落库：整批 5 万条一次性编码容易触发批量规模相关的
                # CUDA 偶发挂起；按 256 条分块（2048 实测 chroma rust upsert
                # 长时间停滞，512 实测 mel 内存峰值可致进程崩溃），块间清空显存。
                # 分块大小调小，配合"每块落库即标记"，前端进度能持续跳动
                AUDIO_FLUSH_CHUNK = 4
                ok_set: set = set()
                marked_audio: set = set()
                marked_count = 0
                queue_by_uuid = {item[1]: item for item in audio_batch_queue}
                for ci in range(0, len(entries), AUDIO_FLUSH_CHUNK):
                    chunk = entries[ci:ci + AUDIO_FLUSH_CHUNK]
                    try:
                        # 单批看门狗：坏文件会让编码永久挂起，超时后标记失败并重启 worker
                        chunk_ok = await asyncio.wait_for(
                            _run_model_work(audio_target.add_audio_batch, chunk),
                            timeout=600,
                        )
                        if chunk_ok:
                            ok_set.update(chunk_ok)
                    except asyncio.TimeoutError:
                        logger.error(
                            "[索引] 编码超时（>180s），疑似损坏文件，标记失败并重启 worker: %s",
                            "|".join(p for p, _f, _m in chunk),
                        )
                        try:
                            from core.embedder import get_embedder
                            _emb = get_embedder()
                            if _emb is not None:
                                _emb.release_gpu()
                        except Exception:
                            pass
                        # 拆成单文件重试：只有真正卡死的那个会被记为失败，
                        # 同批其它正常文件照样入库。
                        for _single in chunk:
                            try:
                                _ok = await asyncio.wait_for(
                                    _run_model_work(audio_target.add_audio_batch, [_single]),
                                    timeout=90,
                                )
                                if _ok:
                                    ok_set.update(_ok)
                            except asyncio.TimeoutError:
                                logger.error("[索引] 单文件编码超时，记入毒文件名单: %s", _single[0])
                                try:
                                    import config as _cfg
                                    from core.embedder import _blacklist_file
                                    path_file = _blacklist_file()
                                    with open(path_file, "a", encoding="utf-8") as _fh:
                                        _fh.write(f"{_single[0]}\t{int(time.time())}\t1\n")
                                except Exception as _exc:
                                    logger.debug("写入毒文件名单失败: %s", _exc)
                            except Exception:
                                pass
                    except Exception as exc:
                        logger.exception("批量 audio_vector 落库失败")
                        try:
                            logger.error("AUDIO_BATCH_FAIL_PATHS=%s",
                                         "|".join(p for p, _fid, _m in chunk))
                        except Exception:
                            pass
                    if ci + AUDIO_FLUSH_CHUNK < len(entries):
                        try:
                            import torch as _torch
                            if _torch.cuda.is_available():
                                _torch.cuda.empty_cache()
                        except Exception:
                            pass
                    # 立即落库这一块：前端「已索引」能随处理逐块 +N
                    for _p2, _fid2, _m2 in chunk:
                        if _fid2 in marked_audio:
                            continue
                        marked_audio.add(_fid2)
                        pair = queue_by_uuid.get(_fid2)
                        if pair is None:
                            continue
                        _path3, _uuid3, _meta3, _is_shadow3, _fp3 = pair
                        if _fid2 in ok_set:
                            if _is_shadow3:
                                shadow_success["audio_vector"].append(_fid2)
                            else:
                                db_manager.set_artifact_state(
                                    project_id, _fid2, "audio_vector", "ready",
                                    source_fingerprint=_fp3,
                                )
                        else:
                            failures["audio_vector"] += 1
                            if _is_shadow3:
                                shadow_outcomes["audio_vector"][_fid2] = {
                                    "state": "failed",
                                    "error_code": "audio_index_failed",
                                    "error_message": "批量编码未产出向量",
                                    "permanent": False,
                                }
                            else:
                                db_manager.set_artifact_state(
                                    project_id, _fid2, "audio_vector", "failed",
                                    error_code="audio_index_failed",
                                    error_message="批量编码未产出向量",
                                )
                        marked_count += 1
                        try:
                            _index_progress["audio"] = _index_progress.get("audio", 0) + 1
                        except Exception:
                            pass
                    try:
                        db_manager.update_job(
                            job_id,
                            processed=min(ci + len(chunk), len(entries)),
                            total=len(entries),
                            stage="audio_vector",
                        )
                    except Exception:
                        pass
                for path, file_uuid, _meta, is_shadow, source_fingerprint in audio_batch_queue:
                    if file_uuid in marked_audio:
                        continue
                    if file_uuid in ok_set:
                        if is_shadow:
                            shadow_success["audio_vector"].append(file_uuid)
                        else:
                            db_manager.set_artifact_state(
                                project_id, file_uuid, "audio_vector", "ready",
                                source_fingerprint=source_fingerprint,
                            )
                    else:
                        failures["audio_vector"] += 1
                        if is_shadow:
                            shadow_outcomes["audio_vector"][file_uuid] = {
                                "state": "failed",
                                "error_code": "audio_index_failed",
                                "error_message": "批量编码未产出向量",
                                "permanent": False,
                            }
                        else:
                            db_manager.set_artifact_state(
                                project_id, file_uuid, "audio_vector", "failed",
                                error_code="audio_index_failed",
                                error_message="批量编码未产出向量",
                            )

        # 循环尾：批量落库攒下的 text_vector（CLAP 文本一次 GPU forward 一批）
        if text_batch_queue:
            text_target = vector_targets.get("text_vector")
            if text_target is None:
                for _path, file_uuid, _meta, _is_shadow, _fp in text_batch_queue:
                    failures["text_vector"] += 1
                    db_manager.set_artifact_state(
                        project_id, file_uuid, "text_vector", "failed",
                        error_code="text_index_failed",
                    )
            else:
                TEXT_BATCH = 32
                for i in range(0, len(text_batch_queue), TEXT_BATCH):
                    chunk = text_batch_queue[i:i + TEXT_BATCH]
                    fingerprint = None
                    try:
                        result = await asyncio.wait_for(
                            text_target.upsert_metadata(
                                [meta for _p, _fid, meta, _is, _fp in chunk]
                            ),
                            timeout=180,
                        )
                        ok_count = int(result.get("indexed", 0) or 0)
                        fingerprint = result.get("fingerprint")
                    except Exception as exc:
                        logger.exception("批量 text_vector 落库失败")
                        if "device-side assert" in str(exc) or "CUDA 上下文已损坏" in str(exc):
                            # CUDA 上下文被断言污染，进程内不可恢复：继续跑只会把
                            # 剩余几万条全部标成 failed，进而让 needs_rebuild 常为真。
                            # 中止本轮，把剩余产物留给重启后的下一轮。
                            logger.error(
                                "文本嵌入 CUDA 上下文已损坏，中止本轮文本落库，"
                                "剩余产物保持待处理状态"
                            )
                            break
                        ok_count = 0
                    try:
                        db_manager.update_job(
                            job_id,
                            processed=min(i + len(chunk), len(text_batch_queue)),
                            total=len(text_batch_queue),
                            stage="text_vector",
                        )
                    except Exception:
                        pass
                    for j, (_p, file_uuid, _meta, is_shadow, source_fingerprint) in enumerate(chunk):
                        if j < ok_count:
                            if is_shadow:
                                shadow_success["text_vector"].append(file_uuid)
                            else:
                                db_manager.set_artifact_state(
                                    project_id, file_uuid, "text_vector", "ready",
                                    source_fingerprint=source_fingerprint,
                                    engine_fingerprint=fingerprint,
                                )
                        else:
                            failures["text_vector"] += 1
                            if is_shadow:
                                shadow_outcomes["text_vector"][file_uuid] = {
                                    "state": "failed",
                                    "error_code": "text_index_failed",
                                    "error_message": "批量编码未产出向量",
                                    "permanent": False,
                                }
                            else:
                                db_manager.set_artifact_state(
                                    project_id, file_uuid, "text_vector", "failed",
                                    error_code="text_index_failed",
                                    error_message="批量编码未产出向量",
                                )

        if shadow_kinds:
            eligible: Dict[str, Any] = {}
            for kind in shadow_kinds:
                success_count = len(set(shadow_success.get(kind, [])))
                outcomes = shadow_outcomes.get(kind, {})
                candidate_count = shadow_candidate_counts.get(kind, 0)
                all_permanently_excluded = bool(
                    candidate_count > 0
                    and len(outcomes) == candidate_count
                    and all(
                        outcome.get("state") == "failed"
                        and outcome.get("permanent")
                        for outcome in outcomes.values()
                    )
                )
                # At least one valid vector proves the target engine works.
                # An empty project or a library consisting solely of known
                # permanently unindexable audio may also activate an empty
                # verified shadow. A total transient/provider failure may not.
                if success_count > 0 or candidate_count == 0 or all_permanently_excluded:
                    eligible[kind] = vector_targets[kind]
            if eligible:
                activate_verified_shadows(
                    db_manager,
                    project_id,
                    eligible,
                    {
                        kind: len(set(shadow_success.get(kind, [])))
                        for kind in eligible
                    },
                )
                for kind in eligible:
                    engine_fingerprint = eligible[kind].get_manifest().get(
                        "engine_fingerprint"
                    )
                    for file_id in shadow_success[kind]:
                        record = db_manager.get_file_by_uuid(file_id, project_id)
                        db_manager.set_artifact_state(
                            project_id,
                            file_id,
                            kind,
                            "ready",
                            source_fingerprint=(record.source_fingerprint if record else None),
                            engine_fingerprint=engine_fingerprint,
                        )
                    for file_id, outcome in shadow_outcomes.get(kind, {}).items():
                        record = db_manager.get_file_by_uuid(file_id, project_id)
                        db_manager.set_artifact_state(
                            project_id,
                            file_id,
                            kind,
                            outcome["state"],
                            source_fingerprint=(record.source_fingerprint if record else None),
                            error_code=outcome.get("error_code"),
                            error_message=outcome.get("error_message"),
                        )
            for kind, indexer in vector_targets.items():
                if kind not in shadow_kinds:
                    db_manager.upsert_index_manifest(
                        project_id,
                        kind,
                        **_manifest_update_values(indexer.get_manifest()),
                        revision_increment=1,
                    )
                    continue
                if kind in eligible:
                    continue
                db_manager.upsert_index_manifest(
                    project_id, kind, state="rebuild_failed"
                )
        else:
            for kind, indexer in vector_targets.items():
                db_manager.upsert_index_manifest(
                    project_id,
                    kind,
                    **_manifest_update_values(indexer.get_manifest()),
                    revision_increment=1,
                )

        reset_optimized_searcher(project_id)
        reset_ai_chat_service(project_id)
        total_failures = sum(failures.values())
        # 容忍批量临时跳过（未扫描区域黑名单）+ 少量永久性坏文件：只要激活成功、
        # 向量主体可用，不因个别失败项将整个任务判为失败。
        # 阈值放宽到 40000：覆盖“先测试 2.1 万条、其余稍后补全”的场景。
        if total_failures and total_failures > 40000:
            db_manager.update_job(
                job_id,
                state="failed",
                stage="done_with_errors",
                error_code="index_items_failed",
                error_message=f"{total_failures} artifact(s) failed or remain pending",
            )
        else:
            db_manager.update_job(job_id, state="completed", stage="done")
    except Exception as exc:
        logger.exception(f"索引修复任务失败: {exc}")
        db_manager.update_job(
            job_id, state="failed", stage="failed",
            error_code="index_job_failed", error_message=str(exc),
        )


# ==================== 文件列表 ====================

@app.get("/api/v1/files")
async def get_indexed_files(
    project_id: Optional[str] = None,
    limit: int = Query(default=200, ge=1, le=500),
    cursor: Optional[int] = Query(default=None, ge=1),
    folder: Optional[str] = Query(default=None, description="只返回该目录（含子目录）下的文件"),
    tag: Optional[str] = Query(default=None, description="只返回带该标签的文件（M4 双层标签）"),
    source: Optional[str] = Query(default=None, description="ai / user"),
    sort: Optional[str] = Query(default=None, description="name / duration / size / date"),
    order: Optional[str] = Query(default="desc"),
):
    """获取工程内的分页元数据，波形按可见项另行加载。"""
    try:
        effective_project = project_id or getattr(config, 'CURRENT_PROJECT_ID', 'default')
        db_manager = get_db_manager()
        if not is_safe_project_id(effective_project) or not db_manager.get_project(effective_project):
            raise SoundBotAPIError("project_not_found", "工程不存在", status_code=404)
        if tag:
            # 标签筛选：走 file_tags 连接，分页简单起见一次返回上限
            with db_manager.get_cursor() as tag_cursor:
                rows = tag_cursor.execute(
                    """
                    SELECT f.file_uuid, f.path, f.filename, f.duration, f.file_size,
                           f.sample_rate, f.channels, f.channels, f.tags, f.ai_description
                    FROM file_tags ft
                    JOIN tags t ON t.id = ft.tag_id AND t.project_id = ft.project_id
                    JOIN files f ON f.file_uuid = ft.file_uuid AND f.project_id = ft.project_id
                    WHERE ft.project_id=? AND t.name=?
                    ORDER BY f.filename
                    LIMIT ?
                    """,
                    (effective_project, tag, limit),
                ).fetchall()
            files = [
                {
                    "id": r[0],
                    "path": r[1],
                    "filename": r[2],
                    "duration": r[3],
                    "size": r[4],
                    "sample_rate": r[5],
                    "channels": r[6],
                    "tags": r[8],
                    "ai_description": r[9],
                }
                for r in rows
            ]
            return {"project_id": effective_project, "total": len(files), "files": files, "next_cursor": None}

        files, next_cursor = db_manager.get_files_cursor_page(
            effective_project, limit=limit, before_id=cursor, folder=folder
        )
        filtered_total = None
        if source:
            files = [f for f in files if str(f.get("source") or "user") == source]
            filtered_total = len(files)
        if sort:
            reverse = str(order or "desc").lower() != "asc"
            key_map = {
                "name": lambda f: str(f.get("filename") or "").lower(),
                "duration": lambda f: float(f.get("duration") or 0),
                "size": lambda f: int(f.get("file_size") or 0),
                "date": lambda f: int(f.get("id") or 0),
            }
            key_func = key_map.get(sort)
            if key_func:
                try:
                    files = sorted(files, key=key_func, reverse=reverse)
                except Exception:
                    pass
        for item in files:
            item["size"] = item.pop("file_size")
        total = filtered_total if filtered_total is not None else (
            db_manager.count_files_in_folder(effective_project, folder)
            if folder
            else db_manager.get_file_count(effective_project)
        )
        return {
            "project_id": effective_project,
            "total": total,
            "files": files,
            "next_cursor": next_cursor,
        }
    except SoundBotAPIError:
        raise
    except Exception as e:
        logger.error(f"获取文件列表失败: {e}")
        raise HTTPException(status_code=500, detail=str(e))


# ==================== 描述包（可移植） ====================

def _detect_library_root(paths: List[str]) -> str:
    """推断音效库根目录：按「盘符+首层」分组，取文件数最多那组的公共前缀。"""
    parts_list = [[seg for seg in str(p).replace('/', '\\').split('\\') if seg] for p in paths]
    if not parts_list:
        return ""

    def group_key(parts):
        return ((parts[0] if parts else "") + "\\" + (parts[1] if len(parts) > 1 else "")).lower()

    counts: Dict[str, int] = {}
    for parts in parts_list:
        key = group_key(parts)
        counts[key] = counts.get(key, 0) + 1
    if not counts:
        return ""
    main_key = max(counts, key=counts.get)
    common: List[str] = []
    for parts in parts_list:
        if group_key(parts) != main_key:
            continue
        if not common:
            common = parts[:-1]
            continue
        i = 0
        while i < len(common) and i < len(parts) - 1 and common[i].lower() == parts[i].lower():
            i += 1
        common = common[:i]
    return "\\".join(common)


def _relative_to_root(path: str, root: str) -> str:
    """把绝对路径转成相对库根的形式；不在库根下时返回原路径。"""
    if not root:
        return str(path)
    norm_path = str(path).replace('/', '\\')
    norm_root = root.replace('/', '\\').rstrip('\\')
    if norm_path.lower().startswith(norm_root.lower() + '\\'):
        return norm_path[len(norm_root) + 1:]
    return norm_path


@app.get("/api/v1/descriptions/export")
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


@app.post("/api/v1/metadata/preview")
async def metadata_preview(payload: Dict[str, Any], project_id: str = Query(default="default")):
    """描述包导入预览：只算匹配，不写库。"""
    from core.metadata_pack import preview as run_preview

    items = payload.get("items") or []
    if not isinstance(items, list) or not items:
        raise SoundBotAPIError("empty_pack", "描述包为空", status_code=400)
    try:
        result = await asyncio.to_thread(run_preview, project_id, items)
        if not payload.get("include_pairs"):
            # pairs 可能很大，默认只回传样例
            result.pop("pairs", None)
        return {"success": True, **result}
    except Exception as exc:
        logger.error("描述包预览失败: %s", exc)
        raise HTTPException(status_code=500, detail=str(exc))


@app.post("/api/v1/metadata/apply")
async def metadata_apply(payload: Dict[str, Any], project_id: str = Query(default="default")):
    """按预览结果写库：默认只补空白字段。"""
    from core.metadata_pack import apply as run_apply

    pairs = payload.get("pairs") or []
    overwrite = bool(payload.get("overwrite"))
    if not isinstance(pairs, list) or not pairs:
        raise SoundBotAPIError("empty_pairs", "没有可应用的结果", status_code=400)
    try:
        result = await asyncio.to_thread(run_apply, project_id, pairs, overwrite)
        if result.get("applied"):
            try:
                db_manager = get_db_manager()
                db_manager.mark_project_artifacts(project_id, ["text_vector"], "stale")
                db_manager.upsert_index_manifest(
                    project_id, "text_vector", state="stale", revision_increment=1
                )
                # 之前只标脏不重建，搜索会一直用旧向量；这里排一个后台任务补上。
                await asyncio.sleep(0.5)
                _schedule_project_reconcile(project_id, ("text_vector",), reason="metadata_apply")
            except Exception as exc:
                logger.debug("标记/重建文本索引失败: %s", exc)
        return {"success": True, **result}
    except Exception as exc:
        logger.error("描述包应用失败: %s", exc)
        raise HTTPException(status_code=500, detail=str(exc))


@app.post("/api/v1/descriptions/import")
async def import_descriptions(
    payload: Dict[str, Any],
    background_tasks: BackgroundTasks,
    project_id: str = Query(default="default"),
):
    """导入描述包：按相对路径（大小写不敏感）匹配，套用到当前库。"""
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
        unmatched: List[Dict[str, str]] = []
        for item in items:
            description = str(item.get("description") or "").strip()
            if not description:
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
            with db_manager.get_cursor() as cursor:
                cursor.execute(
                    "UPDATE files SET ai_description=? WHERE file_uuid=?",
                    (description, uuid_value),
                )
                cursor.connection.commit()
            applied += 1
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


# ==================== 音频裁切 ====================

def _render_audio_edit(
    source_file: Path,
    output_path: Path,
    *,
    start: float = 0.0,
    end: Optional[float] = None,
    fade_in: float = 0.0,
    fade_out: float = 0.0,
) -> Dict[str, Any]:
    """Decode once through AudioService and atomically export a PCM WAV."""
    import numpy as np
    from core.audio_service import get_audio_service, AudioServiceError

    service = get_audio_service()
    decoded = service.decode(source_file, mono=False)
    total_frames = int(decoded.samples.shape[0])
    start_frame = max(0, int(float(start) * decoded.sample_rate))
    end_frame = (
        total_frames
        if end is None
        else min(total_frames, int(float(end) * decoded.sample_rate))
    )
    if start_frame >= total_frames or end_frame <= start_frame:
        raise AudioServiceError(
            "invalid_clip_range",
            "裁切范围超出音频时长",
            details={"start": start, "end": end, "duration": decoded.duration},
        )
    samples = np.array(decoded.samples[start_frame:end_frame], copy=True)
    frame_count = int(samples.shape[0])
    fade_in_frames = min(frame_count, max(0, int(float(fade_in) * decoded.sample_rate)))
    fade_out_frames = min(frame_count, max(0, int(float(fade_out) * decoded.sample_rate)))
    if fade_in_frames:
        samples[:fade_in_frames] *= np.linspace(
            0.0, 1.0, fade_in_frames, dtype=np.float32
        )[:, None]
    if fade_out_frames:
        samples[-fade_out_frames:] *= np.linspace(
            1.0, 0.0, fade_out_frames, dtype=np.float32
        )[:, None]
    exported = service.export_wav(output_path, samples, decoded.sample_rate)
    return {
        "path": exported,
        "duration": float(frame_count / decoded.sample_rate),
    }


def _raise_audio_edit_error(exc: Exception) -> None:
    from core.audio_service import AudioServiceError

    if isinstance(exc, AudioServiceError):
        raise SoundBotAPIError(
            exc.code,
            exc.message,
            status_code=400 if exc.code == "invalid_clip_range" else 422,
            retryable=exc.retryable,
            details=exc.details,
        )
    raise exc

@app.post("/api/export/clip", response_model=schemas.ClipResponse)
async def export_clip(request: schemas.ClipRequest):
    """
    裁切音频片段

    - **path**: 源音频文件路径
    - **start**: 裁切起始时间（秒）
    - **end**: 裁切结束时间（秒）
    - **output**: 输出文件路径（可选，默认在原文件同目录添加 _clip 后缀）
    - **temp_file**: 是否创建临时文件（用于拖拽导出，会在系统临时目录创建）
    """
    logger.info(f"[裁切请求] path={request.path}, start={request.start}, end={request.end}, temp_file={request.temp_file}")

    source_file = config.validate_audio_path(request.path)

    if request.start >= request.end:
        raise HTTPException(status_code=400, detail="起始时间必须小于结束时间")

    try:
        if request.temp_file:
            import uuid
            temp_name = f"clip_{int(time.time())}_{uuid.uuid4().hex[:8]}.wav"
            output_path = Path(config.get_temp_clip_dir()) / temp_name
        elif request.output:
            if not validate_path(request.output):
                raise HTTPException(status_code=400, detail="输出路径包含非法字符")
            output_path = Path(request.output)
        else:
            output_path = source_file.parent / f"{source_file.stem}_clip.wav"
        result = await _run_audio_work(
            _render_audio_edit,
            source_file,
            output_path,
            start=request.start,
            end=request.end,
        )

        return schemas.ClipResponse(
            success=True,
            output_path=str(result["path"]),
            duration=result["duration"],
            message=f"成功裁切 {request.start:.2f}s - {request.end:.2f}s"
        )
    except (HTTPException, SoundBotAPIError):
        raise
    except Exception as e:
        logger.error(f"裁切失败: {e}")
        _raise_audio_edit_error(e)


# ==================== 删除临时文件 ====================

@app.delete("/api/temp/{file_path:path}")
async def delete_temp_file(file_path: str):
    """
    删除临时文件

    - **file_path**: 临时文件路径（URL编码）
    """
    import os

    try:
        # 安全检查：确保文件在临时目录内
        abs_path = Path(file_path).resolve()
        temp_dir_path = Path(config.get_temp_clip_dir()).resolve()
        try:
            abs_path.relative_to(temp_dir_path)
        except ValueError:
            raise HTTPException(status_code=400, detail="只能删除临时目录中的文件")

        # 删除文件
        if abs_path.exists():
            abs_path.unlink()
            return {"success": True, "message": f"已删除临时文件: {abs_path.name}"}
        else:
            return {"success": True, "message": "文件不存在"}

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"删除临时文件失败: {e}")
        raise HTTPException(status_code=500, detail=str(e))


# ==================== 音频淡入淡出 ====================

@app.post("/api/audio/fade", response_model=schemas.FadeResponse)
async def audio_fade(request: schemas.FadeRequest):
    """
    音频淡入淡出
    
    - **path**: 音频文件路径
    - **fade_in**: 淡入时长（秒）
    - **fade_out**: 淡出时长（秒）
    - **output**: 输出文件路径（可选，默认在原文件同目录添加 _fade 后缀）
    """
    source_file = config.validate_audio_path(request.path)
    
    try:
        if request.output:
            if not validate_path(request.output):
                raise HTTPException(status_code=400, detail="输出路径包含非法字符")
            output_path = Path(request.output)
        else:
            output_path = source_file.parent / f"{source_file.stem}_fade.wav"
        result = await _run_audio_work(
            _render_audio_edit,
            source_file,
            output_path,
            fade_in=request.fade_in,
            fade_out=request.fade_out,
        )
        
        return schemas.FadeResponse(
            success=True,
            output_path=str(result["path"]),
            message=f"淡入: {request.fade_in}s, 淡出: {request.fade_out}s"
        )
    except (HTTPException, SoundBotAPIError):
        raise
    except Exception as e:
        logger.error(f"淡入淡出处理失败: {e}")
        _raise_audio_edit_error(e)


# ==================== 裁切并淡入淡出 ====================

@app.post("/api/export/clip_with_fade", response_model=schemas.ClipResponse)
async def export_clip_with_fade(request: schemas.ClipWithFadeRequest):
    """
    裁切音频片段并应用淡入淡出

    - **path**: 源音频文件路径
    - **start**: 裁切起始时间（秒）
    - **end**: 裁切结束时间（秒）
    - **fade_in**: 淡入时长（秒）
    - **fade_out**: 淡出时长（秒）
    - **temp_file**: 是否创建临时文件
    """
    import uuid

    source_file = config.validate_audio_path(request.path)

    if request.start >= request.end:
        raise HTTPException(status_code=400, detail="起始时间必须小于结束时间")

    try:
        if request.temp_file:
            temp_name = f"clip_fade_{int(time.time())}_{uuid.uuid4().hex[:8]}.wav"
            output_path = Path(config.get_temp_clip_dir()) / temp_name
        else:
            output_path = source_file.parent / f"{source_file.stem}_clip_fade.wav"
        result = await _run_audio_work(
            _render_audio_edit,
            source_file,
            output_path,
            start=request.start,
            end=request.end,
            fade_in=request.fade_in,
            fade_out=request.fade_out,
        )

        return schemas.ClipResponse(
            success=True,
            output_path=str(result["path"]),
            duration=result["duration"],
            message=f"裁切 {request.start:.2f}s - {request.end:.2f}s, 淡入 {request.fade_in}s, 淡出 {request.fade_out}s"
        )
    except (HTTPException, SoundBotAPIError):
        raise
    except Exception as e:
        logger.error(f"裁切并淡入淡出失败: {e}")
        _raise_audio_edit_error(e)


# ==================== 验证临时文件 ====================

@app.get("/api/clip/verify")
async def verify_clip(file_path: str = Query(..., description="临时文件路径")):
    """
    验证临时文件是否存在

    - **file_path**: 临时文件路径（URL编码）
    """
    abs_path = Path(file_path).resolve()
    temp_dir_path = Path(config.get_temp_clip_dir()).resolve()
    try:
        abs_path.relative_to(temp_dir_path)
    except ValueError:
        raise HTTPException(status_code=400, detail="只能验证临时目录中的文件")

    exists = abs_path.exists() and abs_path.is_file()

    return {
        "exists": exists,
        "path": str(abs_path),
        "size": abs_path.stat().st_size if exists else 0
    }


# ==================== 临时文件路径配置 ====================

@app.get("/api/v1/config/temp-dir", response_model=schemas.TempDirResponse)
async def get_temp_dir():
    """
    获取当前临时文件存放目录
    """
    return schemas.TempDirResponse(
        temp_dir=config.get_temp_clip_dir(),
        default_dir=config.DEFAULT_TEMP_CLIP_DIR
    )


@app.post("/api/v1/config/temp-dir", response_model=schemas.TempDirResponse)
async def set_temp_dir(request: schemas.TempDirRequest):
    """
    设置临时文件存放目录
    
    - **temp_dir**: 新的临时文件目录路径
    """
    import json
    
    new_dir = request.temp_dir
    
    # 验证路径安全性，防止路径遍历攻击
    if not validate_path(new_dir):
        raise HTTPException(status_code=400, detail="路径包含非法字符")
    
    # 验证路径是否存在
    if not os.path.exists(new_dir):
        raise HTTPException(status_code=400, detail="指定的目录不存在")
    
    if not os.path.isdir(new_dir):
        raise HTTPException(status_code=400, detail="指定的路径不是目录")
    
    # 保存到用户数据目录；config.get_temp_clip_dir() 也从这里读取
    config_path = config.get_user_data_dir() / "user_config.json"
    
    try:
        # 确保配置目录存在
        config_path.parent.mkdir(parents=True, exist_ok=True)
        
        # 读取现有配置或创建新配置
        if config_path.exists():
            with config_path.open('r', encoding='utf-8') as f:
                current_config = json.load(f)
        else:
            current_config = {}
        
        # 更新临时文件目录
        current_config['tempClipDir'] = new_dir
        
        # 保存配置
        with config_path.open('w', encoding='utf-8') as f:
            json.dump(current_config, f, ensure_ascii=False, indent=2)

        config.TEMP_CLIP_DIR = config.get_temp_clip_dir()
        
        logger.info(f"临时文件目录已更新: {new_dir}")
        
        return schemas.TempDirResponse(
            temp_dir=new_dir,
            default_dir=config.DEFAULT_TEMP_CLIP_DIR,
            message="临时文件目录设置成功"
        )
        
    except Exception as e:
        logger.error(f"设置临时文件目录失败: {e}")
        raise HTTPException(status_code=500, detail=f"设置失败: {str(e)}")


@app.get("/api/v1/disk-space")
async def get_disk_space():
    """
    获取临时文件目录所在磁盘的空间信息
    """
    try:
        import shutil
        temp_dir = config.get_temp_clip_dir()
        
        # 获取磁盘使用情况
        usage = shutil.disk_usage(temp_dir)
        
        return {
            "success": True,
            "path": temp_dir,
            "total_bytes": usage.total,
            "used_bytes": usage.used,
            "free_bytes": usage.free
        }
    except Exception as e:
        logger.error(f"获取磁盘空间失败: {e}")
        raise HTTPException(status_code=500, detail=f"获取磁盘空间失败: {str(e)}")


@app.post("/api/v1/temp-clips/clear")
async def clear_temp_clips():
    """
    清理所有临时裁切文件
    """
    try:
        temp_dir = config.get_temp_clip_dir()
        
        if not os.path.exists(temp_dir):
            return {
                "success": True,
                "deleted_count": 0,
                "freed_space": 0,
                "message": "临时文件目录不存在"
            }
        
        deleted_count = 0
        freed_space = 0
        
        # 遍历并删除所有文件
        for item in os.listdir(temp_dir):
            item_path = os.path.join(temp_dir, item)
            try:
                if os.path.isfile(item_path):
                    file_size = os.path.getsize(item_path)
                    os.remove(item_path)
                    deleted_count += 1
                    freed_space += file_size
                elif os.path.isdir(item_path):
                    # 递归删除子目录
                    import shutil
                    dir_size = sum(os.path.getsize(os.path.join(dirpath, filename)) 
                                  for dirpath, dirnames, filenames in os.walk(item_path) 
                                  for filename in filenames)
                    shutil.rmtree(item_path)
                    deleted_count += 1
                    freed_space += dir_size
            except Exception as e:
                logger.warning(f"删除文件失败 {item_path}: {e}")
        
        logger.info(f"清理临时文件完成: 删除 {deleted_count} 项, 释放 {freed_space} 字节")
        
        return {
            "success": True,
            "deleted_count": deleted_count,
            "freed_space": freed_space,
            "message": f"已清理 {deleted_count} 个文件，释放 {freed_space / (1024*1024):.2f} MB"
        }
    except Exception as e:
        logger.error(f"清理临时文件失败: {e}")
        raise HTTPException(status_code=500, detail=f"清理失败: {str(e)}")


# ==================== 工程管理 API ====================

@app.post("/api/v1/projects")
async def create_project(request: schemas.CreateProjectRequest):
    """
    创建新工程

    - **name**: 工程名称
    - **description**: 工程描述
    - **temp_dir**: 工程特定的临时文件目录
    """
    try:
        import uuid
        project_id = str(uuid.uuid4())

        db_manager = get_db_manager()
        success = db_manager.create_project(
            project_id=project_id,
            name=request.name,
            description=request.description,
            temp_dir=request.temp_dir
        )

        if not success:
            raise SoundBotAPIError("project_create_failed", "创建工程失败")

        return {
            "success": True,
            "project_id": project_id,
            "message": f"工程 '{request.name}' 创建成功"
        }
    except SoundBotAPIError:
        raise
    except Exception as e:
        logger.error(f"创建工程失败: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/api/v1/projects")
async def get_all_projects():
    """
    获取所有工程列表
    """
    try:
        db_manager = get_db_manager()
        projects = db_manager.get_all_projects()

        # 添加每个工程的文件数量
        for project in projects:
            project['file_count'] = db_manager.get_project_file_count(project['id'])

        return {
            "total": len(projects),
            "projects": projects
        }
    except Exception as e:
        logger.error(f"获取工程列表失败: {e}")
        raise HTTPException(status_code=500, detail=str(e))


# 注意：/api/v1/projects/recent 必须在 /api/v1/projects/{project_id} 之前定义
# 否则 FastAPI 会将 "recent" 匹配为 project_id 参数
@app.get("/api/v1/projects/recent")
async def get_recent_projects(limit: int = 10):
    """
    获取最近使用的工程列表
    """
    try:
        db_manager = get_db_manager()
        projects = db_manager.get_recent_projects(limit)

        # 添加每个工程的文件数量
        for project in projects:
            project['file_count'] = db_manager.get_project_file_count(project['id'])

        return {
            "total": len(projects),
            "projects": projects
        }
    except Exception as e:
        logger.error(f"获取最近工程失败: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/api/v1/projects/{project_id}")
async def get_project(project_id: str):
    """
    获取工程详情
    """
    try:
        db_manager = get_db_manager()
        project = db_manager.get_project(project_id)

        if not project:
            raise SoundBotAPIError(
                "project_not_found", "工程不存在", status_code=404
            )

        # 添加文件数量
        project['file_count'] = db_manager.get_project_file_count(project_id)

        return project
    except SoundBotAPIError:
        raise
    except Exception as e:
        logger.error(f"获取工程详情失败: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.put("/api/v1/projects/{project_id}")
async def update_project(project_id: str, request: schemas.UpdateProjectRequest):
    """
    更新工程信息
    """
    try:
        db_manager = get_db_manager()

        # 检查工程是否存在
        existing = db_manager.get_project(project_id)
        if not existing:
            raise HTTPException(status_code=404, detail="工程不存在")

        success = db_manager.update_project(
            project_id=project_id,
            name=request.name,
            description=request.description,
            temp_dir=request.temp_dir,
            settings=request.settings
        )

        if not success:
            raise HTTPException(status_code=400, detail="更新工程失败")

        if getattr(config, 'CURRENT_PROJECT_ID', 'default') == project_id:
            active_temp_dir = request.temp_dir if request.temp_dir is not None else existing.get('temp_dir')
            config.set_project_temp_clip_dir(active_temp_dir)

        return {
            "success": True,
            "message": "工程更新成功"
        }
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"更新工程失败: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.delete("/api/v1/projects/{project_id}")
async def delete_project(project_id: str):
    """
    删除工程（会级联删除所有相关文件、向量数据库和缓存）
    """
    if project_id in _projects_deleting:
        raise SoundBotAPIError("project_deleting", "工程正在删除", status_code=409)
    _projects_deleting.add(project_id)
    try:
        if project_id == "default":
            raise SoundBotAPIError(
                "default_project_protected", "默认工程不能删除", status_code=400
            )
        if not is_safe_project_id(project_id):
            raise SoundBotAPIError("invalid_project_id", "工程 ID 非法", status_code=400)
        db_manager = get_db_manager()

        # 检查工程是否存在
        existing = db_manager.get_project(project_id)
        if not existing:
            raise SoundBotAPIError("project_not_found", "工程不存在", status_code=404)

        # Stop all accepted writers before waiting for the per-project lock.
        cancelled_jobs = db_manager.request_project_job_cancellation(project_id)
        for job_id in cancelled_jobs:
            get_ws_manager().cancel_task(job_id)

        # 检查是否是当前工程
        current_project_id = getattr(config, 'CURRENT_PROJECT_ID', None)
        is_current_project = (current_project_id == project_id)

        async with _get_project_index_lock(project_id):
            # Catch jobs that were accepted just before the deletion flag was set.
            for job_id in db_manager.request_project_job_cancellation(project_id):
                get_ws_manager().cancel_task(job_id)

            # SQLite is authoritative. If this fails, retain the searchable
            # collections; if it succeeds, an orphan index directory is harmless
            # and can be cleaned on the next attempt/startup.
            success = db_manager.delete_project(project_id)
            if not success:
                raise SoundBotAPIError(
                    "project_delete_failed",
                    "工程数据删除失败，原索引仍保留",
                    status_code=503,
                    retryable=True,
                )

            from core.search_engine import reset_optimized_searcher
            from core.ai_chat_service import reset_ai_chat_service
            from core.indexer import delete_project_index

            reset_optimized_searcher(project_id)
            reset_ai_chat_service(project_id)
            reset_searcher(project_id)
            index_deleted = await _run_model_work(delete_project_index, project_id)
            if not index_deleted:
                logger.warning(f"工程 {project_id} 已从 SQLite 删除；孤立索引目录稍后清理")

        # 如果删除的是当前工程，清理缓存并切换到默认工程
        if is_current_project:
            logger.info(f"删除的是当前工程 {project_id}，清理缓存并切换到默认工程")

            # 先切换到默认工程
            config.CURRENT_PROJECT_ID = 'default'
            config.set_project_temp_clip_dir(None)
            logger.info("已切换到默认工程")

            # 重置 Searcher
            reset_optimized_searcher('default')
            logger.info("Searcher 已重置")

        return {
            "success": True,
            "message": "工程已删除",
            "index_deleted": index_deleted,
            "was_current_project": is_current_project,
            "switched_to_default": is_current_project
        }
    except SoundBotAPIError:
        raise
    except Exception as e:
        logger.error(f"删除工程失败: {e}")
        raise HTTPException(status_code=500, detail=str(e))
    finally:
        _projects_deleting.discard(project_id)


@app.post("/api/v1/projects/{project_id}/switch")
async def switch_project(project_id: str):
    """
    切换到指定工程

    会将工程添加到最近工程列表，同时切换向量数据库和清理缓存
    """
    try:
        if not is_safe_project_id(project_id):
            raise SoundBotAPIError("invalid_project_id", "工程 ID 非法", status_code=400)
        # Validate before mutating any global state or clearing working caches.
        db_manager = get_db_manager()
        project = db_manager.get_project(project_id)
        if not project:
            raise SoundBotAPIError("project_not_found", "工程不存在", status_code=404)

        # 获取当前工程ID（用于判断是否真的切换了）
        old_project_id = getattr(config, 'CURRENT_PROJECT_ID', None)

        # 如果确实切换了工程，先更新当前工程ID，然后清理缓存
        if old_project_id and old_project_id != project_id:
            logger.info(f"切换工程: {old_project_id} -> {project_id}，开始清理缓存")

            # Project-scoped caches include the project/revision in their keys.
            # Only discard the two affected project views; live jobs for other
            # projects keep their Chroma clients untouched.
            from core.search_engine import reset_optimized_searcher
            reset_optimized_searcher(old_project_id)
            reset_optimized_searcher(project_id)
            logger.info("Searcher 已重置")

            from core.ai_chat_service import reset_ai_chat_service
            reset_ai_chat_service(old_project_id)
            reset_ai_chat_service(project_id)
            logger.info("AI Chat 工程上下文已重置")

        # 添加到最近工程
        db_manager.add_to_recent_projects(project_id)

        # 更新全局配置中的当前工程
        config.CURRENT_PROJECT_ID = project_id

        # 切换工程特定的临时目录。为空时回退到用户全局配置或默认目录。
        active_temp_dir = config.set_project_temp_clip_dir(project.get('temp_dir'))
        logger.info(f"当前临时文件目录: {active_temp_dir}")

        # 获取该工程的向量数据库信息
        from core.embedder import is_embedder_available

        indexer = _get_active_audio_indexer(project_id)
        indexed_count = indexer.get_indexed_count()

        embedder_available = is_embedder_available()

        return {
            "success": True,
            "project_id": project_id,
            "project_name": project['name'],
            "message": f"已切换到工程 '{project['name']}'",
            "cache_cleared": old_project_id != project_id,
            "vector_db": {
                "indexed_count": indexed_count,
                "embedder_available": embedder_available
            }
        }
    except SoundBotAPIError:
        raise
    except Exception as e:
        logger.error(f"切换工程失败: {e}")
        raise HTTPException(status_code=500, detail=str(e))


# ==================== 工程文件和文件夹管理 ====================

@app.get("/api/v1/projects/{project_id}/files")
async def get_project_files(
    project_id: str,
    limit: int = Query(default=200, ge=1, le=500),
    cursor: Optional[int] = Query(default=None, ge=1),
):
    """Compatibility alias for the metadata-only cursor-paginated file list."""
    db_manager = get_db_manager()
    if not is_safe_project_id(project_id):
        raise SoundBotAPIError("invalid_project_id", "工程 ID 非法", status_code=400)
    project = db_manager.get_project(project_id)
    if not project:
        raise SoundBotAPIError("project_not_found", "工程不存在", status_code=404)
    files, next_cursor = db_manager.get_files_cursor_page(
        project_id, limit=limit, before_id=cursor
    )
    for item in files:
        item["size"] = item.pop("file_size")
    return {
        "project_id": project_id,
        "project_name": project["name"],
        "total": db_manager.get_file_count(project_id),
        "files": files,
        "next_cursor": next_cursor,
    }


# ==================== 用户自定义文件夹 API ====================

class CreateFolderRequest(BaseModel):
    name: str
    description: Optional[str] = None
    color: Optional[str] = '#3b82f6'


class UpdateFolderRequest(BaseModel):
    name: Optional[str] = None
    description: Optional[str] = None
    color: Optional[str] = None
    sort_order: Optional[int] = None


@app.get("/api/v1/projects/{project_id}/folders")
async def get_user_folders(project_id: str):
    """
    获取指定工程的所有用户自定义文件夹
    """
    try:
        db_manager = get_db_manager()

        # 检查工程是否存在
        project = db_manager.get_project(project_id)
        if not project:
            raise HTTPException(status_code=404, detail="工程不存在")

        folders = db_manager.get_user_folders(project_id)

        # 获取每个文件夹下的导入文件夹数量
        for folder in folders:
            mappings = db_manager.get_imported_folder_mappings(project_id, folder['id'])
            folder['imported_folder_count'] = len(mappings)
            folder['total_file_count'] = sum(m['file_count'] for m in mappings)

        return {
            "project_id": project_id,
            "total": len(folders),
            "folders": folders
        }
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"获取用户文件夹失败: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/api/v1/projects/{project_id}/folders")
async def create_user_folder(project_id: str, request: CreateFolderRequest):
    """
    创建用户自定义文件夹
    """
    try:
        async with _get_project_index_lock(project_id):
            db_manager = get_db_manager()
            if project_id in _projects_deleting:
                raise HTTPException(status_code=409, detail="工程正在删除")
            if not db_manager.get_project(project_id):
                raise HTTPException(status_code=404, detail="工程不存在")

            import uuid
            folder_id = f"folder_{uuid.uuid4().hex[:8]}"
            sort_order = len(db_manager.get_user_folders(project_id))
            success = db_manager.create_user_folder(
                folder_id=folder_id,
                project_id=project_id,
                name=request.name,
                description=request.description,
                color=request.color,
                sort_order=sort_order
            )
            if not success:
                raise HTTPException(status_code=400, detail="创建文件夹失败")
            return {
                "success": True,
                "folder_id": folder_id,
                "name": request.name,
                "message": f"文件夹 '{request.name}' 创建成功"
            }
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"创建用户文件夹失败: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.put("/api/v1/projects/{project_id}/folders/{folder_id}")
async def update_user_folder(
    project_id: str,
    folder_id: str,
    request: UpdateFolderRequest,
    background_tasks: BackgroundTasks,
):
    """
    更新用户自定义文件夹
    """
    try:
        async with _get_project_index_lock(project_id):
            db_manager = get_db_manager()
            if project_id in _projects_deleting:
                raise HTTPException(status_code=409, detail="工程正在删除")
            folder = db_manager.get_user_folder(folder_id)
            if not folder or folder['project_id'] != project_id:
                raise HTTPException(status_code=404, detail="文件夹不存在")
            affected_paths = [
                mapping["folder_path"]
                for mapping in db_manager.get_imported_folder_mappings(
                    project_id, folder_id
                )
            ]
            success = db_manager.update_user_folder(
                folder_id=folder_id,
                name=request.name,
                description=request.description,
                color=request.color,
                sort_order=request.sort_order
            )
            if not success:
                raise HTTPException(status_code=400, detail="更新文件夹失败")
            invalidation = (
                _invalidate_text_metadata_for_paths_locked(
                    project_id, affected_paths, background_tasks
                )
                if request.name is not None or request.description is not None
                else {"affected_files": 0, "reindex_job_id": None}
            )
            return {
                "success": True,
                "message": "文件夹更新成功",
                **invalidation,
            }
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"更新用户文件夹失败: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/api/v1/projects/{project_id}/folders/{folder_id}/files")
async def add_files_to_user_folder(project_id: str, folder_id: str, payload: Dict[str, Any]):
    """把选中的音效（按路径）加入某个用户文件夹。"""
    paths = payload.get("paths") or []
    if not isinstance(paths, list) or not paths:
        raise HTTPException(status_code=422, detail="paths 不能为空")
    db_manager = get_db_manager()
    added = db_manager.add_files_to_user_folder(project_id, folder_id, [str(p) for p in paths])
    return {"success": True, "added": added, "total": len(paths)}


@app.get("/api/v1/projects/{project_id}/folders/{folder_id}/files")
async def list_files_in_user_folder(project_id: str, folder_id: str):
    db_manager = get_db_manager()
    files = db_manager.list_files_in_user_folder(project_id, folder_id)
    return {"success": True, "files": files, "total": len(files)}


@app.delete("/api/v1/projects/{project_id}/folders/{folder_id}/files/{file_uuid}")
async def remove_file_from_user_folder(project_id: str, folder_id: str, file_uuid: str):
    db_manager = get_db_manager()
    removed = db_manager.remove_file_from_user_folder(project_id, folder_id, file_uuid)
    return {"success": removed}


@app.delete("/api/v1/projects/{project_id}/folders/{folder_id}")
async def delete_user_folder(
    project_id: str,
    folder_id: str,
    background_tasks: BackgroundTasks,
):
    """
    删除用户自定义文件夹

    删除后，该文件夹下的导入文件夹将变为未分类状态
    """
    try:
        async with _get_project_index_lock(project_id):
            db_manager = get_db_manager()
            if project_id in _projects_deleting:
                raise HTTPException(status_code=409, detail="工程正在删除")
            folder = db_manager.get_user_folder(folder_id)
            if not folder or folder['project_id'] != project_id:
                raise HTTPException(status_code=404, detail="文件夹不存在")
            affected_paths = [
                mapping["folder_path"]
                for mapping in db_manager.get_imported_folder_mappings(
                    project_id, folder_id
                )
            ]
            if not db_manager.delete_user_folder(folder_id):
                raise HTTPException(status_code=400, detail="删除文件夹失败")
            invalidation = _invalidate_text_metadata_for_paths_locked(
                project_id, affected_paths, background_tasks
            )
            return {
                "success": True,
                "message": f"文件夹 '{folder['name']}' 已删除",
                **invalidation,
            }
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"删除用户文件夹失败: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/api/v1/projects/{project_id}/folder-mappings")
async def get_imported_folder_mappings(project_id: str, user_folder_id: Optional[str] = None):
    """
    获取导入文件夹的映射关系
    """
    try:
        db_manager = get_db_manager()

        # 检查工程是否存在
        project = db_manager.get_project(project_id)
        if not project:
            raise HTTPException(status_code=404, detail="工程不存在")

        mappings = db_manager.get_imported_folder_mappings(project_id, user_folder_id)

        return {
            "project_id": project_id,
            "total": len(mappings),
            "mappings": mappings
        }
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"获取导入文件夹映射失败: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/api/v1/projects/{project_id}/folder-mappings/{folder_path:path}")
async def update_folder_mapping(
    project_id: str,
    folder_path: str,
    background_tasks: BackgroundTasks,
    user_folder_id: Optional[str] = None,
):
    """
    更新导入文件夹的用户文件夹关联

    - **user_folder_id**: 用户文件夹ID，为空表示取消关联（变为未分类）
    """
    try:
        async with _get_project_index_lock(project_id):
            db_manager = get_db_manager()
            if project_id in _projects_deleting:
                raise HTTPException(status_code=409, detail="工程正在删除")
            if not db_manager.get_project(project_id):
                raise HTTPException(status_code=404, detail="工程不存在")
            if user_folder_id:
                target_folder = db_manager.get_user_folder(user_folder_id)
                if not target_folder or target_folder["project_id"] != project_id:
                    raise HTTPException(status_code=404, detail="目标文件夹不存在")
            mapping = _find_mapping_by_path(
                db_manager.get_imported_folder_mappings(project_id), folder_path
            )
            if not mapping:
                raise HTTPException(status_code=404, detail="导入文件夹映射不存在")
            stored_path = str(mapping["folder_path"])
            if not db_manager.update_imported_folder_mapping(
                project_id, stored_path, user_folder_id
            ):
                raise HTTPException(status_code=400, detail="更新文件夹映射失败")
            changed = (mapping.get("user_folder_id") or None) != (user_folder_id or None)
            invalidation = (
                _invalidate_text_metadata_for_paths_locked(
                    project_id, [stored_path], background_tasks
                )
                if changed
                else {"affected_files": 0, "reindex_job_id": None}
            )
            return {
                "success": True,
                "message": "文件夹分类已更新",
                **invalidation,
            }
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"更新文件夹映射失败: {e}")
        raise HTTPException(status_code=500, detail="更新文件夹映射失败，请检查日志")


# ==================== AI Chat API ====================

@app.post("/api/v1/ai/chat")
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


def _text_embedding_config_signature(provider: str, provider_config: Dict[str, Any]) -> str:
    """Fingerprint only settings that can change persisted text vectors."""
    import hashlib

    relevant = {
        "provider": provider,
        "type": provider_config.get("type"),
        "base_url": str(provider_config.get("base_url", "")).rstrip("/"),
        "model": provider_config.get("model"),
        "model_name": provider_config.get("model_name"),
        "dimension": provider_config.get("dimension"),
        "revision": provider_config.get("revision"),
        "preprocessing_version": provider_config.get("preprocessing_version"),
    }
    encoded = json.dumps(relevant, ensure_ascii=True, sort_keys=True).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


@app.get("/api/v1/ai/config")
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


@app.post("/api/v1/ai/config")
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


@app.post("/api/v1/ai/config/test")
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


@app.get("/api/v1/ai/status")
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


# ==================== 主入口 ====================

if __name__ == "__main__":
    # PyInstaller 打包后的 Windows 多进程支持
    import sys
    import socket
    import multiprocessing
    multiprocessing.freeze_support()

    # 冻结环境里 melworker.py 不再是磁盘上的独立脚本，
    # 由本 exe 用 --mel-worker 参数复用自身充当 worker 子进程。
    if "--mel-worker" in sys.argv:
        from core.melworker import _main as _run_mel_worker
        _run_mel_worker()
        raise SystemExit(0)

    # 自动寻找可用端口（避免端口冲突）
    _port = config.PORT
    for _attempt in range(20):
        try:
            with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as _s:
                _s.bind((config.HOST, _port))
                break
        except OSError:
            _port += 1
    else:
        print(f"[FATAL] No free port found in range {config.PORT}–{config.PORT + 19}", flush=True)
        sys.exit(1)

    if _port != config.PORT:
        print(f"[SoundBot] Port {config.PORT} busy, using port {_port}", flush=True)
    print(f"[SoundBot] BOUND_PORT={_port}", flush=True)

    # 必须传 app 对象而非字符串 "main:app"
    # 字符串形式会让 uvicorn 尝试 importlib.import_module("main")，
    # 在 PyInstaller 冻结环境中会失败：Could not import module "main"
    uvicorn.run(
        app,
        host=config.HOST,
        port=_port,
        log_level="info"
    )
