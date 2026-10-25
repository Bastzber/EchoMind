# -*- coding: utf-8 -*-
"""用用户指认过的代表音当种子，按音频相似度扩展成组。

比 k-means 精准：每个种子对应一个明确分类，只收「和种子很像」的文件。
"""
from __future__ import annotations

import json
import os
import sqlite3
from collections import defaultdict
from pathlib import Path

import numpy as np
import chromadb
from chromadb.config import Settings

OUT = Path(r'E:\AI音效管理器\auto-classify')
PENDING_DIRS = ('_待人工判断', '_待归类')

# 用户听过的代表音 → 分类
SEEDS = [
    ('ORTU1ACK.WAV',              '动物与昆虫/野生动物',   '大象'),
    ('ZR1163.WAV',                '动物与昆虫/家养动物',   '猫叫'),
    ('插拔USB.wav',                '电子与界面/系统与设备反馈', '插拔USB'),
    ('ZR1822.WAV',                '脚步与服装/衣物',       '拉链'),
    ('S354.WAV',                  '撞击与材质/金属',       '锯齿金属'),
    ('ZR1434.WAV',                '机械与工业/电机与齿轮', '机械震翅'),
    ('S482.WAV',                  '撞击与材质/撞击与摩擦', '鞭子'),
    ('ZR1186.WAV',                '转场与设计/掠过',       '甩鞭破风'),
    ('ZR1335.WAV',                '武器与爆破/爆炸',       '飞行后爆炸'),
    ('电子解密成功音效.mp3',        '电子与界面/扫描与数据', '科技破解'),
    ('AC29.mp3',                  '音乐与乐器/循环与节奏', '嘻哈电子'),
    ('SND259.WAV',                '动物与昆虫/鸟类',       '鸟叫'),
    ('08 (7).WAV',                '转场与设计/上升',       '高频渐强'),
    ('dcd023_06.mp3',             '电子与界面/系统与设备反馈', 'Windows提示音'),
    ('ZR607.WAV',                 '动物与昆虫/野生动物',   '狼嚎乌鸦'),
    ('ZR1933 (2).WAV',            '交通工具/警笛与喇叭',   '汽车警报'),
    ('ZR1535.WAV',                '交通工具/引擎与机械',   '引擎'),
    ('v027.m4a',                  '生活与器具/开关与小装置', '按键滑动'),
    ('v126.m4a',                  '生活与器具/门窗',       '门铃报时'),
]


def main() -> int:
    db = Path(os.environ['APPDATA']) / 'EchoMind' / 'db' / 'soundmind.db'
    conn = sqlite3.connect(f'file:{db}?mode=ro', uri=True, timeout=60)
    col_name = conn.execute(
        "SELECT collection_name FROM index_manifests WHERE project_id='default' AND kind='audio_vector'"
    ).fetchone()[0]
    rows = conn.execute("SELECT file_uuid, path FROM files WHERE project_id='default'").fetchall()
    conn.close()

    pending, name_of, by_name = [], {}, {}
    for uuid, path in rows:
        base = Path(path).name
        by_name.setdefault(base, uuid)
        if any(part in PENDING_DIRS for part in Path(path).parts):
            pending.append(uuid)
            name_of[uuid] = base
    print('待归类:', len(pending))

    client = chromadb.PersistentClient(
        path=str(Path(os.environ['APPDATA']) / 'EchoMind' / 'chroma_projects' / 'default'),
        settings=Settings(anonymized_telemetry=False))
    collection = client.get_collection(col_name)

    vectors, ids = {}, []
    for start in range(0, len(pending), 400):
        chunk = pending[start:start + 400]
        data = collection.get(ids=chunk, include=['embeddings'])
        got_ids = data.get('ids') or []
        got_emb = data.get('embeddings')
        if got_emb is None:
            got_emb = []
        for uuid, emb in zip(got_ids, got_emb):
            if emb is not None:
                vector = np.asarray(emb, dtype=np.float32)
                vectors[uuid] = vector / (np.linalg.norm(vector) + 1e-8)
                ids.append(uuid)
    print('取到向量:', len(ids))

    matrix = np.stack([vectors[u] for u in ids])
    seed_rows = []
    for name, category, label in SEEDS:
        uuid = by_name.get(name)
        if not uuid or uuid not in vectors:
            print('  种子缺失:', name)
            continue
        similarity = matrix @ vectors[uuid]
        seed_rows.append((label, category, name, similarity))

    # 每个候选归到最像的种子（相似度 ≥ 阈值）
    threshold = float(os.environ.get('SEED_THRESHOLD', '0.75'))
    best = np.full(len(ids), -1)
    best_sim = np.zeros(len(ids))
    for index, (label, category, name, similarity) in enumerate(seed_rows):
        mask = similarity > best_sim
        best[mask] = index
        best_sim[mask] = similarity[mask]

    groups = defaultdict(list)
    for position, uuid in enumerate(ids):
        label_index = best[position]
        if label_index < 0 or best_sim[position] < threshold:
            continue
        label, category, name, _ = seed_rows[label_index]
        groups[(label, category)].append((best_sim[position], name_of[uuid]))

    total = sum(len(v) for v in groups.values())
    print(f'\n阈值 {threshold}，可归属 {total} / {len(ids)} 个\n')
    for (label, category), items in sorted(groups.items(), key=lambda kv: -len(kv[1])):
        items.sort(reverse=True)
        print(f'{len(items):4d} 条  {category}   （种子: {label}）')
        for sim, name in items[:5]:
            print(f'          {name}  {sim:.3f}')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
