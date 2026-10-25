# -*- coding: utf-8 -*-
"""自动分类：用库内已归类的文件学习「标签 → 二级分类」，再给待归类文件打分。

思路
----
1. 已归类样本：路径形如 库根 / 一级 / 二级 / ... / 文件名
2. 对每个标签（大羽 6 维标注）统计它出现在各二级分类里的次数 → 条件概率
3. 待归类文件：把它的标签逐个查表，累加对数概率，取最高分的二级分类
4. 置信度 = 最高分与次高分的差距；低于阈值就留给人工

只做预测，不移动文件（--apply 才动）。
"""
from __future__ import annotations

import argparse
import csv
import json
import math
import os
import sqlite3
import sys
from collections import Counter, defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
LIBRARY_ROOT = Path(r'F:\CJ音效库整合包V1')
PENDING_DIRS = ('_待人工判断', '_待归类')


def load_taxonomy() -> dict:
    data = json.loads((ROOT / 'config' / 'library-taxonomy.json').read_text(encoding='utf-8'))
    return data.get('categories') or {}


def load_keyword_rules() -> list:
    data = json.loads((ROOT / 'config' / 'library-keywords.json').read_text(encoding='utf-8'))
    return data.get('rules') or []


def split_relative(path: str) -> list:
    try:
        rel = Path(path).relative_to(LIBRARY_ROOT)
    except ValueError:
        return []
    return list(rel.parts)


def classify_existing(rows, taxonomy) -> dict:
    """把已归类文件按 (一级, 二级) 归组，返回 {(一级, 二级): {tag: count}}。"""
    buckets = defaultdict(Counter)
    known = set()
    for level1, children in taxonomy.items():
        for child in children:
            known.add((level1, child))

    for path, tags_json in rows:
        parts = split_relative(path)
        if len(parts) < 3:
            continue
        key = (parts[0], parts[1])
        if key not in known:
            continue
        try:
            tags = json.loads(tags_json or '[]')
        except Exception:
            continue
        if not isinstance(tags, list):
            continue
        bucket = buckets[key]
        for tag in tags:
            if isinstance(tag, str) and tag.strip():
                bucket[tag.strip()] += 1
    return buckets


def build_tag_model(buckets) -> dict:
    """tag -> {category: probability}，并做拉普拉斯平滑。"""
    tag_counts = defaultdict(Counter)
    category_totals = Counter()
    for category, counter in buckets.items():
        total = sum(counter.values())
        category_totals[category] = total
        for tag, count in counter.items():
            tag_counts[tag][category] += count

    categories = list(buckets.keys())
    vocab = max(len(categories), 1)
    model = {}
    for tag, distribution in tag_counts.items():
        total = sum(distribution.values())
        model[tag] = {
            category: (distribution.get(category, 0) + 0.5) / (total + 0.5 * vocab)
            for category in categories
        }
    return model, category_totals


def keyword_scores(text: str, rules) -> dict:
    """关键词规则打分（长词优先，命中即加）。"""
    scores = Counter()
    lowered = text.lower()
    for rule in rules:
        target = tuple(rule.get('t') or ())
        if len(target) != 2:
            continue
        for keyword in rule.get('k') or []:
            kw = str(keyword).lower()
            if kw and kw in lowered:
                scores[target] += 1
    return scores


def score_file(path: str, tags, description: str, model, category_totals, rules) -> list:
    scores = defaultdict(float)
    filename = os.path.basename(path)
    text = f"{filename} {description or ''}"

    # 标签证据
    for tag in tags or []:
        table = model.get(tag)
        if not table:
            continue
        for category, probability in table.items():
            scores[category] += math.log(probability)

    # 关键词证据（权重相当于 3 个标签）
    for category, hits in keyword_scores(text, rules).items():
        if category in category_totals:
            scores[category] += 2.5 * hits

    if not scores:
        return []
    ranked = sorted(scores.items(), key=lambda item: -item[1])
    return ranked


def normalise(ranked) -> list:
    if not ranked:
        return []
    top = ranked[0][1]
    out = []
    for category, score in ranked[:3]:
        out.append((category, score - top))
    return out


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument('--threshold', type=float, default=1.2,
                        help='置信度阈值：最高分领先次高分多少分才采用（对数概率差）')
    parser.add_argument('--out', default=r'E:\AI音效管理器\auto-classify')
    parser.add_argument('--limit', type=int, default=0)
    args = parser.parse_args()

    db = Path(os.environ['APPDATA']) / 'EchoMind' / 'db' / 'soundmind.db'
    conn = sqlite3.connect(f'file:{db}?mode=ro', uri=True, timeout=60)
    rows = conn.execute(
        "SELECT path, tags, COALESCE(ai_description,'') FROM files WHERE project_id='default'"
    ).fetchall()
    conn.close()

    taxonomy = load_taxonomy()
    rules = load_keyword_rules()
    buckets = classify_existing([(r[0], r[1]) for r in rows], taxonomy)
    model, category_totals = build_tag_model(buckets)

    print(f'已归类样本分类数: {len(buckets)}，标签数: {len(model)}')

    pending = []
    for path, tags_json, description in rows:
        parts = split_relative(path)
        if not parts or parts[0] not in PENDING_DIRS:
            continue
        try:
            tags = json.loads(tags_json or '[]')
        except Exception:
            tags = []
        ranked = score_file(path, tags, description, model, category_totals, rules)
        if not ranked:
            pending.append((path, None, None, 0.0, 0.0))
            continue
        norm = normalise(ranked)
        best = norm[0]
        margin = 0.0 if len(ranked) < 2 else (ranked[0][1] - ranked[1][1])
        pending.append((path, best[0][0], best[0][1], margin, ranked[0][1]))

    total = len(pending)
    confident = [item for item in pending if item[1] and item[3] >= args.threshold]
    weak = [item for item in pending if item[1] and 0 < item[3] < args.threshold]
    unknown = [item for item in pending if not item[1]]

    print(f'待归类总数: {total}')
    print(f'  高置信可自动归类: {len(confident)}（{len(confident)/max(total,1)*100:.1f}%）')
    print(f'  低置信（建议人工抽查）: {len(weak)}')
    print(f'  无证据: {len(unknown)}')

    by_category = Counter((item[1], item[2]) for item in confident)
    print('\n高置信分布（Top 12）:')
    for (level1, level2), count in by_category.most_common(12):
        print(f'  {level1} / {level2}: {count}')

    out_dir = Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)
    proposal = out_dir / 'proposals.csv'
    with proposal.open('w', encoding='utf-8-sig', newline='') as handle:
        writer = csv.writer(handle)
        writer.writerow(['路径', '建议一级', '建议二级', '置信度', '原始分数', '状态'])
        for path, level1, level2, margin, raw in pending:
            status = 'auto' if (level1 and margin >= args.threshold) else ('review' if level1 else 'unknown')
            writer.writerow([path, level1 or '', level2 or '', f'{margin:.2f}', f'{raw:.2f}', status])
    print(f'\n提案已写入: {proposal}')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
