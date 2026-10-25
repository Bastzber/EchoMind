#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""独立向量索引器（v2）：用 AudioIndexer / TextMetadataIndexer 直接补向量。"""
from __future__ import annotations

import argparse
import asyncio
import os
import sqlite3
import sys
import time
import traceback
from pathlib import Path

REPO = Path(r'E:\音效库管理软件\EchoMind\EchoMind-main')
sys.path.insert(0, str(REPO / 'backend'))
LOG = Path(r'E:\AI音效管理器\vector-index.log')


def log(message: str) -> None:
    line = time.strftime('%H:%M:%S') + '  ' + message
    print(line, flush=True)
    try:
        with LOG.open('a', encoding='utf-8') as handle:
            handle.write(line + '\n')
    except Exception:
        pass


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument('--kind', default='audio_vector', choices=['audio_vector', 'text_vector'])
    parser.add_argument('--limit', type=int, default=0)
    parser.add_argument('--chunk', type=int, default=32)
    args = parser.parse_args()

    import config
    from core.database import DatabaseManager
    from core.indexer import AudioIndexer, TextMetadataIndexer

    db = DatabaseManager(str(Path(os.environ['APPDATA']) / 'EchoMind' / 'db' / 'soundmind.db'))
    manifest = db.get_index_manifest('default', args.kind) or {}
    collection = manifest.get('collection_name') or (
        'audio_embeddings' if args.kind == 'audio_vector' else 'text_metadata_embeddings')
    persist = str(config.get_db_path())
    log('集合=%s persist=%s' % (collection, persist))

    if args.kind == 'audio_vector':
        indexer = AudioIndexer(persist_directory=persist, collection_name=collection, project_id='default')
        log('集合现有条数: %d' % indexer.collection.count())
    else:
        indexer = TextMetadataIndexer(persist_directory=persist, collection_name=collection, project_id='default')
        log('集合现有条数: %d' % indexer.collection.count())

    done = 0
    failed = 0
    empty_streak = 0
    started = time.time()
    while True:
        rows = db.list_artifacts_for_work(
            'default', [args.kind], states=('pending', 'stale', 'processing'), limit=args.chunk)
        if not rows:
            log('没有待处理项')
            break

        if args.kind == 'audio_vector':
            entries = []
            for row in rows:
                metadata = {
                    'file_id': row['file_uuid'],
                    'filename': row['filename'],
                    'duration': row['duration'] or 0.0,
                    'sample_rate': row['sample_rate'] or 0,
                    'channels': row['channels'] or 0,
                    'size': row['file_size'] or 0,
                    'folder_path': str(Path(row['path']).parent),
                }
                entries.append((row['path'], row['file_uuid'], metadata))
            try:
                ids = set(indexer.add_audio_batch(entries, batch_size=8) or [])
            except Exception:
                log('本批异常:\n' + traceback.format_exc()[-500:])
                ids = set()
        else:
            uuids = [row['file_uuid'] for row in rows]
            conn = sqlite3.connect(str(Path(os.environ['APPDATA']) / 'EchoMind' / 'db' / 'soundmind.db'), timeout=60)
            marks = ','.join('?' * len(uuids))
            info = {r[0]: r for r in conn.execute(
                'SELECT file_uuid, path, filename, ai_description, tags FROM files WHERE file_uuid IN (%s)' % marks, uuids)}
            conn.close()
            records = []
            for uuid in uuids:
                row = info.get(uuid)
                if not row:
                    continue
                records.append({
                    'file_id': uuid,
                    'file_path': row[1],
                    'filename': row[2],
                    'description': row[3] or '',
                    'tags': row[4] or '[]',
                })
            try:
                result = asyncio.run(indexer.upsert_metadata(records))
                ids = set(records[i]['file_id'] for i in range(len(records))) if result.get('indexed') else set()
            except Exception:
                log('本批异常:\n' + traceback.format_exc()[-500:])
                ids = set()

        for row in rows:
            if row['file_uuid'] in ids:
                db.set_artifact_state('default', row['file_uuid'], args.kind, 'ready')
                done += 1
            else:
                failed += 1

        if not ids:
            empty_streak += 1
            if empty_streak >= 3:
                log('连续 3 批没有任何进展，停止（避免死循环）')
                break
            time.sleep(5)
        else:
            empty_streak = 0

        elapsed = time.time() - started
        log('%s 成功 %d 失败 %d（%.0fs, %.2f/秒, 集合 %d 条）'
            % (args.kind, done, failed, elapsed, done / max(1, elapsed), indexer.collection.count()))
        if args.limit and done >= args.limit:
            break

    log('结束：成功 %d 失败 %d' % (done, failed))
    return 0


if __name__ == '__main__':
    sys.exit(main())
