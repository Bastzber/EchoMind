# -*- coding: utf-8 -*-
"""按声音相似度给待归类文件聚类。

用库里已有的 CLAP 音频向量（Chroma），不重新计算：
1. 取出待归类文件的向量
2. L2 归一化后做 k-means（向量本身就是语义空间，欧氏距离≈听感相似）
3. 每簇给出代表文件、共同标签、以及"这些描述里最常出现的词"
"""
from __future__ import annotations

import argparse
import json
import os
import sqlite3
from collections import Counter, defaultdict
from datetime import datetime
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[1]
PENDING_DIRS = ('_待人工判断', '_待归类')


def load_pending():
    db = Path(os.environ['APPDATA']) / 'EchoMind' / 'db' / 'soundmind.db'
    conn = sqlite3.connect(f'file:{db}?mode=ro', uri=True, timeout=60)
    rows = conn.execute(
        "SELECT file_uuid, path, COALESCE(tags,'[]'), COALESCE(ai_description,'') FROM files WHERE project_id='default'"
    ).fetchall()
    conn.close()
    pending, names, tags, descriptions = [], {}, {}, {}
    for uuid, path, tag_json, description in rows:
        if not any(part in PENDING_DIRS for part in Path(path).parts):
            continue
        pending.append(uuid)
        names[uuid] = Path(path).name
        try:
            tags[uuid] = json.loads(tag_json or '[]')
        except Exception:
            tags[uuid] = []
        descriptions[uuid] = description or ''
    return pending, names, tags, descriptions


def load_embeddings(uuids):
    import chromadb
    from chromadb.config import Settings

    persist = Path(os.environ['APPDATA']) / 'EchoMind' / 'chroma_projects' / 'default'
    client = chromadb.PersistentClient(path=str(persist), settings=Settings(anonymized_telemetry=False))

    # 活动集合名在 index_manifests 里（重建时会换成 audio_shadow_xxx）
    db = Path(os.environ['APPDATA']) / 'EchoMind' / 'db' / 'soundmind.db'
    conn = sqlite3.connect(f'file:{db}?mode=ro', uri=True, timeout=30)
    row = conn.execute(
        "SELECT collection_name FROM index_manifests WHERE project_id='default' AND kind='audio_vector'"
    ).fetchone()
    conn.close()
    name = row[0] if row else 'audio_embeddings'
    print('活动集合:', name)
    collection = client.get_collection(name)

    found, missing = {}, []
    batch = 500
    for start in range(0, len(uuids), batch):
        chunk = uuids[start:start + batch]
        try:
            data = collection.get(ids=chunk, include=['embeddings'])
        except Exception:
            data = {'ids': [], 'embeddings': []}
        ids = data.get('ids')
        embeddings = data.get('embeddings')
        if ids is None or embeddings is None:
            ids, embeddings = [], []
        for uuid, embedding in zip(ids, embeddings):
            if embedding is not None:
                found[uuid] = np.asarray(embedding, dtype=np.float32)
        for uuid in chunk:
            if uuid not in found:
                missing.append(uuid)
        if (start // batch) % 4 == 0:
            print(f'  读取向量 {start + len(chunk)}/{len(uuids)}', flush=True)
    return found, missing


def kmeans(matrix: np.ndarray, k: int, iterations: int = 30, seed: int = 42):
    rng = np.random.default_rng(seed)
    n = matrix.shape[0]
    # k-means++ 初始化
    centers = [matrix[rng.integers(n)]]
    for _ in range(k - 1):
        distances = np.min(
            np.linalg.norm(matrix[:, None, :] - np.array(centers)[None, :, :], axis=2), axis=1
        )
        probabilities = distances / distances.sum() if distances.sum() else np.ones(n) / n
        centers.append(matrix[rng.choice(n, p=probabilities)])
    centers = np.array(centers, dtype=np.float32)

    labels = np.zeros(n, dtype=np.int32)
    for _ in range(iterations):
        distances = ((matrix[:, None, :] - centers[None, :, :]) ** 2).sum(axis=2)
        new_labels = distances.argmin(axis=1)
        if np.array_equal(new_labels, labels):
            break
        labels = new_labels
        for index in range(k):
            members = matrix[labels == index]
            if len(members):
                centers[index] = members.mean(axis=0)
    return labels, centers


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument('--k', type=int, default=30)
    parser.add_argument('--out', default=r'E:\AI音效管理器\auto-classify')
    args = parser.parse_args()

    pending, names, tags, descriptions = load_pending()
    print(f'待归类: {len(pending)}')

    found, missing = load_embeddings(pending)
    print(f'有音频向量: {len(found)}，缺向量: {len(missing)}')
    if len(found) < 50:
        raise SystemExit('向量太少，无法聚类')

    uuids = list(found.keys())
    matrix = np.stack([found[u] for u in uuids])
    matrix /= (np.linalg.norm(matrix, axis=1, keepdims=True) + 1e-8)

    k = min(args.k, max(2, len(uuids) // 20))
    print(f'聚类 k={k} ...', flush=True)
    labels, centers = kmeans(matrix, k)

    clusters = defaultdict(list)
    for index, label in enumerate(labels):
        clusters[int(label)].append(uuids[index])

    print(f'得到 {len(clusters)} 簇')
    stamp = datetime.now().strftime('%Y%m%d-%H%M%S')
    out_dir = Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)

    summary = []
    for label, members in sorted(clusters.items(), key=lambda kv: -len(kv[1])):
        center = centers[label]
        member_matrix = np.stack([found[u] for u in members])
        member_matrix = member_matrix / (np.linalg.norm(member_matrix, axis=1, keepdims=True) + 1e-8)
        similarity = member_matrix @ center
        order = np.argsort(-similarity)[:5]
        samples = [names[members[i]] for i in order]

        tag_counter = Counter()
        for uuid in members:
            for tag in tags.get(uuid) or []:
                if isinstance(tag, str) and tag.strip():
                    tag_counter[tag.strip()] += 1
        top_tags = [tag for tag, _ in tag_counter.most_common(6)]

        desc_words = Counter()
        for uuid in members:
            for token in (descriptions.get(uuid) or '').replace('，', ' ').replace('。', ' ').split():
                if len(token) >= 2:
                    desc_words[token] += 1
        top_words = [word for word, _ in desc_words.most_common(4)]

        summary.append({
            'cluster': label,
            'size': len(members),
            'samples': samples,
            'tags': top_tags,
            'words': top_words,
            'members': [names[u] for u in members],
        })

    csv_path = out_dir / f'clusters-{stamp}.csv'
    with csv_path.open('w', encoding='utf-8-sig', newline='') as handle:
        import csv as csv_module
        writer = csv_module.writer(handle)
        writer.writerow(['簇号', '数量', '共同标签', '描述高频词', '建议分类', '文件名'])
        for item in summary:
            for name in item['members']:
                writer.writerow([item['cluster'], item['size'], '/'.join(item['tags']),
                                 '/'.join(item['words']), '', name])

    print(f'\n{"簇":>4} {"数量":>6}  共同标签 / 描述词')
    for item in summary[:24]:
        print(f'{item["cluster"]:>4} {item["size"]:>6}  {" ".join(item["tags"])[:40]}  |  {" ".join(item["words"])[:24]}')
        for name in item['samples'][:3]:
            print(f'         {name}')

    print(f'\n清单: {csv_path}')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
