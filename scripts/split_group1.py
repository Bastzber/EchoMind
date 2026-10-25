# -*- coding: utf-8 -*-
"""第 1 组（1817 条「提示音」）细分：按描述里的二级信号再分组。"""
from __future__ import annotations

import csv
import glob
import os
import re
import sqlite3
from collections import Counter, defaultdict
from pathlib import Path

RULES = [
    ('转场/上升',   r'转场|过渡|上升|渐强|riser|sweep up|汇聚'),
    ('转场/下沉',   r'下降|渐弱|下沉|fall|drop down'),
    ('转场/掠过',   r'掠过|呼啸|whoosh|swish'),
    ('扫描与数据',  r'扫描|科技感|数据|雷达|科技|scan|sci-?fi'),
    ('循环与节奏',  r'循环|loop|重复|持续地'),
    ('通讯',        r'电话|来电|拨号|挂断|铃声|短信|message tone|ringtone'),
    ('按钮交互',    r'点击|按下|按钮|click|tap|按键'),
    ('游戏与卡通',  r'游戏|卡通|金币|升级|game|cartoon|8-?bit'),
    ('数字故障',    r'故障|glitch|电流|干扰|失真'),
    ('机器人/机械', r'机器人|机械|伺服|robot|servo|马达'),
    ('魔法/能量',   r'魔法|能量|充能|魔法阵|激光|energy'),
    ('撞击/摩擦',   r'撞击|碰撞|敲击|摩擦|impact|hit'),
    ('界面音',      r'界面|UI|提示|通知|反馈|系统音|beep|notify|alert'),
]


def main() -> int:
    path = sorted(glob.glob(r'E:\AI音效管理器\auto-classify\groups-B-*.csv'))[-1]
    names = []
    with open(path, encoding='utf-8-sig', newline='') as handle:
        for row in csv.DictReader(handle):
            if row['组号'] == '1':
                names.append(row['文件名'])
    print('第 1 组文件数:', len(names))
    wanted = set(names)

    db = Path(os.environ['APPDATA']) / 'EchoMind' / 'db' / 'soundmind.db'
    conn = sqlite3.connect(f'file:{db}?mode=ro', uri=True, timeout=60)
    rows = conn.execute(
        "SELECT path, COALESCE(ai_description,'') FROM files WHERE project_id='default'"
    ).fetchall()
    conn.close()

    buckets = defaultdict(list)
    for path, description in rows:
        name = Path(path).name
        if name not in wanted:
            continue
        matched = False
        for label, pattern in RULES:
            if re.search(pattern, description, re.IGNORECASE):
                buckets[label].append((name, description))
                matched = True
                break
        if not matched:
            buckets['其他'].append((name, description))

    total = sum(len(v) for v in buckets.values())
    print(f'可细分 {total} 条\n')
    for label, items in sorted(buckets.items(), key=lambda kv: -len(kv[1])):
        print(f'{len(items):5d} 条  {label}')
        for name, desc in items[:3]:
            print(f'         {name}  |  {desc[:44]}')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
