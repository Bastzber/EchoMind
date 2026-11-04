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
    """前端打开长音频页时读一次：默认目录、音色（带人类可读名）、切分粒度。"""
    try:
        saved = tts.list_saved_voices()
    except Exception as exc:
        logger.debug("读取音色列表失败: %s", exc)
        saved = []

    # Breeze 里的 voice id 是 echomind-<profile.id>，直接给前端只能看到一串十六进制。
    # 这里用 profile 反查回用户起的名字，长音频下拉才和短音频克隆那边一致。
    voices = []
    matched = set()
    try:
        from core.voice_clone import load_profiles

        for profile in load_profiles():
            ident = "".join(
                ch for ch in str(profile.get("id") or "")
                if ch.isascii() and ch.isalnum()
            )[:12]
            if not ident:
                continue
            voice_id = "echomind-" + ident
            name = str(profile.get("name") or voice_id)
            # 以前这里要求 voice_id 已经在 Breeze 里注册过才列出来，结果
            # Breeze 没启动、或者重启后丢了内存里的音色，下拉就是空的（11-04 反馈）。
            # 改成档案里的音色全部列出来，没注册的标记 registered=False，
            # 真正要用的时候（start_long_tts）再按需注册。
            voices.append({
                "id": voice_id,
                "name": name,
                "registered": voice_id in saved,
                "profile_id": str(profile.get("id") or ""),
            })
            matched.add(voice_id)
    except Exception as exc:
        logger.debug("读取音色档案失败: %s", exc)

    # Breeze 里还有没对上档案的音色。echomind-assistant 是助理播报用的固定音色，
    # 给它一个人话名字；其余实在认不出来的，至少把 echomind- 前缀去掉再显示。
    for voice_id in saved:
        if voice_id in matched:
            continue
        if voice_id == "echomind-assistant":
            voices.append({"id": voice_id, "name": "助理音色（默认）"})
            continue
        label = voice_id[len("echomind-"):] if voice_id.startswith("echomind-") else voice_id
        voices.append({"id": voice_id, "name": label})
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

    # 选中的音色如果还没在 Breeze 里注册（比如 Breeze 重启后内存缓存丢了），
    # 这里先按需注册一次，不然生成时会 404 unknown voice_id。
    if voice_id:
        try:
            known = tts.list_saved_voices()
        except Exception:
            known = []
        if voice_id not in known:
            try:
                from core.voice_clone import load_profiles

                target = None
                for profile in load_profiles():
                    ident = "".join(
                        ch for ch in str(profile.get("id") or "")
                        if ch.isascii() and ch.isalnum()
                    )[:12]
                    if ident and ("echomind-" + ident) == voice_id:
                        target = profile
                        break
                if target is not None:
                    registered = tts.register_saved_voice(target, voice_id)
                    if registered:
                        voice_id = registered
                        logger.info("[TTS-Long] 已按需注册音色 %s", voice_id)
            except Exception as exc:
                logger.warning("[TTS-Long] 按需注册音色失败: %s", exc)
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
