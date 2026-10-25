# -*- coding: utf-8 -*-
"""标签补全：用文本向量的语义近邻，给缺标签的文件补齐到 6 个。

规则
----
- 只参考「已经有 6 个标签」的文件作为样本
- 邻居相似度加权投票，取前 6 个，且每个标签至少被 min_votes 个邻居支持
- 只补充缺失位，绝不覆盖已有标签
- 写入前把原始标签存进 tag_auto_backup 表，可一键撤销
"""
from __future__ import annotations

import argparse
import json
import os
import sqlite3
import sys
import time
from collections import Counter, defaultdict
from datetime import datetime
from pathlib import Path

import chromadb
from chromadb.config import Settings

TARGET_TAGS = 6


def parse_tags(value: str) -> list:
    try:
        data = json.loads(value or '[]')
    except Exception:
        return []
    return [str(t).strip() for t in data if str(t).strip()]


def ensure_backup_table(conn) -> None:
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS tag_auto_backup (
            file_uuid TEXT PRIMARY KEY,
            old_tags TEXT NOT NULL,
            new_tags TEXT NOT NULL,
            created_at TEXT NOT NULL,
            batch TEXT NOT NULL
        )
        """
    )
    conn.commit()


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument('--apply', action='store_true')
    parser.add_argument('--limit', type=int, default=0)
    parser.add_argument('--k', type=int, default=25)
    parser.add_argument('--min-votes', type=int, default=2)
    parser.add_argument('--batch', type=int, default=200)
    parser.add_argument('--show', type=int, default=0, help='打印若干样例便于人工看质量')
    args = parser.parse_args()

    db_path = Path(os.environ['APPDATA']) / 'EchoMind' / 'db' / 'soundmind.db'
    conn = sqlite3.connect(str(db_path), timeout=180)
    conn.execute('PRAGMA busy_timeout = 180000')
    text_col = conn.execute(
        "SELECT collection_name FROM index_manifests WHERE project_id='default' AND kind='text_vector'"
    ).fetchone()[0]

    rows = conn.execute(
        "SELECT file_uuid, COALESCE(tags,'[]'), filename FROM files WHERE project_id='default'"
    ).fetchall()
    labeled = {}
    targets = []
    for uuid, tags_json, filename in rows:
        tags = parse_tags(tags_json)
        if len(tags) >= TARGET_TAGS:
            labeled[uuid] = tags
        else:
            targets.append((uuid, tags, filename))
    print(f'样本(满 6 标签): {len(labeled)}，待补: {len(targets)}')
    if args.limit:
        targets = targets[: args.limit]
        print(f'本次限制: {len(targets)}')

    client = chromadb.PersistentClient(
        path=str(Path(os.environ['APPDATA']) / 'EchoMind' / 'chroma_projects' / 'default'),
        settings=Settings(anonymized_telemetry=False))
    collection = client.get_collection(text_col)

    stamp = datetime.now().strftime('%Y%m%d-%H%M%S')
    if args.apply:
        ensure_backup_table(conn)

    filled = skipped = 0
    failures = []
    t0 = time.time()
    for start in range(0, len(targets), args.batch):
        chunk = targets[start:start + args.batch]
        ids = [item[0] for item in chunk]
        try:
            data = collection.get(ids=ids, include=['embeddings'])
        except Exception as exc:
            failures.extend((uuid, f'取向量失败: {exc}') for uuid in ids)
            continue
        got_ids = data.get('ids') or []
        embeddings = data.get('embeddings')
        if embeddings is None:
            embeddings = []

        pairs = [(uuid, emb) for uuid, emb in zip(got_ids, embeddings) if emb is not None]
        if not pairs:
            continue
        query_ids = [uuid for uuid, _ in pairs]
        query_vectors = [list(emb) for _, emb in pairs]
        try:
            result = collection.query(query_embeddings=query_vectors, n_results=args.k + 1)
        except Exception as exc:
            failures.extend((uuid, f'检索失败: {exc}') for uuid in query_ids)
            continue

        tag_by_uuid = {uuid: tags for uuid, tags, _ in chunk}
        for index, uuid in enumerate(query_ids):
            neighbor_ids = (result.get('ids') or [])[index] if result.get('ids') else []
            distances = (result.get('distances') or [])[index] if result.get('distances') else []
            votes = Counter()
            supporters = Counter()
            for neighbor, distance in zip(neighbor_ids, distances):
                if neighbor == uuid or neighbor not in labeled:
                    continue
                similarity = 1.0 - float(distance)  # cosine 距离 → 相似度
                if similarity <= 0:
                    continue
                weight = similarity ** 3
                for tag in labeled[neighbor]:
                    votes[tag] += weight
                    supporters[tag] += 1
            existing = tag_by_uuid.get(uuid) or []
            ranked = [tag for tag, _ in votes.most_common() if supporters[tag] >= args.min_votes]
            merged = list(existing)
            for tag in ranked:
                if len(merged) >= TARGET_TAGS:
                    break
                if tag not in merged:
                    merged.append(tag)
            if len(merged) <= len(existing):
                skipped += 1
                continue
            if args.show > 0 and filled < args.show:
                name = next((n for u, _t, n in chunk if u == uuid), uuid)
                print(f'    样例 {name}: {existing} → +{[t for t in merged if t not in existing]}')
            if args.apply:
                conn.execute(
                    "UPDATE files SET tags=?, updated_at=? WHERE file_uuid=?",
                    (json.dumps(merged, ensure_ascii=False), datetime.now().isoformat(), uuid),
                )
                conn.execute(
                    "INSERT OR REPLACE INTO tag_auto_backup (file_uuid, old_tags, new_tags, created_at, batch) "
                    "VALUES (?,?,?,?,?)",
                    (uuid, json.dumps(existing, ensure_ascii=False),
                     json.dumps(merged, ensure_ascii=False), datetime.now().isoformat(), stamp),
                )
            filled += 1

        if args.apply:
            conn.commit()
        done = min(start + args.batch, len(targets))
        print(f'  {done}/{len(targets)}  已补 {filled}  跳过 {skipped}  用时 {time.time()-t0:.0f}s', flush=True)

    if args.apply:
        conn.commit()
        conn.execute("UPDATE file_artifacts SET state='stale' WHERE kind='text_vector'")
        conn.commit()
    conn.close()

    print(f'\n完成：补标签 {filled}，无可用证据 {skipped}，失败 {len(failures)}')
    print(f'批次号: {stamp}')
    if not args.apply:
        print('[DRY RUN] 未写数据库')
    for uuid, reason in failures[:5]:
        print('  失败:', uuid, reason)
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
