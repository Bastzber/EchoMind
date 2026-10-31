# -*- coding: utf-8 -*-
"""损坏文件的自愈：重新探测 + 把误判的工件退回 pending。

背景（docs/待办清单 F1/F2）：有一批正常 MP3（大 ID3、CBR）PyAV 读不出元数据，
被判成「损坏文件」；面板上的「一键清理」会把记录移出库并写进 excluded_files，
等于让有效音频从库里消失。这里给一条「先重探、能读就留下」的路：

- `probe_ok()`：只做探测，不写库；
- `heal()`：探测成功后把这个文件失败的工件退回 pending，等索引重跑。

注意：`probe()` 内部已经有 MP3 帧头兜底（core/mp3_meta.py），所以「能读」
的判断和导入时用的是同一条路径，不会出现「导入能进、这里说坏」的分裂。
"""
from __future__ import annotations

import logging
from datetime import datetime
from typing import Any, Dict

logger = logging.getLogger(__name__)


def probe_ok(path: str) -> Dict[str, Any]:
    """只探测，不写库。返回 {ok, duration, sample_rate, channels, format} 或 {ok: False, error}。"""
    from core.audio_service import get_audio_service

    try:
        info = get_audio_service().probe(path)
    except Exception as exc:
        return {"ok": False, "error": str(exc)[:200]}
    duration = float(getattr(info, "duration", 0.0) or 0.0)
    if duration <= 0:
        return {"ok": False, "error": "时长读不出来"}
    return {
        "ok": True,
        "duration": round(duration, 3),
        "sample_rate": int(getattr(info, "sample_rate", 0) or 0),
        "channels": int(getattr(info, "channels", 0) or 0),
        "format": str(getattr(info, "format", "") or ""),
    }


def heal(db_manager: Any, project_id: str, path: str) -> Dict[str, Any]:
    """重新探测；读得出来就把失败的工件退回 pending（不删文件、不删记录）。"""
    from core.database import canonicalize_path

    result = probe_ok(path)
    result["healed"] = 0
    if not result.get("ok"):
        return result
    try:
        canonical = canonicalize_path(path)
        with db_manager.get_cursor() as cursor:
            row = cursor.execute(
                "SELECT file_uuid FROM files WHERE canonical_path=? AND project_id=?",
                (canonical, str(project_id)),
            ).fetchone()
            if row:
                result["file_uuid"] = str(row["file_uuid"])
                result["healed"] = cursor.execute(
                    "UPDATE file_artifacts "
                    "SET state='pending', error_code=NULL, error_message=NULL, updated_at=? "
                    "WHERE project_id=? AND file_uuid=? AND state='failed'",
                    (datetime.now().isoformat(), str(project_id), str(row["file_uuid"])),
                ).rowcount
    except Exception as exc:
        logger.warning("[Broken] 重置工件失败 %s: %s", path, exc)
        result["heal_error"] = str(exc)[:200]
    return result
