# -*- coding: utf-8 -*-
"""生成可用 http 打开的聚类试听页：把代表音复制到 clips/ 下，用相对路径引用。"""
from __future__ import annotations

import csv
import glob
import html
import os
import shutil
import sqlite3
from collections import defaultdict
from pathlib import Path

OUT_DIR = Path(r'E:\AI音效管理器\auto-classify')
CLIPS = OUT_DIR / 'clips'
if CLIPS.exists():
    shutil.rmtree(CLIPS)
CLIPS.mkdir(parents=True, exist_ok=True)

group_csv = sorted(glob.glob(str(OUT_DIR / 'cluster-g1-*.csv')))[-1]
clusters = defaultdict(list)
with open(group_csv, encoding='utf-8-sig', newline='') as handle:
    for row in csv.DictReader(handle):
        clusters[row['簇号']].append((int(row['数量']), row['共同特征'], row['文件名']))

db = Path(os.environ['APPDATA']) / 'EchoMind' / 'db' / 'soundmind.db'
conn = sqlite3.connect(f'file:{db}?mode=ro', uri=True, timeout=30)
paths = {}
for name, path in conn.execute("SELECT filename, path FROM files WHERE project_id='default'"):
    paths.setdefault(name, path)
conn.close()

parts = [
    '<!doctype html><meta charset="utf-8"><title>待归类簇试听</title>',
    '<style>',
    'body{font-family:"Microsoft YaHei",sans-serif;background:#101014;color:#ddd;padding:20px 28px}',
    'h1{font-size:20px;margin-bottom:4px}h2{font-size:15px;margin:24px 0 6px;color:#9ecbff;border-top:1px solid #26262e;padding-top:14px}',
    '.row{display:flex;align-items:center;gap:12px;margin:6px 0;font-size:13px}',
    '.name{width:340px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    'audio{height:30px}',
    '.meta{opacity:.55;font-size:12px;line-height:1.7}',
    '</style>',
    '<h1>待归类「提示音」组 — 10 簇试听</h1>',
    '<p class="meta">每簇 3 个代表音。听完回我：<b>0 手机提示音, 3 科技扫描, 5 跳过</b> 这样就行。</p>',
]

copied = 0
missing = []
for cid in sorted(clusters, key=lambda x: int(x)):
    items = clusters[cid]
    total, feature, _ = items[0]
    parts.append(f'<h2>簇 {cid}　{total} 条</h2>')
    for idx, (_, _, name) in enumerate(items[:3]):
        src = paths.get(name, '')
        if not src or not os.path.exists(src):
            missing.append(name)
            continue
        suffix = Path(src).suffix.lower() or '.wav'
        target = CLIPS / f'c{cid}_{idx}{suffix}'
        try:
            shutil.copy2(src, target)
            copied += 1
        except Exception:
            missing.append(name)
            continue
        parts.append(
            f'<div class="row"><span class="name">{html.escape(name)}</span>'
            f'<audio controls preload="metadata" src="clips/{target.name}"></audio></div>'
        )

(OUT_DIR / 'review.html').write_text('\n'.join(parts), encoding='utf-8')
print('生成:', OUT_DIR / 'review.html')
print('复制音频:', copied, '缺失:', len(missing))
