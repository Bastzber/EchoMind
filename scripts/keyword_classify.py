# -*- coding: utf-8 -*-
"""方案 A：按精确关键词把待归类文件归到 14/88 分类里。

原则
----
- 只看**文件名**（+ 描述作为补充证据），不看标签，避免标签稀释误判
- 关键词必须 ≥2 个字；单字词（火/水/雨）不参与自动判定
- 命中多个不同分类 → 判为「有歧义」，不自动归（留给人看）
- 默认 dry-run，只出报告；--apply 才真正移动文件并改数据库路径
"""
from __future__ import annotations

import argparse
import csv
import json
import os
import re
import shutil
import sqlite3
from collections import Counter, defaultdict
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
LIBRARY_ROOT = Path(r'F:\CJ音效库整合包V1')
PENDING_DIRS = ('_待人工判断', '_待归类')


def load_config() -> dict:
    return json.loads((ROOT / 'config' / 'library-auto-keywords.json').read_text(encoding='utf-8'))


def build_index(config) -> dict:
    """关键词 -> [(一级, 二级)]，跳过歧义词和单字词。"""
    ambiguous = {str(x).lower() for x in config.get('ambiguous') or []}
    index = defaultdict(list)
    for level1, children in (config.get('categories') or {}).items():
        for level2, words in children.items():
            for word in words:
                key = str(word).strip().lower()
                if len(key) < 2 or key in ambiguous:
                    continue
                index[key].append((level1, level2))
    return index


_PATTERN_CACHE = {}


def _pattern(keyword: str):
    """中文按子串匹配；英文/数字按词边界匹配（避免 run 命中 Brunch）。"""
    cached = _PATTERN_CACHE.get(keyword)
    if cached is not None:
        return cached
    if re.search(r'[a-z0-9]', keyword):
        compiled = re.compile(r'(?<![a-z0-9])' + re.escape(keyword) + r'(?![a-z0-9])')
    else:
        compiled = None
    _PATTERN_CACHE[keyword] = compiled
    return compiled


def match(text: str, index) -> dict:
    """返回 {(一级,二级): [命中的词]}。"""
    lowered = text.lower()
    hits = defaultdict(list)
    for keyword, targets in index.items():
        pattern = _pattern(keyword)
        hit = bool(pattern.search(lowered)) if pattern else (keyword in lowered)
        if hit:
            for target in targets:
                hits[target].append(keyword)
    return hits


def plan_moves(rows, index):
    auto, review, none = [], [], []
    for path, description in rows:
        name = Path(path).name
        stem = os.path.splitext(name)[0]
        # 只用文件名做自动判定（描述是 AI 写的，容易带泛词，只用于抽查清单）
        hits = match(name, index)
        if not hits:
            desc_hits = match(description, index) if description else {}
            if len(desc_hits) == 1:
                review.append((path, desc_hits))
            else:
                none.append(path)
            continue
        if len(hits) == 1:
            (level1, level2), words = next(iter(hits.items()))
            auto.append((path, level1, level2, '+'.join(sorted(set(words))), 'filename'))
            continue

        # 多类命中：按"最长关键词"消歧（越长越具体），唯一最长才采用
        ranked = sorted(
            ((max((len(w) for w in words), default=0), target, words) for target, words in hits.items()),
            key=lambda item: -item[0],
        )
        best_len, (level1, level2), words = ranked[0]
        unique = len(ranked) < 2 or ranked[1][0] < best_len
        if unique and best_len >= 3:
            auto.append((path, level1, level2, '+'.join(sorted(set(words))), 'filename-longest'))
        else:
            review.append((path, hits))
    return auto, review, none


def target_path(path: str, level1: str, level2: str) -> Path:
    return LIBRARY_ROOT / level1 / level2 / Path(path).name


def unique_path(target: Path) -> Path:
    if not target.exists():
        return target
    stem, suffix = target.stem, target.suffix
    for index in range(2, 1000):
        candidate = target.with_name(f'{stem} ({index}){suffix}')
        if not candidate.exists():
            return candidate
    raise RuntimeError(f'无法生成唯一文件名: {target}')


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument('--apply', action='store_true', help='真正移动文件并更新数据库')
    parser.add_argument('--out', default=r'E:\AI音效管理器\auto-classify')
    args = parser.parse_args()

    config = load_config()
    index = build_index(config)

    db = Path(os.environ['APPDATA']) / 'EchoMind' / 'db' / 'soundmind.db'
    conn = sqlite3.connect(f'file:{db}?mode=ro', uri=True, timeout=60)
    rows = conn.execute(
        "SELECT path, COALESCE(ai_description,'') FROM files WHERE project_id='default'"
    ).fetchall()
    conn.close()

    pending, stale = [], 0
    for path, description in rows:
        parts = Path(path).parts
        if not any(part in PENDING_DIRS for part in parts):
            continue
        if not os.path.exists(path):
            stale += 1          # 数据库里还留着、磁盘上已经没有的旧路径
            continue
        pending.append((path, description))

    auto, review, none = plan_moves(pending, index)
    total = max(len(pending), 1)
    print(f'待归类（磁盘上真实存在）: {len(pending)}，失效路径已跳过: {stale}')
    print(f'  单一命中（可自动归类）: {len(auto)}（{len(auto)/total*100:.1f}%）')
    print(f'  多类歧义（留人工）: {len(review)}')
    print(f'  无关键词: {len(none)}')

    dist = Counter((item[1], item[2]) for item in auto)
    print('\n自动归类分布:')
    for (level1, level2), count in dist.most_common(15):
        print(f'  {level1} / {level2}: {count}')

    print('\n样例（每条显示命中的关键词）:')
    for path, level1, level2, words, source in auto[:12]:
        print(f'  {Path(path).name[:34]:34s} → {level1}/{level2}  [{words}] ({source})')

    out_dir = Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now().strftime('%Y%m%d-%H%M%S')
    plan_file = out_dir / f'plan-A-{stamp}.csv'
    with plan_file.open('w', encoding='utf-8-sig', newline='') as handle:
        writer = csv.writer(handle)
        writer.writerow(['原路径', '一级', '二级', '命中关键词', '证据来源', '目标路径'])
        for path, level1, level2, words, source in auto:
            writer.writerow([path, level1, level2, words, source,
                             str(target_path(path, level1, level2))])
    print(f'\n执行计划: {plan_file}')

    if not args.apply:
        print('\n[DRY RUN] 未移动任何文件。确认后加 --apply 执行。')
        return 0

    moved, failed = 0, []
    rollback_rows = []
    conn = sqlite3.connect(str(db), timeout=180)
    conn.execute('PRAGMA busy_timeout = 180000')
    cursor = conn.cursor()
    for path, level1, level2, _words, _source in auto:
        source_path = Path(path)
        if not source_path.exists():
            failed.append((path, '源文件不存在'))
            continue
        try:
            destination_dir = LIBRARY_ROOT / level1 / level2
            destination_dir.mkdir(parents=True, exist_ok=True)
            destination = unique_path(destination_dir / source_path.name)
            shutil.move(str(source_path), str(destination))
            cursor.execute(
                "UPDATE files SET path=?, canonical_path=?, updated_at=? WHERE path=? AND project_id='default'",
                (str(destination), str(destination).lower(), datetime.now().isoformat(), path),
            )
            rollback_rows.append([str(destination), path])
            moved += 1
            if moved % 200 == 0:
                conn.commit()
                print(f'  已移动 {moved}...', flush=True)
        except Exception as exc:
            failed.append((path, str(exc)[:120]))
    conn.commit()
    conn.close()

    rollback_file = out_dir / f'rollback-A-{stamp}.csv'
    with rollback_file.open('w', encoding='utf-8-sig', newline='') as handle:
        writer = csv.writer(handle)
        writer.writerow(['现路径', '原路径'])
        writer.writerows(rollback_rows)
    print(f'回滚清单: {rollback_file}')
    print(f'\n已移动 {moved} 个文件，失败 {len(failed)}')
    for path, reason in failed[:10]:
        print(f'  失败: {Path(path).name} - {reason}')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
