#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""按 files.tags 批量重建 tags / file_tags（一次性修复 + 迁移后同步）。"""
from __future__ import annotations

import json
import os
import sqlite3
import sys
import time
import uuid
from datetime import datetime
from pathlib import Path

REPO = Path(r'E:\音效库管理软件\EchoMind\EchoMind-main')
DB = Path(os.environ['APPDATA']) / 'EchoMind' / 'db' / 'soundmind.db'
LOG = Path(r'E:\AI音效管理器\tag-sync.log')


def log(message: str) -> None:
    line = time.strftime('%H:%M:%S') + '  ' + message
    print(line, flush=True)
    with LOG.open('a', encoding='utf-8') as handle:
        handle.write(line + '\n')


def main() -> int:
    project_id = 'default'
    conn = sqlite3.connect(str(DB), timeout=300)
    conn.execute('PRAGMA busy_timeout = 300000')
    cursor = conn.cursor()

    rows = cursor.execute(
        "SELECT file_uuid, tags FROM files WHERE project_id=? AND tags IS NOT NULL AND tags NOT IN ('', '[]')",
        (project_id,),
    ).fetchall()
    log('有标签的文件: %d' % len(rows))

    # 1) 收集所有标签名
    per_file = []
    names = set()
    for file_uuid, raw in rows:
        try:
            items = json.loads(raw or '[]')
        except (TypeError, ValueError):
            continue
        cleaned = [str(t).strip() for t in items if str(t).strip()]
        if cleaned:
            per_file.append((file_uuid, cleaned))
            names.update(cleaned)
    log('不同标签: %d' % len(names))

    # 2) 补建缺失的标签行
    existing = {
        name: tag_id
        for tag_id, name in cursor.execute(
            "SELECT id, name FROM tags WHERE project_id=?", (project_id,)
        ).fetchall()
    }
    created = 0
    now = datetime.now().isoformat()
    for name in sorted(names - set(existing.keys())):
        tag_id = 'tag_' + uuid.uuid4().hex[:10]
        cursor.execute(
            "INSERT OR IGNORE INTO tags (id, project_id, name, layer, sort_order, created_at) VALUES (?,?,?,?,?,?)",
            (tag_id, project_id, name, 'attr', 0, now),
        )
        existing[name] = tag_id
        created += 1
    conn.commit()
    log('新建标签: %d（总计 %d）' % (created, len(existing)))

    # 3) 重建 file_tags
    cursor.execute("DELETE FROM file_tags WHERE project_id=?", (project_id,))
    conn.commit()
    batch = []
    total = 0
    for file_uuid, cleaned in per_file:
        for name in cleaned:
            tag_id = existing.get(name)
            if tag_id:
                batch.append((project_id, file_uuid, tag_id, now))
        if len(batch) >= 5000:
            cursor.executemany(
                "INSERT OR IGNORE INTO file_tags (project_id, file_uuid, tag_id, created_at) VALUES (?,?,?,?)",
                batch,
            )
            conn.commit()
            total += len(batch)
            batch.clear()
    if batch:
        cursor.executemany(
            "INSERT OR IGNORE INTO file_tags (project_id, file_uuid, tag_id, created_at) VALUES (?,?,?,?)",
            batch,
        )
        conn.commit()
        total += len(batch)
    log('重建关联: %d 条' % total)

    print('最终 tags:', cursor.execute('SELECT COUNT(*) FROM tags').fetchone()[0])
    print('最终 file_tags:', cursor.execute('SELECT COUNT(*) FROM file_tags').fetchone()[0])
    conn.close()
    return 0


if __name__ == '__main__':
    sys.exit(main())
