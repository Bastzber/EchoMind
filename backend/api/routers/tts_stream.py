# -*- coding: utf-8 -*-
"""长文本转语音接口：起任务 / 查进度 / 取消 / 列输出目录。

前端不需要跟 Breeze 的 chunked 响应纠缠，只要 POST 一个字，然后 1 秒轮询一次进度。
"""
from __future__ import annotations

import logging
import os
import shutil
from pathlib import Path
from typing import Any, Dict, Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from core import tts, tts_long
from core.errors import SoundBotAPIError

logger = logging.getLogger(__name__)
router = APIRouter(tags=["tts-long"])


class LongTTSRequest(BaseModel):
    text: str = Field(default="", description="要念的整段文字")
    voice_id: str = Field(default="", description="Breeze 已保存音色 id，空则用 voice design")
    instruction: str = Field(default="", description="音色/情绪描述")
    out_dir: str = Field(default="", description="输出文件夹，空则落到 generated\\YYYYMMDD")
    filename: str = Field(default="", description="文件名，不带扩展也行")
    split_chars: int = Field(default=0, description="每段字数，0 用默认 150")


@router.get("/api/v1/tts/long/defaults")
async def long_tts_defaults():
    """前端弹窗打开时读一次：默认目录、可用音色、默认切分粒度。"""
    try:
        voices = tts.list_saved_voices()
    except Exception as exc:
        logger.debug("读取音色列表失败: %s", exc)
        voices = []
    return {
        "success": True,
        "default_dir": str(tts_long.default_out_dir()),
        "voices": voices,
        "split_chars": tts.SPLIT_CHARS,
        "available": tts.breeze_available(),
    }


@router.post("/api/v1/tts/long")
async def start_long_tts(payload: LongTTSRequest):
    """起一个长文本生成任务。立刻返回 job_id，不等音频。"""
    text = (payload.text or "").strip()
    if not text:
        raise HTTPException(status_code=422, detail="文本不能为空")
    if not tts.breeze_available():
        raise SoundBotAPIError(
            "breeze_unavailable",
            "本地语音服务没启动，先确认 breeze-server 在跑（127.0.0.1:8080）",
            status_code=503,
        )

    voice_id = (payload.voice_id or "").strip() or None
    instruction = (payload.instruction or "").strip() or None
    split = int(payload.split_chars or 0) or tts.SPLIT_CHARS
    split = max(40, min(600, split))

    # 复用 breeze_speak 的请求构造，保证 split_chars / voice_id 的行为和短句一致
    fields: Dict[str, str] = {"text": text}
    files: Dict[str, Any] = {}
    if voice_id:
        fields["voice_id"] = voice_id
    if instruction:
        fields["instruction"] = instruction
    fields["split_chars"] = str(split)
    body, headers = tts._multipart(fields, files)
    parts = {"url": tts.breeze_url() + "/v1/audio/speech", "body": body, "headers": headers}

    try:
        job = tts_long.start_long_tts(
            text=text,
            breeze_parts=parts,
            out_dir=(payload.out_dir or "").strip() or None,
            filename=(payload.filename or "").strip() or None,
            split_chars=split,
        )
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc))
    return {"success": True, "job": job}


@router.get("/api/v1/tts/long/{job_id}")
async def long_tts_status(job_id: str):
    """查进度。前端 1 秒轮询一次。"""
    job = tts_long.get_job(job_id)
    if not job:
        raise SoundBotAPIError("job_not_found", "任务不存在（可能已过期）", status_code=404)
    # 状态是 done 时补上时长展示要用的信息
    job.pop("cancel_requested", None)
    return {"success": True, "job": job}


@router.post("/api/v1/tts/long/{job_id}/cancel")
async def long_tts_cancel(job_id: str):
    """取消。已生成的部分留在磁盘上，不删。"""
    ok = tts_long.cancel_job(job_id)
    if not ok:
        raise SoundBotAPIError("job_not_cancellable", "任务已结束或不存在", status_code=409)
    return {"success": True, "message": "已请求停止"}


@router.get("/api/v1/tts/long/dir/check")
async def check_out_dir(path: str = ""):
    """前端选完文件夹先校验一下能不能写，省得等六分钟才报错。"""
    if not path.strip():
        return {"success": True, "usable": False, "reason": "没有指定目录"}
    folder = Path(path).expanduser()
    if not folder.is_dir():
        return {"success": True, "usable": False, "reason": "目录不存在"}
    probe = folder / (".echomind-write-test-%d" % os.getpid())
    try:
        probe.write_text("ok", encoding="utf-8")
        probe.unlink()
    except Exception as exc:
        return {"success": True, "usable": False, "reason": "没有写入权限：%s" % exc}
    try:
        # os.statvfs 是 POSIX 专用，Windows 上必须用 shutil.disk_usage
        free = shutil.disk_usage(str(folder)).free
    except Exception:
        free = None
    return {"success": True, "usable": True, "free_bytes": free}
