# -*- coding: utf-8 -*-
"""方案 B：把「只能靠描述判断」的待归类文件按建议分类分组。"""
from __future__ import annotations

import json
import os
import sqlite3
import sys
from collections import Counter, defaultdict
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from keyword_classify import build_index, match, load_config, PENDING_DIRS


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
    pending = 0
    for path, description in rows:
        parts = Path(path).parts
        if not any(x in PENDING_DIRS for x in parts):
            continue
        pending += 1
        if match(Path(path).name, index):
            continue  # 文件名已能判断，不在这里
        if not description:
            continue
        hits = match(description, index)
        if len(hits) != 1:
            continue
        (level1, level2), words = next(iter(hits.items()))
        groups[(level1, level2)].append(Path(path).name)

    covered = sum(len(v) for v in groups.values())
    print(f'待归类 {pending} 个，其中「文件名无语义、靠描述可分」: {covered} 个，分 {len(groups)} 组\n')
    for idx, ((level1, level2), names) in enumerate(sorted(groups.items(), key=lambda kv: -len(kv[1]))[:20], start=1):
        print(f'[{idx}] {len(names):4d} 条  →  {level1} / {level2}')
        for name in names[:3]:
            print(f'          {name}')
    print(f'\n其余 {max(0, len(groups)-20)} 组共 {sum(len(v) for k, v in sorted(groups.items(), key=lambda kv: -len(kv[1]))[20:])} 条')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
