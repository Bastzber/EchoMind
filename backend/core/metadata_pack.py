# -*- coding: utf-8 -*-
"""描述包匹配：按「内容哈希 → 全路径 → 反向路径树 → 唯一文件名」四级匹配。

路径会随换盘/改名变化，所以不能只看绝对路径。反向路径树（从文件名往上）
能在目录被整体挪动时仍匹配到正确条目，并且只接受唯一命中。
"""
from __future__ import annotations

import importlib.util
import json
import logging
import unicodedata
from typing import Any, Dict, Iterable, List, Optional, Tuple

logger = logging.getLogger(__name__)


def _norm(text: str) -> str:
    return unicodedata.normalize("NFC", str(text or "")).strip()


def _segments(path: str) -> List[str]:
    raw = str(path or "").replace("/", "\\")
    return [s for s in raw.split("\\") if s]


class _Node:
    __slots__ = ("children", "files")

    def __init__(self) -> None:
        self.children: Dict[str, "_Node"] = {}
        self.files: List[str] = []


class Matcher:
    """库内文件的索引，用于把描述包条目映射到 file_uuid。"""

    def __init__(self, rows: Iterable[Dict[str, Any]]) -> None:
        self.by_sha: Dict[str, str] = {}
        self.by_path: Dict[str, str] = {}
        self.by_name: Dict[str, List[str]] = {}
        self.by_parent_name: Dict[Tuple[str, str], List[str]] = {}
        self.root = _Node()
        for row in rows:
            uuid = str(row.get("file_uuid") or "")
            if not uuid:
                continue
            sha = str(row.get("sha256") or "").strip().lower()
            if sha:
                self.by_sha.setdefault(sha, uuid)
            path_key = _norm(row.get("path")).lower()
            if path_key:
                self.by_path.setdefault(path_key, uuid)
            name_key = _norm(row.get("filename")).lower()
            if name_key:
                self.by_name.setdefault(name_key, []).append(uuid)
            all_segments = [_norm(s).lower() for s in _segments(row.get("path"))]
            if len(all_segments) >= 2 and name_key:
                parent_key = (all_segments[-2], name_key)
                self.by_parent_name.setdefault(parent_key, []).append(uuid)
            segments = all_segments[::-1]
            node = self.root
            for segment in segments:
                node = node.children.setdefault(segment, _Node())
            node.files.append(uuid)

    def match(self, rel: str, sha: str = "", filename: str = "") -> Tuple[Optional[str], str]:
        """返回 (file_uuid, 匹配方式)。"""
        sha_key = str(sha or "").strip().lower()
        if sha_key and sha_key in self.by_sha:
            return self.by_sha[sha_key], "sha256"

        rel_key = _norm(rel).lower()
        if rel_key and rel_key in self.by_path:
            return self.by_path[rel_key], "path"

        # 反向路径：用「父目录 + 文件名」唯一命中（换盘/挪库时目录名仍然保留）
        rel_segments = [_norm(s).lower() for s in _segments(rel)]
        if len(rel_segments) >= 2:
            key = (rel_segments[-2], rel_segments[-1])
            candidates = self.by_parent_name.get(key) or []
            if len(candidates) == 1:
                return candidates[0], "reverse_path"

        name_key = _norm(filename).lower()
        if name_key:
            candidates = self.by_name.get(name_key) or []
            if len(candidates) == 1:
                return candidates[0], "filename"
        return None, "unmatched"


def _load_rows(db_manager, project_id: str) -> List[Dict[str, Any]]:
    with db_manager.get_cursor() as cursor:
        columns = {row[1] for row in cursor.execute("PRAGMA table_info(files)").fetchall()}
        sha_expr = "sha256" if "sha256" in columns else "NULL AS sha256"
        rows = cursor.execute(
            f"SELECT file_uuid, path, filename, ai_description, tags, {sha_expr} "
            "FROM files WHERE project_id=?",
            (str(project_id),),
        ).fetchall()
    return [
        {
            "file_uuid": r[0],
            "path": r[1],
            "filename": r[2],
            "ai_description": r[3],
            "tags": r[4],
            "sha256": r[5],
        }
        for r in rows
    ]


def preview(project_id: str, items: List[Dict[str, Any]], db_manager=None) -> Dict[str, Any]:
    """只算匹配、不写库。"""
    from core.database import get_db_manager

    db = db_manager or get_db_manager()
    matcher = Matcher(_load_rows(db, project_id))
    matched: List[Dict[str, Any]] = []
    ambiguous = 0
    unmatched = 0
    samples: List[Dict[str, Any]] = []
    for item in items:
        rel = str(item.get("rel") or "")
        uuid, how = matcher.match(rel, item.get("sha256", ""), item.get("filename", ""))
        if uuid:
            matched.append(
                {
                    "file_uuid": uuid,
                    "rel": rel,
                    "how": how,
                    "description": str(item.get("description") or ""),
                    "tags": item.get("tags"),
                }
            )
            if len(samples) < 5:
                samples.append({"rel": rel, "file_uuid": uuid, "how": how})
        elif _norm(item.get("filename")):
            name_key = _norm(item.get("filename")).lower()
            ambiguous += 1 if len(matcher.by_name.get(name_key) or []) > 1 else 0
            unmatched += 0 if len(matcher.by_name.get(name_key) or []) > 1 else 1
        else:
            unmatched += 1
    by_kind: Dict[str, int] = {}
    for entry in matched:
        by_kind[entry["how"]] = by_kind.get(entry["how"], 0) + 1
    return {
        "matched": len(matched),
        "ambiguous": ambiguous,
        "unmatched": unmatched,
        "by_kind": by_kind,
        "samples": samples,
        "pairs": matched,
        "pack": len(items),
    }


def apply(
    project_id: str,
    pairs: List[Dict[str, Any]],
    overwrite: bool = False,
    db_manager=None,
) -> Dict[str, Any]:
    """把匹配结果写库：默认只补空白，overwrite=True 才覆盖。"""
    from core.database import get_db_manager

    db = db_manager or get_db_manager()
    applied = 0
    skipped = 0
    touched: List[str] = []
    for pair in pairs:
        uuid = str(pair.get("file_uuid") or "")
        description = str(pair.get("description") or "").strip()
        if not uuid or not description:
            continue
        with db.get_cursor() as cursor:
            row = cursor.execute(
                "SELECT path, ai_description FROM files WHERE file_uuid=?",
                (uuid,),
            ).fetchone()
            if not row:
                continue
            current = str(row["ai_description"] or "")
            if current and not current.startswith("[auto]") and not overwrite:
                skipped += 1
                continue
            cursor.execute(
                "UPDATE files SET ai_description=? WHERE file_uuid=?",
                (description, uuid),
            )
            cursor.connection.commit()
        db.update_fts_row(project_id, uuid)
        applied += 1
        touched.append(str(row["path"]))
    return {"applied": applied, "skipped": skipped, "touched": len(touched)}
