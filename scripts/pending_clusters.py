# -*- coding: utf-8 -*-
"""把待归类文件聚成组：按预测的一级分类分组，给出文件数与样例。

目的：把「16,000 条逐条判断」变成「十几个组各点一次」。
"""
from __future__ import annotations

import json
import os
import sqlite3
import sys
from collections import Counter, defaultdict
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from auto_classify_v2 import Model, load_json, split_relative, PENDING_DIRS, LIBRARY_ROOT


def main() -> int:
    taxonomy = load_json('library-taxonomy.json').get('categories') or {}
    rules = load_json('library-keywords.json').get('rules') or []

    db = Path(os.environ['APPDATA']) / 'EchoMind' / 'db' / 'soundmind.db'
    conn = sqlite3.connect(f'file:{db}?mode=ro', uri=True, timeout=60)
    raw = conn.execute(
        "SELECT path, tags, COALESCE(ai_description,'') FROM files WHERE project_id='default'"
    ).fetchall()
    conn.close()

    def parse_tags(value):
        try:
            data = json.loads(value or '[]')
            return [t.strip() for t in data if isinstance(t, str) and t.strip()]
        except Exception:
            return []

    classified, pending = [], []
    for path, tags_json, description in raw:
        parts = split_relative(path)
        if not parts:
            continue
        tags = parse_tags(tags_json)
        if len(parts) >= 3 and parts[1] in taxonomy.get(parts[0], []):
            classified.append((path, tags))
        elif parts[0] in PENDING_DIRS:
            pending.append((path, tags, description))

    model = Model(classified, taxonomy)

    groups = defaultdict(list)
    unknown = []
    for path, tags, description in pending:
        text = (os.path.basename(path) + ' ' + (description or '') + ' ' + ' '.join(tags)).lower()
        result = model.predict(tags, text, rules)
        if not result:
            unknown.append(path)
            continue
        level1, level2, margin1, _ = result
        groups[(level1, level2)].append((path, margin1))

    print(f'待归类 {len(pending)} 条 → 分成 {len(groups)} 组 + 无证据 {len(unknown)} 条')
    print()
    ordered = sorted(groups.items(), key=lambda kv: -len(kv[1]))
    for (level1, level2), items in ordered[:20]:
        strong = sum(1 for _, m in items if m >= 2)
        print(f'{len(items):5d} 条  {level1} / {level2}   （高置信 {strong}）')
        for path, _ in items[:3]:
            rel = Path(path).relative_to(LIBRARY_ROOT) if str(path).startswith(str(LIBRARY_ROOT)) else Path(path).name
            print(f'        {rel}')
    weak = sum(len(v) for k, v in ordered if len(v) <= 3)
    print(f'\n小组（≤3 条）合计: {weak} 条，分布在 {sum(1 for k, v in ordered if len(v) <= 3)} 组')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
