#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""快速补音频向量：直接调 CLAP 批量编码 + 写入项目 chroma 集合。

应用自带的重建每次只写几千条就断，这个脚本一次性跑完，逐批记账可续。
用法：python scripts/fast_audio_index.py [--batch 16] [--limit 0] [--dry 32]
"""
from __future__ import annotations

import argparse
import os
import sqlite3
import sys
import time
import traceback
from pathlib import Path

REPO = Path(r'E:\音效库管理软件\EchoMind\EchoMind-main')
sys.path.insert(0, str(REPO / 'backend'))
LOG = Path(r'E:\AI音效管理器\fast-audio.log')
DB_SUB = Path('Chroma')  # 占位


def log(msg: str) -> None:
    line = time.strftime('%H:%M:%S') + '  ' + msg
    print(line, flush=True)
    try:
        with LOG.open('a', encoding='utf-8') as handle:
            handle.write(line + '\n')
    except Exception:
        pass


def ensure_utf8() -> None:
    try:
        sys.stdout.reconfigure(encoding='utf-8', errors='replace')
    except Exception:
        pass


def main() -> int:
    ensure_utf8()
    parser = argparse.ArgumentParser()
    parser.add_argument('--batch', type=int, default=16)
    parser.add_argument('--limit', type=int, default=0)
    parser.add_argument('--dry', type=int, default=0, help='只跑前 N 个测速')
    args = parser.parse_args()

    from core.database import DatabaseManager
    from core.embedder import get_embedder

    db_file = Path(os.environ['APPDATA']) / 'EchoMind' / 'db' / 'soundmind.db'
    db = DatabaseManager(str(db_file))
    manifest = db.get_index_manifest('default', 'audio_vector') or {}
    collection_name = manifest.get('collection_name') or 'audio_embeddings'
    ChromaPath = Path(os.environ['APPDATA']) / 'EchoMind' / 'chroma_projects' / 'default'
    log('集合 %s @ %s' % (collection_name, ChromaPath))

    import chromadb
    client = chromadb.PersistentClient(path=str(ChromaPath))
    collection = client.get_collection(collection_name)
    log('集合现有条数: %d' % collection.count())

    embedder = get_embedder()
    if embedder is None:
        log('CLAP 模型不可用')
        return 1
    log('嵌入器: %s  设备=%s' % (type(embedder).__name__, getattr(embedder, 'device', '?')))

    done = 0
    failed = 0
    started = time.time()
    consecutive_empty = 0
    while True:
        rows = db.list_artifacts_for_work(
            'default', ['audio_vector'], states=('pending', 'stale', 'processing'), limit=args.batch)
        if not rows:
            log('没有待处理项')
            break

        paths = [row['path'] for row in rows]
        try:
            vectors_by_path = embedder.encode_audio_batch(paths) or {}
        except Exception:
            log('编码异常:\n' + traceback.format_exc()[-400:])
            vectors_by_path = {}

        if not vectors_by_path:
            consecutive_empty += 1
            for row in rows:
                db.set_artifact_state('default', row['file_uuid'], 'audio_vector', 'failed',
                                      error_code='encode_failed', error_message='批量编码失败')
                failed += 1
            log('本批编码失败（第 %d 次）' % consecutive_empty)
            if consecutive_empty >= 3:
                log('连续失败，停止')
                break
            continue
        consecutive_empty = 0

        ids = []
        embeddings = []
        metadatas = []
        ok_uuids = []
        for row in rows:
            vector = vectors_by_path.get(row['path'])
            if vector is None:
                continue
            ids.append(row['file_uuid'])
            embeddings.append([float(x) for x in vector])
            metadatas.append({
                'file_path': row['path'],
                'filename': row['filename'],
                'duration': float(row['duration'] or 0),
                'file_id': row['file_uuid'],
            })
            ok_uuids.append(row['file_uuid'])

        if ids:
            collection.upsert(ids=ids, embeddings=embeddings, metadatas=metadatas)
            for uuid in ok_uuids:
                db.set_artifact_state('default', uuid, 'audio_vector', 'ready')
            done += len(ids)
        for row in rows:
            if row['file_uuid'] not in ok_uuids:
                db.set_artifact_state('default', row['file_uuid'], 'audio_vector', 'failed',
                                      error_code='encode_failed', error_message='空向量')
                failed += 1

        elapsed = time.time() - started
        log('成功 %d 失败 %d（%.0fs, %.1f 个/秒, 集合 %d）'
            % (done, failed, elapsed, done / max(1, elapsed), collection.count()))
        if args.dry and done >= args.dry:
            log('测速结束')
            break
        if args.limit and done >= args.limit:
            break

    log('结束：成功 %d 失败 %d' % (done, failed))
    return 0


if __name__ == '__main__':
    sys.exit(main())
