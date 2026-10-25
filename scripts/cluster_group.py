# -*- coding: utf-8 -*-
"""对指定一组文件做声音聚类（默认：第 1 组「提示音」1817 个）。"""
from __future__ import annotations

import argparse
import csv
import glob
import json
import os
import sqlite3
from collections import Counter
from datetime import datetime
from pathlib import Path

import numpy as np
import chromadb
from chromadb.config import Settings


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument('--k', type=int, default=12)
    parser.add_argument('--group', default='1')
    args = parser.parse_args()

    group_csv = sorted(glob.glob(r'E:\AI音效管理器\auto-classify\groups-B-*.csv'))[-1]
    wanted = set()
    with open(group_csv, encoding='utf-8-sig', newline='') as handle:
        for row in csv.DictReader(handle):
            if row['组号'] == args.group:
                wanted.add(row['文件名'])
    print(f'目标文件: {len(wanted)}')

    db = Path(os.environ['APPDATA']) / 'EchoMind' / 'db' / 'soundmind.db'
    conn = sqlite3.connect(f'file:{db}?mode=ro', uri=True, timeout=60)
    name_col = conn.execute(
        "SELECT collection_name FROM index_manifests WHERE project_id='default' AND kind='audio_vector'"
    ).fetchone()[0]
    rows = conn.execute(
        "SELECT file_uuid, path, COALESCE(tags,'[]') FROM files WHERE project_id='default'"
    ).fetchall()
    conn.close()

    uuid_of, tags_of, path_of = {}, {}, {}
    for uuid, path, tag_json in rows:
        base = Path(path).name
        if base in wanted:
            uuid_of[base] = uuid
            path_of[uuid] = path
            try:
                tags_of[uuid] = [t for t in json.loads(tag_json or '[]') if isinstance(t, str)]
            except Exception:
                tags_of[uuid] = []
    print(f'库里找到: {len(uuid_of)}')

    client = chromadb.PersistentClient(
        path=str(Path(os.environ['APPDATA']) / 'EchoMind' / 'chroma_projects' / 'default'),
        settings=Settings(anonymized_telemetry=False))
    col = client.get_collection(name_col)

    uuids, vectors = [], []
    items = list(uuid_of.values())
    for start in range(0, len(items), 400):
        chunk = items[start:start + 400]
        data = col.get(ids=chunk, include=['embeddings'])
        got_ids = data.get('ids') or []
        got_emb = data.get('embeddings')
        if got_emb is None:
            got_emb = []
        for uuid, emb in zip(got_ids, got_emb):
            if emb is not None:
                uuids.append(uuid)
                vectors.append(np.asarray(emb, dtype=np.float32))
    print(f'取到向量: {len(uuids)}')

    matrix = np.stack(vectors)
    matrix /= (np.linalg.norm(matrix, axis=1, keepdims=True) + 1e-8)

    rng = np.random.default_rng(7)
    centers = matrix[rng.choice(len(matrix), args.k, replace=False)]
    labels = np.zeros(len(matrix), dtype=np.int32)
    for _ in range(40):
        dist = ((matrix[:, None, :] - centers[None, :, :]) ** 2).sum(axis=2)
        new = dist.argmin(axis=1)
        if np.array_equal(new, labels):
            break
        labels = new
        for i in range(args.k):
            members = matrix[labels == i]
            if len(members):
                centers[i] = members.mean(axis=0)

    stamp = datetime.now().strftime('%Y%m%d-%H%M%S')
    out_dir = Path(r'E:\AI音效管理器\auto-classify')
    rows_out = []
    print()
    for i in range(args.k):
        members = [uuids[j] for j in range(len(uuids)) if labels[j] == i]
        if not members:
            continue
        member_matrix = np.stack([matrix[j] for j in range(len(uuids)) if labels[j] == i])
        sim = member_matrix @ (centers[i] / (np.linalg.norm(centers[i]) + 1e-8))
        order = np.argsort(-sim)[:4]
        samples = [Path(path_of[members[j]]).name for j in order]

        tag_ratio = Counter()
        for uuid in members:
            for tag in set(tags_of.get(uuid) or []):
                tag_ratio[tag] += 1
        pure = [(t, c / len(members)) for t, c in tag_ratio.most_common(12)]
        pure = [f'{t}({int(r*100)}%)' for t, r in pure if r >= 0.5][:4]

        print(f'簇{i}: {len(members)} 条  共同特征: {" ".join(pure) if pure else "—"}')
        for name in samples[:3]:
            print(f'      {name}')
        for uuid in members:
            rows_out.append([i, len(members), ' '.join(pure), Path(path_of[uuid]).name])

    out = out_dir / f'cluster-g{args.group}-{stamp}.csv'
    with out.open('w', encoding='utf-8-sig', newline='') as handle:
        writer = csv.writer(handle)
        writer.writerow(['簇号', '数量', '共同特征', '文件名'])
        writer.writerows(rows_out)
    print(f'\n清单: {out}')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
