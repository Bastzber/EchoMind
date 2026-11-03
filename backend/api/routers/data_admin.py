# -*- coding: utf-8 -*-
r"""本地数据管理：查看占用、清除全部数据（恢复出厂）。

为什么要有这个：EchoMind 是 Electron 应用，用户数据放 %APPDATA%\EchoMind，
卸载程序只删安装目录，AppData 保留 —— 用户卸载重装后旧工程/标签/音色还在，
以为「没卸干净」（11-03 用户报告）。给一个显式的清理入口，就不用猜了。

分成四类，可以只清缓存不清工程：
  db        soundmind.db（工程/标签/描述/索引状态，3 GB 级）
  chroma    chroma_projects（向量库）
  voice     voice_profiles（克隆音色）
  cache     tts_cache / panel-audio / generated（可再生的缓存）
"""
from __future__ import annotations

import logging
import os
import shutil
from pathlib import Path
from typing import Any, Dict, List

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from core.errors import SoundBotAPIError

logger = logging.getLogger(__name__)
router = APIRouter(tags=["data-admin"])


def _user_data_root() -> Path:
    return Path(os.environ.get("APPDATA") or Path.home()) / "EchoMind"


SCOPES: Dict[str, List[str]] = {
    "db": ["db"],
    "chroma": ["chroma_projects"],
    "voice": ["voice_profiles"],
    "cache": ["tts_cache", "cache"],
}

SCOPE_LABELS = {
    "db": "工程与索引数据库",
    "chroma": "向量库",
    "voice": "克隆音色",
    "cache": "缓存（可自动重建）",
}


def _dir_size(path: Path) -> int:
    if not path.exists():
        return 0
    if path.is_file():
        try:
            return path.stat().st_size
        except OSError:
            return 0
    total = 0
    for root, _dirs, files in os.walk(path):
        for name in files:
            try:
                total += (Path(root) / name).stat().st_size
            except OSError:
                continue
    return total


@router.get("/api/v1/data/usage")
async def data_usage():
    """各数据目录的位置和占用，设置页「数据管理」用。"""
    root = _user_data_root()
    items = []
    total = 0
    for scope, names in SCOPES.items():
        size = 0
        paths = []
        for name in names:
            target = root / name
            if target.exists():
                size += _dir_size(target)
                paths.append(str(target))
        total += size
        items.append({
            "scope": scope,
            "label": SCOPE_LABELS.get(scope, scope),
            "paths": paths,
            "bytes": size,
            "exists": bool(paths),
        })
    # generated 目录（AI 生成音效）单独列出来，它不属于可清理缓存
    generated = root / "generated"
    return {
        "success": True,
        "root": str(root),
        "total_bytes": total,
        "items": items,
        "generated_dir": str(generated),
        "generated_bytes": _dir_size(generated),
    }


class ResetRequest(BaseModel):
    """清除本地数据。confirm 必须是 DELETE，防止误触。"""

    scopes: List[str] = Field(default_factory=list)
    confirm: str = ""


@router.post("/api/v1/data/reset")
async def reset_local_data(payload: ResetRequest):
    """删除选中的数据目录。删除后必须重启应用。"""
    if (payload.confirm or "").strip().upper() != "DELETE":
        raise HTTPException(status_code=422, detail="确认词不对，请输入 DELETE")
    scopes = [s for s in (payload.scopes or []) if s in SCOPES]
    if not scopes:
        raise HTTPException(status_code=422, detail="没有选择要清除的数据")
    # 工程库和向量库必须一起清：只删一个会留下孤儿向量或空库引用
    if ("db" in scopes) != ("chroma" in scopes):
        raise SoundBotAPIError(
            "reset_scope_mismatch",
            "工程库和向量库必须一起清除，否则索引会不一致",
            status_code=409,
        )

    root = _user_data_root()
    removed: List[str] = []
    failed: List[Dict[str, str]] = []
    for scope in scopes:
        for name in SCOPES[scope]:
            target = root / name
            if not target.exists():
                continue
            try:
                if target.is_dir():
                    shutil.rmtree(target)
                else:
                    target.unlink()
                removed.append(str(target))
            except Exception as exc:
                logger.warning("清除 %s 失败: %s", target, exc)
                failed.append({"path": str(target), "error": str(exc)})

    logger.info("[DataAdmin] 清除本地数据: %s", removed)
    return {
        "success": not failed,
        "removed": removed,
        "failed": failed,
        "need_restart": True,
        "message": "已清除，请重启应用" if not failed else "部分目录没删掉，看 failed",
    }
