# -*- coding: utf-8 -*-
"""文本向量分块重建（每个进程处理一小批，退出后由外层循环重启，内存不累积）。

用法：python scripts/rebuild_text_vectors.py --limit 200
"""
from __future__ import annotations

import argparse
import asyncio
import json
import os
import sqlite3
import sys
from pathlib import Path

BACKEND = Path(__file__).resolve().parents[1] / 'backend'
sys.path.insert(0, str(BACKEND))


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument('--limit', type=int, default=200)
    args = parser.parse_args()

    db_path = Path(os.environ['APPDATA']) / 'EchoMind' / 'db' / 'soundmind.db'
    con = sqlite3.connect(str(db_path), timeout=120)
    con.row_factory = sqlite3.Row
    rows = con.execute(
        """
        SELECT f.file_uuid, f.path, f.filename, COALESCE(f.ai_description,'') AS desc,
               COALESCE(f.tags,'[]') AS tags
        FROM file_artifacts a
        JOIN files f ON f.file_uuid=a.file_uuid AND f.project_id=a.project_id
        WHERE a.kind='text_vector' AND a.state IN ('stale','pending') AND f.project_id='default'
        ORDER BY f.file_uuid LIMIT ?
        """,
        (args.limit,),
    ).fetchall()
    if not rows:
        print('DONE 0')
        return 0

    from core.indexer import get_text_indexer
    from core.database import get_db_manager

    db = get_db_manager()
    manifest = db.get_index_manifest('default', 'text_vector') or {}
    collection = manifest.get('collection_name') or 'text_metadata_embeddings'
    indexer = get_text_indexer('default', collection_name=collection)

    records = []
    for r in rows:
        records.append({
            'file_id': r['file_uuid'],
            'file_path': r['path'],
            'filename': r['filename'],
            'description': r['desc'],
            'ai_description': r['desc'],
            'tags': r['tags'],
            'project_id': 'default',
        })

    try:
        result = asyncio.run(indexer.upsert_metadata(records))
    except Exception as exc:
        print('ERR', type(exc).__name__, str(exc)[:200])
        return 2

    indexed = int(result.get('indexed') or 0)
    for r in rows:
        con.execute(
            "UPDATE file_artifacts SET state='ready', error_code=NULL, error_message=NULL "
            "WHERE project_id='default' AND file_uuid=? AND kind='text_vector'",
            (r['file_uuid'],),
        )
    con.commit()
    print('OK', indexed, 'of', len(rows))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())