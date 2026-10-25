# -*- coding: utf-8 -*-
"""把聚类结果做成可试听的 HTML（每簇 3 个代表音 + 播放器）。"""
from __future__ import annotations

import csv
import glob
import html
import os
import sqlite3
from collections import defaultdict
from pathlib import Path

group_csv = sorted(glob.glob(r'E:\AI音效管理器\auto-classify\cluster-g1-*.csv'))[-1]
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
    'body{font-family:"Microsoft YaHei",sans-serif;background:#101014;color:#ddd;padding:20px 28px;}',
    'h1{font-size:20px;margin-bottom:4px}h2{font-size:15px;margin:26px 0 8px;color:#9ecbff}',
    '.row{display:flex;align-items:center;gap:10px;margin:6px 0;font-size:13px}',
    '.name{width:320px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    'audio{height:28px}',
    '.meta{opacity:.55;font-size:12px}',
    '</style>',
    '<h1>待归类「提示音」组 — 按声音聚成的 10 簇</h1>',
    '<p class="meta">每簇放 3 个代表音。听完后告诉我：<b>簇0 → 分类</b>，我一次归一整簇。</p>',
]

for cid in sorted(clusters, key=lambda x: int(x)):
    items = clusters[cid]
    total, feature, _ = items[0]
    parts.append(f'<h2>簇 {cid}　{total} 条　{html.escape(feature or "")}</h2>')
    for _, _, name in items[:3]:
        path = paths.get(name, '')
        uri = 'file:///' + str(path).replace('\\', '/').replace('#', '%23') if path else ''
        parts.append(
            f'<div class="row"><span class="name">{html.escape(name)}</span>'
            f'<audio controls preload="none" src="{html.escape(uri)}"></audio></div>'
        )

out = Path(r'E:\AI音效管理器\auto-classify\review-clusters.html')
out.write_text('\n'.join(parts), encoding='utf-8')
print('已生成:', out)
print('簇数:', len(clusters), '总条数:', sum(v[0][0] for v in clusters.values()))
