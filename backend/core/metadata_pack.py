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
    missing_items: List[Dict[str, Any]] = []
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
            candidates = matcher.by_name.get(name_key) or []
            if len(candidates) > 1:
                ambiguous += 1
                reason = "同名多个（%d 个候选）" % len(candidates)
            else:
                unmatched += 1
                reason = "库里没有这个文件"
            missing_items.append({
                "rel": rel,
                "filename": str(item.get("filename") or ""),
                "reason": reason,
                "description": str(item.get("description") or "")[:120],
            })
        else:
            unmatched += 1
            missing_items.append({
                "rel": rel,
                "filename": "",
                "reason": "条目缺少路径和文件名",
                "description": str(item.get("description") or "")[:120],
            })
    by_kind: Dict[str, int] = {}
    for entry in matched:
        by_kind[entry["how"]] = by_kind.get(entry["how"], 0) + 1
    return {
        "matched": len(matched),
        "ambiguous": ambiguous,
        "unmatched": unmatched,
        "by_kind": by_kind,
        "samples": samples,
        "missing": missing_items,
        "pairs": matched,
        "pack": len(items),
    }


def _merge_tags(current_raw: Any, extra: Any) -> str:
    """把包里的标签并进 files.tags（JSON 数组），去重且保留原有顺序。"""
    def _as_list(value: Any) -> List[str]:
        if isinstance(value, (list, tuple)):
            return [str(item).strip() for item in value if str(item).strip()]
        text = str(value or "").strip()
        if not text:
            return []
        if text.startswith("["):
            try:
                loaded = json.loads(text)
                if isinstance(loaded, list):
                    return [str(item).strip() for item in loaded if str(item).strip()]
            except Exception:
                pass
        return [part.strip() for part in text.replace("，", ",").split(",") if part.strip()]

    merged = _as_list(current_raw)
    for item in _as_list(extra):
        if item not in merged:
            merged.append(item)
    return json.dumps(merged, ensure_ascii=False)


def apply(
    project_id: str,
    pairs: List[Dict[str, Any]],
    overwrite: bool = False,
    db_manager=None,
    batch_size: int = 800,
) -> Dict[str, Any]:
    """把匹配结果写库：默认只补空白，overwrite=True 才覆盖。

    按 batch_size 分批提交，FTS 走批量接口。逐条 commit 的老实现实测 64k 条
    apply 要十几分钟，而且期间一直持有写锁，波形更新会报 database is locked。
    """
    from datetime import datetime as _dt

    from core.database import get_db_manager

    db = db_manager or get_db_manager()
    wanted: Dict[str, Dict[str, Any]] = {}
    for pair in pairs:
        uuid = str(pair.get("file_uuid") or "")
        if not uuid:
            continue
        description = str(pair.get("description") or "").strip()
        tags = pair.get("tags")
        if not description and not tags:
            continue
        wanted[uuid] = {
            "description": description,
            "tags": tags,
            "user_tags": pair.get("user_tags"),
        }

    applied = 0
    skipped = 0
    touched: List[str] = []
    # 包里的 user_tags（「我的标签」）单独收集：它写的是 tags/file_tags 双层表，
    # 和 files.tags 那 6 维不是一回事（B9）。
    user_tags: Dict[str, List[str]] = {}
    for uuid, item in wanted.items():
        raw = item.get("user_tags")
        if not raw:
            continue
        names = (
            [str(n).strip() for n in raw if str(n).strip()]
            if isinstance(raw, (list, tuple))
            else [part.strip() for part in str(raw).replace("，", ",").split(",") if part.strip()]
        )
        if names:
            user_tags[uuid] = names
    ids = list(wanted)
    for start in range(0, len(ids), batch_size):
        chunk = ids[start:start + batch_size]
        placeholders = ",".join("?" for _ in chunk)
        updates: List[tuple] = []

        def _write_batch() -> None:
            with db.get_cursor() as cursor:
                rows = cursor.execute(
                    f"SELECT file_uuid, path, ai_description, tags FROM files "
                    f"WHERE file_uuid IN ({placeholders})",
                    chunk,
                ).fetchall()
                for row in rows:
                    item = wanted.get(row["file_uuid"]) or {}
                    current = str(row["ai_description"] or "")
                    description = item.get("description") or ""
                    if description and current and not current.startswith("[auto]") and not overwrite:
                        skipped += 1
                        continue
                    new_desc = description or current
                    new_tags = (
                        _merge_tags(row["tags"], item.get("tags"))
                        if item.get("tags") else (row["tags"] or "[]")
                    )
                    updates.append((new_desc, new_tags, _dt.now().isoformat(), row["file_uuid"]))
                    touched.append(str(row["path"]))
                if updates:
                    cursor.executemany(
                        "UPDATE files SET ai_description=?, tags=?, updated_at=? WHERE file_uuid=?",
                        updates,
                    )
                    cursor.connection.commit()

        try:
            # 撞写锁时退避重试，而不是整批失败（B6）
            from core.db_retry import run_with_retry

            run_with_retry(_write_batch, label="描述包写库")
        except Exception as exc:
            logger.warning("描述包分批写库失败（%d 条）: %s", len(chunk), exc)
            continue
        if updates:
            changed_ids = [item[3] for item in updates]
            db.update_fts_rows(project_id, changed_ids)
            # 只把改过描述的文件标脏，别动整库（改 3 条不该让 6.5 万条重编码）
            try:
                db.mark_artifacts_stale(project_id, "text_vector", changed_ids)
            except Exception as exc:
                logger.debug("标记文本向量失效失败: %s", exc)
            applied += len(updates)

    tag_rows = 0
    if user_tags:
        tag_rows = _attach_user_tags(project_id, user_tags, db)
    return {
        "applied": applied,
        "skipped": skipped,
        "touched": len(touched),
        "user_tags": tag_rows,
    }


def _attach_user_tags(project_id: str, mapping: Dict[str, List[str]], db) -> int:
    """把包里的 user_tags 叠加到 tags/file_tags 双层表，再回写 files.tags。

    只做「加」不覆盖：导入标签包不应该把用户手打的标签冲掉。
    """
    import uuid as _uuid
    from datetime import datetime as _dt

    from core import tag_layers

    added = 0
    now = _dt.now().isoformat()
    id_cache: Dict[str, str] = {}
    touched: List[str] = []
    with db.get_cursor() as cursor:
        for file_uuid, names in mapping.items():
            ids = []
            for name in names:
                key = name.lower()
                tag_id = id_cache.get(key)
                if tag_id is None:
                    row = cursor.execute(
                        "SELECT id FROM tags WHERE project_id=? AND name=?",
                        (project_id, name),
                    ).fetchone()
                    if row:
                        tag_id = str(row[0])
                    else:
                        tag_id = _uuid.uuid4().hex
                        cursor.execute(
                            "INSERT INTO tags (id, project_id, name, layer, created_at) "
                            "VALUES (?,?,?,?,?)",
                            (tag_id, project_id, name, tag_layers.LAYER_ATTR, now),
                        )
                    id_cache[key] = tag_id
                ids.append(tag_id)
            for tag_id in ids:
                cursor.execute(
                    "INSERT OR IGNORE INTO file_tags (project_id, file_uuid, tag_id, created_at) "
                    "VALUES (?,?,?,?)",
                    (project_id, file_uuid, tag_id, now),
                )
                added += 1
            touched.append(file_uuid)
    # 注意：这里**不**调用 sync_tags_from_layers。它会把 file_tags 里的标签名
    # 整个回写进 files.tags，而 files.tags 存的是 6 维听感标签 —— 导一次标签包
    # 就把人家的听感标签冲掉了。只加 file_tags，再刷一次 FTS（_user_tag_text
    # 会把用户标签并进搜索文本），两边各归各的。
    if touched:
        try:
            db.update_fts_rows(project_id, touched)
        except Exception as exc:
            logger.debug("用户标签刷新 FTS 失败: %s", exc)
    return added
