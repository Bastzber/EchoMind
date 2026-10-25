# -*- coding: utf-8 -*-
"""方案 B 的准备：把「多类歧义」的文件按冲突分类对分组，方便一次决定一批。

输出形如：
  金属 ⟷ 脚步     412 条  样例: 皮鞋踩金属.wav / ...
这样每对冲突只需要一次决定，而不是逐条看。
"""
from __future__ import annotations

import json
import os
import sqlite3
import sys
from collections import Counter, defaultdict
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from keyword_classify import build_index, match, load_config, PENDING_DIRS, LIBRARY_ROOT


def main() -> int:
    config = load_config()
    index = build_index(config)

    db = Path(os.environ['APPDATA']) / 'EchoMind' / 'db' / 'soundmind.db'
    conn = sqlite3.connect(f'file:{db}?mode=ro', uri=True, timeout=60)
    rows = conn.execute("SELECT path FROM files WHERE project_id='default'").fetchall()
    conn.close()

    pairs = defaultdict(list)
    for (path,) in rows:
        parts = Path(path).parts
        if not any(x in PENDING_DIRS for x in parts):
            continue
        hits = match(Path(path).name, index)
        if len(hits) < 2:
            continue
        ranked = sorted(
            ((max((len(w) for w in words), default=0), target) for target, words in hits.items()),
            key=lambda item: -item[0],
        )
        best_len, best = ranked[0]
        second_len, second = ranked[1]
        key = tuple(sorted([f'{best[0]}/{best[1]}', f'{second[0]}/{second[1]}']))
        pairs[key].append(Path(path).name)

    print(f'冲突对: {len(pairs)} 种，覆盖 {sum(len(v) for v in pairs.values())} 个文件\n')
    ordered = sorted(pairs.items(), key=lambda kv: -len(kv[1]))
    for idx, (key, names) in enumerate(ordered[:18], start=1):
        print(f'[{idx}] {len(names):4d} 条   {key[0]}  ⟷  {key[1]}')
        for name in names[:3]:
            print(f'          {name}')
    tail = sum(len(v) for _, v in ordered[18:])
    print(f'\n其余 {len(ordered)-18} 种小冲突，共 {tail} 条')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
