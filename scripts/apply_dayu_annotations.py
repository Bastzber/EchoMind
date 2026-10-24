#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""把大羽的"打标索引"（34,187 条描述 + 6 标签 + sha256）导入 EchoMind。

前提：文件已经导入 EchoMind（库里有对应记录）。脚本按 sha256 精确匹配。

用法：
    python scripts/apply_dayu_annotations.py --dry-run
    python scripts/apply_dayu_annotations.py --apply
"""
from __future__ import annotations

import argparse
import json
import os
import sqlite3
import sys
import time
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_JSON = r'F:\大羽音效库集合包及安装说明\大羽音效库集合包打标索引V1.0.json'


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument('--json', default=DEFAULT_JSON)
    parser.add_argument('--db', default=os.path.join(os.environ['APPDATA'], 'EchoMind', 'db', 'soundmind.db'))
    parser.add_argument('--apply', action='store_true')
    parser.add_argument('--limit', type=int, default=0)
    args = parser.parse_args()

    if not os.path.exists(args.json):
        print('索引文件不存在:', args.json)
        return 1

    data = json.loads(Path(args.json).read_text(encoding='utf-8'))
    assets = data.get('assets') or []
    print('索引条数:', len(assets))

    sys.path.insert(0, str(REPO_ROOT / 'backend'))
    from core.database import DatabaseManager  # noqa: E402

    manager = DatabaseManager(args.db)
    with manager.get_cursor() as cursor:
        rows = cursor.execute("SELECT file_uuid, sha256, path, ai_description, tags FROM files WHERE sha256 IS NOT NULL AND sha256 != ''").fetchall()
    by_sha = {row[1]: row for row in rows}
    print('库内有哈希的记录:', len(by_sha))

    matched = 0
    missing = 0
    already = 0
    updates = []
    for asset in assets:
        sha = (asset.get('sha256') or '').strip()
        if not sha:
            missing += 1
            continue
        row = by_sha.get(sha)
        if not row:
            missing += 1
            continue
        file_uuid, _sha, path, current_desc, current_tags = row
        matched += 1
        if current_desc and current_desc.strip() and not current_desc.startswith('[auto]'):
            already += 1
        updates.append({
            'file_uuid': file_uuid,
            'path': path,
            'description': (asset.get('description') or '').strip(),
            'tags': [str(t).strip() for t in (asset.get('tags') or []) if str(t).strip()],
        })
        if args.limit and len(updates) >= args.limit:
            break

    print('可匹配: %d   库里没有该哈希: %d   已有描述(不覆盖): %d' % (matched, missing, already))

    if not args.apply:
        print('\nDRY-RUN：没有写入。样例：')
        for item in updates[:3]:
            print('  ', item['path'])
            print('     描述:', item['description'][:60])
            print('     标签:', item['tags'])
        return 0

    written = 0
    started = time.time()
    for index, item in enumerate(updates, 1):
        try:
            manager.update_ai_description(item['file_uuid'], item['description'])
            manager.update_tags(item['path'], item['tags'], 'default')
            manager.sync_layers_from_files_tags('default', file_uuid=item['file_uuid'])
            written += 1
        except Exception as exc:
            print('  失败:', item['path'], exc)
        if index % 500 == 0:
            print('  已写入 %d / %d（%.0fs）' % (index, len(updates), time.time() - started), flush=True)

    print('\n完成：写入 %d 条，耗时 %.0fs' % (written, time.time() - started))
    print('提示：标签树需要刷新（重启应用或 Ctrl+R）才会显示新标签。')
    return 0


if __name__ == '__main__':
    sys.exit(main())
