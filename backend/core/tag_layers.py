# -*- coding: utf-8 -*-
"""M4 标签双层：scene（场景，互斥） / attr（属性，可多选）。

现有标签都存在 files.tags 的 JSON 数组里，这里做两件事：
1. 建 tags / file_tags 两张表
2. 首次启动时把 files.tags 迁移成 tag 记录（默认层 attr），之后可提升为 scene
"""
from __future__ import annotations

import json
import logging
import sqlite3
import uuid
from datetime import datetime
from typing import Any, Dict, List, Optional

logger = logging.getLogger(__name__)

LAYER_SCENE = "scene"
LAYER_ATTR = "attr"
VALID_LAYERS = (LAYER_SCENE, LAYER_ATTR)


def ensure_schema(cursor: sqlite3.Cursor) -> None:
    cursor.execute(
        "CREATE TABLE IF NOT EXISTS app_meta (key TEXT PRIMARY KEY, value TEXT)"
    )
    cursor.execute(
        """
        CREATE TABLE IF NOT EXISTS tags (
            id TEXT PRIMARY KEY,
            project_id TEXT NOT NULL DEFAULT 'default',
            name TEXT NOT NULL,
            layer TEXT NOT NULL DEFAULT 'attr',
            color TEXT,
            sort_order INTEGER DEFAULT 0,
            created_at TEXT
        )
        """
    )
    cursor.execute(
        "CREATE UNIQUE INDEX IF NOT EXISTS idx_tags_name ON tags(project_id, name)"
    )
    cursor.execute(
        """
        CREATE TABLE IF NOT EXISTS file_tags (
            project_id TEXT NOT NULL,
            file_uuid TEXT NOT NULL,
            tag_id TEXT NOT NULL,
            created_at TEXT,
            PRIMARY KEY (project_id, file_uuid, tag_id)
        )
        """
    )
    cursor.execute(
        "CREATE INDEX IF NOT EXISTS idx_file_tags_tag ON file_tags(project_id, tag_id)"
    )


def migrate_from_files(cursor: sqlite3.Cursor, project_id: str = "default") -> int:
    """把 files.tags 的 JSON 数组迁移到 tags + file_tags，返回迁移的关联数。"""
    rows = cursor.execute(
        "SELECT file_uuid, tags FROM files WHERE project_id=? AND tags IS NOT NULL AND tags != '[]'",
        (project_id,),
    ).fetchall()
    if not rows:
        return 0

    existing = {
        name: tag_id
        for tag_id, name in cursor.execute(
            "SELECT id, name FROM tags WHERE project_id=?", (project_id,)
        ).fetchall()
    }
    linked = 0
    now = datetime.now().isoformat()
    for file_uuid, raw in rows:
        try:
            names = json.loads(raw) if isinstance(raw, str) else (raw or [])
        except Exception:
            continue
        if not isinstance(names, list):
            continue
        for name in names:
            name = str(name).strip()
            if not name:
                continue
            tag_id = existing.get(name)
            if not tag_id:
                tag_id = "tag_" + uuid.uuid4().hex[:10]
                cursor.execute(
                    "INSERT OR IGNORE INTO tags (id, project_id, name, layer, sort_order, created_at) "
                    "VALUES (?,?,?,?,?,?)",
                    (tag_id, project_id, name, LAYER_ATTR, 0, now),
                )
                existing[name] = tag_id
            cursor.execute(
                "INSERT OR IGNORE INTO file_tags (project_id, file_uuid, tag_id, created_at) "
                "VALUES (?,?,?,?)",
                (project_id, file_uuid, tag_id, now),
            )
            linked += 1
    return linked


def list_tags(cursor: sqlite3.Cursor, project_id: str = "default") -> List[Dict[str, Any]]:
    rows = cursor.execute(
        """
        SELECT t.id, t.name, t.layer, t.color, t.sort_order, COUNT(ft.file_uuid)
        FROM tags t
        LEFT JOIN file_tags ft ON ft.tag_id = t.id AND ft.project_id = t.project_id
        WHERE t.project_id=?
        GROUP BY t.id
        ORDER BY t.layer DESC, t.sort_order, COUNT(ft.file_uuid) DESC
        """,
        (project_id,),
    ).fetchall()
    return [
        {
            "id": r[0],
            "name": r[1],
            "layer": r[2],
            "color": r[3],
            "sort_order": r[4],
            "count": r[5],
        }
        for r in rows
    ]


def set_layer(cursor: sqlite3.Cursor, project_id: str, tag_id: str, layer: str) -> bool:
    if layer not in VALID_LAYERS:
        return False
    cursor.execute(
        "UPDATE tags SET layer=? WHERE id=? AND project_id=?", (layer, tag_id, project_id)
    )
    return cursor.rowcount > 0


def rename_tag(cursor: sqlite3.Cursor, project_id: str, tag_id: str, name: str) -> bool:
    name = str(name or "").strip()
    if not name:
        return False
    try:
        cursor.execute(
            "UPDATE tags SET name=? WHERE id=? AND project_id=?", (name, tag_id, project_id)
        )
    except sqlite3.IntegrityError:
        return False
    return cursor.rowcount > 0


def delete_tag(cursor: sqlite3.Cursor, project_id: str, tag_id: str) -> bool:
    cursor.execute(
        "DELETE FROM file_tags WHERE project_id=? AND tag_id=?", (project_id, tag_id)
    )
    cursor.execute("DELETE FROM tags WHERE id=? AND project_id=?", (tag_id, project_id))
    return cursor.rowcount > 0


def file_tag_ids(cursor: sqlite3.Cursor, project_id: str, file_uuid: str) -> List[str]:
    return [
        r[0]
        for r in cursor.execute(
            "SELECT tag_id FROM file_tags WHERE project_id=? AND file_uuid=?",
            (project_id, file_uuid),
        ).fetchall()
    ]


def file_tag_names(cursor: sqlite3.Cursor, project_id: str, file_uuid: str) -> List[str]:
    """某个文件挂的「我的标签」名字列表。"""
    return [
        r[0]
        for r in cursor.execute(
            "SELECT t.name FROM file_tags ft "
            "JOIN tags t ON t.id = ft.tag_id AND t.project_id = ft.project_id "
            "WHERE ft.project_id=? AND ft.file_uuid=? "
            "ORDER BY t.name",
            (project_id, file_uuid),
        ).fetchall()
        if r[0]
    ]


def set_file_tags(
    cursor: sqlite3.Cursor, project_id: str, file_uuid: str, tag_ids: List[str]
) -> None:
    """设置某文件的标签；scene 层最多一个（约束）。"""
    scene_ids = set(
        r[0]
        for r in cursor.execute(
            "SELECT id FROM tags WHERE project_id=? AND layer='scene'", (project_id,)
        ).fetchall()
    )
    chosen = [t for t in tag_ids if t]
    scenes = [t for t in chosen if t in scene_ids]
    if len(scenes) > 1:
        raise ValueError("场景标签只能有一个")
    now = datetime.now().isoformat()
    cursor.execute(
        "DELETE FROM file_tags WHERE project_id=? AND file_uuid=?", (project_id, file_uuid)
    )
    for tag_id in chosen:
        cursor.execute(
            "INSERT OR IGNORE INTO file_tags (project_id, file_uuid, tag_id, created_at) "
            "VALUES (?,?,?,?)",
            (project_id, file_uuid, tag_id, now),
        )
