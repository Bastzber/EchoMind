# -*- coding: utf-8 -*-
"""导入完成后的后台补时长：只读头，能读多少读多少。

导入时为了快，大库只登记不打开音频（duration=0）。这个任务在后台把时长补上：
  - WAV / FLAC：自己解析头（0.1~8ms/文件，误差 <0.1%）
  - MP3 / 其它：PyAV（41ms/文件，准确）
6.5 万条约 3 分钟跑完，全程不阻塞界面。波形是另一个任务，这里不算。
"""
from __future__ import annotations

import logging
from concurrent.futures import ThreadPoolExecutor
from typing import Any, Callable, Dict, List, Optional, Tuple

logger = logging.getLogger(__name__)

BATCH = 400
WORKERS = 8


def _probe_one(path: str) -> Optional[Tuple[float, int, int]]:
    """先快速头解析，失败再用 PyAV。返回 (duration, rate, channels)。"""
    from core.fast_probe import probe_header

    got = probe_header(path)
    if got and got.get("duration"):
        return (float(got["duration"]), int(got.get("sample_rate") or 0), int(got.get("channels") or 0))
    try:
        from core.audio_service import get_audio_service

        info = get_audio_service().probe(path)
        if float(info.duration or 0) > 0:
            return (float(info.duration), int(info.sample_rate or 0), int(info.channels or 0))
    except Exception:
        return None
    return None


def backfill(
    db_manager: Any,
    project_id: str,
    progress: Optional[Callable[[str, int, int], None]] = None,
    cancelled: Optional[Callable[[], bool]] = None,
) -> Dict[str, Any]:
    """把 duration<=0 的文件补上时长，返回统计。"""
    with db_manager.get_cursor() as cursor:
        rows: List[Tuple[str, str]] = [
            (str(r[0]), str(r[1]))
            for r in cursor.execute(
                "SELECT file_uuid, path FROM files WHERE project_id=? "
                "AND (duration IS NULL OR duration <= 0) AND path IS NOT NULL AND path != ''",
                (str(project_id),),
            ).fetchall()
        ]
    total = len(rows)
    if not total:
        return {"total": 0, "updated": 0, "failed": 0}

    logger.info("[Duration] 开始补时长：%d 条", total)
    updated = failed = 0
    for start in range(0, total, BATCH):
        if cancelled and cancelled():
            break
        chunk = rows[start:start + BATCH]
        results: List[Tuple[float, int, int, str]] = []
        with ThreadPoolExecutor(max_workers=WORKERS) as pool:
            for (uuid, path), got in zip(chunk, pool.map(_probe_one, [p for _u, p in chunk])):
                if got:
                    results.append((got[0], got[1], got[2], uuid))
        if results:
            try:
                with db_manager.get_cursor() as cursor:
                    cursor.executemany(
                        "UPDATE files SET duration=?, sample_rate=?, channels=? "
                        "WHERE file_uuid=? AND (duration IS NULL OR duration<=0)",
                        results,
                    )
                updated += len(results)
            except Exception as exc:
                logger.warning("[Duration] 写库失败: %s", exc)
        failed += len(chunk) - len(results)
        if progress:
            try:
                progress("duration", min(start + BATCH, total), total)
            except Exception:
                pass

    logger.info("[Duration] 补时长完成：成功 %d，失败 %d", updated, failed)
    return {"total": total, "updated": updated, "failed": failed}
