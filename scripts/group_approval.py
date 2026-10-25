# -*- coding: utf-8 -*-
"""方案 B：生成分组批准报告（HTML + CSV）。

规则（收紧版）
--------------
- 文件名能判 → 不进本报告
- 描述里命中的关键词必须「最长且唯一」，且长度 ≥3 字（中文）/ ≥5 字符（英文）
- 同一组内按文件名抽样，方便肉眼确认
"""
from __future__ import annotations

import csv
import html
import json
import os
import sqlite3
import sys
from collections import defaultdict
from datetime import datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from keyword_classify import build_index, match, load_config, PENDING_DIRS


def strict_hit(description: str, index) -> tuple | None:
    hits = match(description, index)
    if not hits:
        return None
    ranked = sorted(
        ((max((len(w) for w in words), default=0), target, words) for target, words in hits.items()),
        key=lambda item: -item[0],
    )
    best_len, best, words = ranked[0]
    if len(ranked) > 1 and ranked[1][0] == best_len:
        return None
    longest = max(words, key=len)
    if len(longest) < (3 if any('\u4e00' <= ch <= '\u9fff' for ch in longest) else 5):
        return None
    return best, longest


def main() -> int:
    config = load_config()
    index = build_index(config)

    db = Path(os.environ['APPDATA']) / 'EchoMind' / 'db' / 'soundmind.db'
    conn = sqlite3.connect(f'file:{db}?mode=ro', uri=True, timeout=60)
    rows = conn.execute(
        "SELECT path, COALESCE(ai_description,'') FROM files WHERE project_id='default'"
    ).fetchall()
    conn.close()

    groups = defaultdict(list)
    for path, description in rows:
        parts = Path(path).parts
        if not any(x in PENDING_DIRS for x in parts):
            continue
        if match(Path(path).name, index):
            continue
        if not description:
            continue
        result = strict_hit(description, index)
        if not result:
            continue
        (level1, level2), keyword = result
        groups[(level1, level2)].append((Path(path).name, keyword))

    covered = sum(len(v) for v in groups.values())
    ordered = sorted(groups.items(), key=lambda kv: -len(kv[1]))
    print(f'待批准: {covered} 个文件，{len(ordered)} 组\n')

    out_dir = Path(r'E:\AI音效管理器\auto-classify')
    out_dir.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now().strftime('%Y%m%d-%H%M%S')

    csv_path = out_dir / f'groups-B-{stamp}.csv'
    with csv_path.open('w', encoding='utf-8-sig', newline='') as handle:
        writer = csv.writer(handle)
        writer.writerow(['组号', '数量', '建议一级', '建议二级', '依据关键词', '文件名'])
        for idx, ((level1, level2), items) in enumerate(ordered, start=1):
            for name, keyword in items:
                writer.writerow([idx, len(items), level1, level2, keyword, name])

    html_path = out_dir / f'groups-B-{stamp}.html'
    parts = ['<!doctype html><meta charset="utf-8"><title>待归类分组批准</title>',
             '<style>body{font-family:"Microsoft YaHei",sans-serif;background:#111;color:#ddd;padding:24px}',
             'table{border-collapse:collapse;width:100%}td,th{border-bottom:1px solid #333;padding:6px;font-size:13px;text-align:left}',
             'h1{font-size:18px}code{background:#222;padding:1px 4px;border-radius:3px}</style>',
             f'<h1>待归类分组批准：{covered} 个文件 / {len(ordered)} 组</h1>',
             '<p>在聊天里回「通过 1,2,7」或「1 改成 音乐与乐器/完整配乐」即可。</p>',
             '<table><tr><th>组号</th><th>数量</th><th>建议分类</th><th>依据词</th><th>样例</th></tr>']
    for idx, ((level1, level2), items) in enumerate(ordered, start=1):
        sample = '<br>'.join(html.escape(name) for name, _ in items[:8])
        parts.append(f'<tr><td><b>{idx}</b></td><td>{len(items)}</td>'
                     f'<td>{html.escape(level1)} / {html.escape(level2)}</td>'
                     f'<td><code>{html.escape(items[0][1])}</code></td><td>{sample}</td></tr>')
    parts.append('</table>')
    html_path.write_text('\n'.join(parts), encoding='utf-8')

    for idx, ((level1, level2), items) in enumerate(ordered[:16], start=1):
        print(f'[{idx}] {len(items):4d} 条 → {level1} / {level2}   （依据: {items[0][1]}）')
        for name, _ in items[:3]:
            print(f'        {name}')
    print(f'\n报告: {html_path}')
    print(f'清单: {csv_path}')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
