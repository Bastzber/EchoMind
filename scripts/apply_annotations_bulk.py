#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""批量写入大羽标注（34,187 条描述 + 6 标签），逐条更新太慢，这里走批量事务。"""
from __future__ import annotations

import json
import os
import sqlite3
import sys
import time
from datetime import datetime
from pathlib import Path

REPO = Path(r'E:\音效库管理软件\EchoMind\EchoMind-main')
JSON_PATH = Path(r'F:\大羽音效库集合包及安装说明\大羽音效库集合包打标索引V1.0.json')
LOG = Path(r'E:\AI音效管理器\annotate-bulk.log')
DB = Path(os.environ['APPDATA']) / 'EchoMind' / 'db' / 'soundmind.db'


def log(message: str) -> None:
    line = time.strftime('%H:%M:%S') + '  ' + message
    print(line, flush=True)
    with LOG.open('a', encoding='utf-8') as handle:
        handle.write(line + '\n')


def main() -> int:
    data = json.loads(JSON_PATH.read_text(encoding='utf-8'))
    assets = data.get('assets') or []
    log('索引条目: %d' % len(assets))

    conn = sqlite3.connect(str(DB), timeout=300)
    conn.execute('PRAGMA busy_timeout = 300000')
    cursor = conn.cursor()
    rows = cursor.execute(
        "SELECT file_uuid, sha256 FROM files WHERE sha256 IS NOT NULL AND sha256 != ''"
    ).fetchall()
    by_sha = {row[1]: row[0] for row in rows}
    log('库内有哈希: %d' % len(by_sha))

    # 兜底索引：同名 + 同大小（新导入的文件还没算 sha256，靠这个也能对上）
    name_rows = cursor.execute("SELECT file_uuid, filename, file_size FROM files").fetchall()
    by_name_size = {}
    for uuid, filename, size in name_rows:
        by_name_size[(str(filename), int(size or 0))] = uuid
    log('同名同大小索引: %d' % len(by_name_size))

    updates = []
    missing = 0
    now = datetime.now().isoformat()
    for asset in assets:
        sha = (asset.get('sha256') or '').strip()
        file_uuid = by_sha.get(sha)
        if not file_uuid:
            rel = str(asset.get('relativePath') or '').replace('/', '\\')
            filename = rel.split('\\')[-1]
            file_uuid = by_name_size.get((filename, int(asset.get('size') or 0)))
        if not file_uuid:
            missing += 1
            continue
        tags = [str(t).strip() for t in (asset.get('tags') or []) if str(t).strip()]
        updates.append((str(asset.get('description') or '').strip(), json.dumps(tags, ensure_ascii=False), now, file_uuid))
    log('可写入: %d   库里匹配不到: %d' % (len(updates), missing))

    written = 0
    started = time.time()
    for index in range(0, len(updates), 2000):
        chunk = updates[index:index + 2000]
        cursor.executemany(
            "UPDATE files SET ai_description=?, tags=?, updated_at=? WHERE file_uuid=?",
            chunk,
        )
        written += len(chunk)
        conn.commit()
        uuids = [item[3] for item in chunk]
        placeholders = ','.join('?' * len(uuids))
        cursor.execute(
            "UPDATE file_artifacts SET state='stale' WHERE kind='text_vector' AND file_uuid IN (" + placeholders + ")",
            uuids,
        )
        conn.commit()
        log('已写入 %d / %d（%.0fs）' % (written, len(updates), time.time() - started))

    log('开始同步标签分层…')
    sys.path.insert(0, str(REPO / 'backend'))
    from core.database import DatabaseManager
    manager = DatabaseManager(str(DB))
    try:
        manager.sync_layers_from_files_tags('default')
        log('标签分层同步完成')
    except Exception as exc:
        log('标签分层同步失败: ' + repr(exc)[:200])

    for row in conn.execute("SELECT COUNT(*) FROM tags"):
        log('标签总数: %d' % row[0])
    conn.close()
    log('完成：写入 %d 条描述与标签，用时 %.0fs' % (written, time.time() - started))
    return 0


if __name__ == '__main__':
    sys.exit(main())
