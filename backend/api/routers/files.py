# -*- coding: utf-8 -*-
"""files 域，从 main.py 拆出（AGENTS.md：新接口别继续堆那个文件）。
"""

import os
import json
import math
import logging
from pathlib import Path
from typing import Optional, List, Dict, Any

from fastapi import APIRouter, BackgroundTasks, HTTPException, Query
from pydantic import BaseModel

import uuid
from datetime import datetime
from core.database import canonicalize_path
import config

from api.routers import _deps as _d

logger = logging.getLogger(__name__)
router = APIRouter(tags=["files"])


def get_db_manager():
    return _d.call("get_db_manager")


def _cfg():
    return _d.attr("config")


async def _deferred_reconcile(*a, **k):
    return await _d.call("_deferred_reconcile", *a, **k)


async def _run_audio_work(*a, **k):
    return await _d.call("_run_audio_work", *a, **k)


async def _waveform_payload(*a, **k):
    return await _d.call("_waveform_payload", *a, **k)


class FileCopyRequest(BaseModel):
    source: str
    destination: str
    overwrite: bool = False


class FileMetaRequest(BaseModel):
    ids: List[str]


@router.post("/api/v1/files/rename")
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
                # canonical_path 必须跟着 path 一起改：它是所有「按路径查」的索引键
                # （保存标签、改描述、再次重命名都靠它）。只改 path 会让这条记录
                # 变成「界面显示新名、按路径查不到」，表现就是报「文件不存在」
                # —— 11-10 实测，批量重命名之后保存标签必现。
                from core.database import canonicalize_path as _canon_path

                cursor.execute(
                    "UPDATE files SET path=?, canonical_path=?, filename=? "
                    "WHERE project_id=? AND file_uuid=?",
                    (new_path, _canon_path(new_path), new_name, project_id, file_uuid),
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


@router.post("/api/v1/files/{file_uuid}/favorite")
async def set_favorite(file_uuid: str, payload: Dict[str, Any], project_id: str = Query(default="default")):
    db_manager = get_db_manager()
    value = bool(payload.get("favorite", True))
    ok = db_manager.set_favorite(project_id, file_uuid, value)
    return {"success": ok, "favorite": value}


@router.post("/api/v1/files/meta")
async def files_meta_endpoint(payload: FileMetaRequest):
    """按 id 批量取描述和标签：搜索结果只有文件名和分数，界面要补这两项。"""
    import json as _json

    ids = [str(item) for item in (payload.ids or []) if item][:500]
    if not ids:
        return {"success": True, "items": []}
    db_manager = get_db_manager()
    placeholders = ",".join("?" for _ in ids)
    with db_manager.get_cursor() as cursor:
        rows = cursor.execute(
            f"SELECT file_uuid, filename, ai_description, tags FROM files WHERE file_uuid IN ({placeholders})",
            tuple(ids),
        ).fetchall()
    items = []
    for row in rows:
        raw_tags = row["tags"]
        try:
            tags = _json.loads(raw_tags) if isinstance(raw_tags, str) else (raw_tags or [])
        except Exception:
            tags = [part for part in str(raw_tags or "").split(",") if part.strip()]
        description = str(row["ai_description"] or "")
        if description.startswith("[auto]"):
            description = description[len("[auto]"):].strip()
        items.append({
            "id": row["file_uuid"],
            "filename": row["filename"],
            "ai_description": description,
            "tags": [str(tag) for tag in (tags or []) if str(tag).strip()],
        })
    return {"success": True, "items": items}


def _library_roots_for_guard() -> list:
    """素材库根目录（路径边界校验用），从索引读，不信请求。"""
    import config as _config

    try:
        project_id = getattr(_config, "CURRENT_PROJECT_ID", "default")
        return get_db_manager().list_library_roots(project_id)
    except Exception:
        return []


@router.post("/api/v1/files/copy")
async def files_copy_endpoint(payload: FileCopyRequest):
    """把文件另存到用户选定的位置（导出 / 另存为）。

    边界规则（11-24 改）：
      source     可以是素材库里的文件，也可以是本程序自己生成的缓存（tts_cache /
                 generated / temp）。以前只认库内，克隆结果在 tts_cache 里就直接被拒。
      destination 不再要求落在素材库内 —— 「另存为」本来就是让用户存到任意目录，
                 位置来自系统保存对话框。这里只挡空路径、相对路径、指向目录、
                 以及没带 overwrite 的覆盖。
    接口要带 X-EchoMind-Token 才能调（见 require_api_token），所以本机别的进程和
    网页进不来。
    """
    import shutil as _shutil

    from core.path_guard import PathOutsideLibrary, resolve_generated_source

    roots = _library_roots_for_guard()
    try:
        src = resolve_generated_source(payload.source, roots, field="source")
    except PathOutsideLibrary as exc:
        raise HTTPException(status_code=403, detail=str(exc))

    raw_dest = str(payload.destination or "").strip()
    if not raw_dest:
        raise HTTPException(status_code=422, detail="destination 不能为空")
    if not os.path.isabs(raw_dest):
        raise HTTPException(status_code=422, detail="destination 必须是绝对路径：%s" % raw_dest)
    dest = os.path.abspath(raw_dest)
    if os.path.isdir(dest):
        raise HTTPException(status_code=400, detail="目标是一个文件夹：%s" % dest)
    if not src.is_file():
        raise HTTPException(status_code=404, detail="源文件不存在")
    try:
        os.makedirs(os.path.dirname(dest) or ".", exist_ok=True)
    except Exception as exc:
        raise HTTPException(status_code=400, detail="目标文件夹建不出来：%s" % exc)
    if os.path.exists(dest) and not payload.overwrite:
        raise HTTPException(status_code=409, detail="目标文件已存在")
    try:
        if os.path.normcase(os.path.abspath(dest)) != os.path.normcase(str(src.resolve())):
            # 先写 .part 再原子改名：中途失败不会留下半截文件冒充成品
            temp = dest + ".part"
            try:
                _shutil.copy2(str(src), temp)
                os.replace(temp, dest)
            finally:
                if os.path.exists(temp):
                    try:
                        os.remove(temp)
                    except Exception:
                        pass
    except Exception as exc:
        raise SoundBotAPIError("copy_failed", f"保存失败：{exc}", status_code=500)
    return {"success": True, "path": dest, "size": os.path.getsize(dest)}


@router.post("/api/v1/files/{file_uuid}/description")
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
    if not db_manager.update_ai_description(path, description, project_id, file_uuid=file_uuid):
        raise HTTPException(status_code=500, detail="写入描述失败")
    # 描述变了，这一行的 text_vector 已经被标脏。关键词搜索（FTS）当场就更新了，
    # 但语义检索用的是向量，得让增量对账把这一条重新算一遍 —— 只跑 stale 的行，
    # 不是全库重建。同一工程并发触发会自动合并成一个任务。
    background_tasks.add_task(_deferred_reconcile, project_id, ["text_vector"], "description")
    return {"success": True, "description": description, "reindex_queued": True}


@router.get("/api/v1/files/{file_uuid}/user-tags")
async def get_file_user_tags(file_uuid: str, project_id: str = Query(default="default")):
    """读取某个文件的「我的标签」（用户自定义，和 6 维系统标签分开）。"""
    from core import tag_layers

    db_manager = get_db_manager()
    with db_manager.get_cursor() as cursor:
        names = tag_layers.file_tag_names(cursor, project_id, file_uuid)
    return {"success": True, "names": names}


@router.post("/api/v1/files/{file_uuid}/tags")
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
                        "INSERT INTO tags (id, project_id, name, layer, created_at, origin) "
                        "VALUES (?,?,?,?,?,?)",
                        (tag_id, project_id, name, "attr", datetime.now().isoformat(), "user"),
                    )
                    resolved.append(tag_id)
                # 用户手打的标签一律标 user，左栏「我的标签」才看得到
                cursor.execute(
                    "UPDATE tags SET origin='user' WHERE project_id=? AND name=? AND origin!='user'",
                    (project_id, name),
                )
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


@router.get("/api/v1/files/{file_id}/waveform")
async def get_file_waveform(file_id: str, project_id: Optional[str] = None):
    effective_project = project_id or getattr(config, 'CURRENT_PROJECT_ID', 'default')
    record = get_db_manager().get_file_by_uuid(file_id, effective_project)
    if not record:
        raise SoundBotAPIError("file_not_found", "文件不存在", status_code=404)
    return await _waveform_payload(record.path, effective_project)


@router.post("/api/v1/files/{file_uuid}/peaks")
async def save_file_peaks(file_uuid: str, payload: Dict[str, Any], project_id: Optional[str] = None):
    """用「真正在播的那个解码器」算出来的波形/时长回写数据库。

    Chromium 能跳过 MP3 中间的坏帧，而 PyAV / miniaudio 会在坏帧处停下，
    于是同一文件会出现「波形 199 秒、实际能播 390 秒」。这个接口让渲染层
    把 Chromium 解出来的 2000 个峰值和真实时长交回后端，波形和播放从此同源。
    """
    import math as _math

    from core.audio_service import get_audio_service

    effective_project = project_id or getattr(config, 'CURRENT_PROJECT_ID', 'default')
    db_manager = get_db_manager()
    record = db_manager.get_file_by_uuid(file_uuid, effective_project)
    if not record:
        raise SoundBotAPIError("file_not_found", "文件不存在", status_code=404)

    raw_peaks = payload.get("peaks") or []
    if not isinstance(raw_peaks, list) or not raw_peaks:
        raise HTTPException(status_code=422, detail="peaks 不能为空")
    peaks = []
    for value in raw_peaks[:2000]:
        try:
            f = float(value)
        except (TypeError, ValueError):
            continue
        if not _math.isfinite(f):
            continue
        peaks.append(min(1.0, max(0.0, f)))
    if len(peaks) < 8:
        raise HTTPException(status_code=422, detail="peaks 点数太少")
    while len(peaks) < 2000:
        peaks.append(peaks[-1])

    duration = float(payload.get("duration") or 0)
    sample_rate = int(payload.get("sample_rate") or 0)
    channels = int(payload.get("channels") or 0)

    fingerprint = await _run_audio_work(get_audio_service().fingerprint, record.path)
    ok = db_manager.update_peaks(
        record.path,
        peaks,
        effective_project,
        source_fingerprint=fingerprint.source_key,
        waveform_fingerprint=fingerprint.key,
        waveform_version=int(fingerprint.waveform_version),
    )
    if not ok:
        raise SoundBotAPIError("peaks_save_failed", "写入波形失败", status_code=500)

    # 时长/采样率也一起纠正（Chromium 解出来的才是能播到的那条）
    try:
        with db_manager.get_cursor() as cursor:
            sets, params = [], []
            if duration > 0:
                sets.append("duration=?")
                params.append(round(duration, 6))
            if sample_rate > 0:
                sets.append("sample_rate=?")
                params.append(sample_rate)
            if channels > 0:
                sets.append("channels=?")
                params.append(channels)
            if sets:
                sets.append("updated_at=?")
                params.append(datetime.now().isoformat())
                params.append(file_uuid)
                params.append(effective_project)
                cursor.execute(
                    "UPDATE files SET " + ", ".join(sets) + " WHERE file_uuid=? AND project_id=?",
                    tuple(params),
                )
            cursor.execute(
                "UPDATE file_artifacts SET state='ready' WHERE project_id=? AND file_uuid=? AND kind='waveform'",
                (effective_project, file_uuid),
            )
    except Exception as exc:
        logger.debug("[Peaks] 回写时长失败: %s", exc)

    return {"success": True, "points": len(peaks), "duration": duration}


@router.get("/api/v1/files/{file_id}/playback-source")
async def get_playback_source(
    file_id: str,
    project_id: Optional[str] = None,
    force_transcode: bool = Query(default=False, description="即使格式本来能播也转成 WAV（时长精确）"),
):
    """Return an original path or a cached PCM WAV for Chromium-incompatible files.

    force_transcode=1：MP3 这类本来能直接播的也转 WAV。用于「浏览器报的时长和真实时长
    对不上」（VBR MP3 常见：204.2 秒的文件报 198 秒），转成 WAV 后时长精确、进度条不再偏。
    """
    from core.audio_service import get_audio_service, AudioServiceError

    effective_project = project_id or getattr(config, 'CURRENT_PROJECT_ID', 'default')
    record = get_db_manager().get_file_by_uuid(file_id, effective_project)
    if not record:
        raise SoundBotAPIError("file_not_found", "文件不存在", status_code=404)
    service = get_audio_service()
    try:
        if force_transcode or service.requires_playback_transcode(record.path):
            if force_transcode:
                # 强制转码通常是因为「播放器报的时长不对」，很可能是旧的缓存 WAV 本身就残了；
                # 先把这份缓存删掉再生成，避免一直复用坏文件。
                try:
                    stale = await _run_audio_work(service.prepare_playback_wav, record.path)
                    if stale and Path(str(stale)).is_file():
                        Path(str(stale)).unlink(missing_ok=True)
                except Exception as exc:
                    logger.debug("[Playback] 清理旧转码缓存失败: %s", exc)
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

from core.errors import SoundBotAPIError
