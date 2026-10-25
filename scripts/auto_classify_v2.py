# -*- coding: utf-8 -*-
"""自动分类 v2：两级判断（标签 → 一级 → 二级），并用留出法实测准确率。

为什么分两级
------------
直接对 88 个二级分类算概率，标签证据会被摊薄（实测只有 17% 能过阈值）。
先定 14 个一级（信号强、混淆少），再在选中的一级里挑二级，覆盖率和准确率都高得多。
"""
from __future__ import annotations

import argparse
import csv
import json
import math
import os
import random
import sqlite3
from collections import Counter, defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
LIBRARY_ROOT = Path(r'F:\CJ音效库整合包V1')
PENDING_DIRS = ('_待人工判断', '_待归类')
SMOOTH = 0.5


def load_json(name: str) -> dict:
    return json.loads((ROOT / 'config' / name).read_text(encoding='utf-8'))


def split_relative(path: str) -> list:
    try:
        return list(Path(path).relative_to(LIBRARY_ROOT).parts)
    except ValueError:
        return []


class Model:
    def __init__(self, rows, taxonomy):
        self.taxonomy = taxonomy
        self.tag_level1 = defaultdict(Counter)
        self.tag_level2 = defaultdict(Counter)
        self.level1_counts = Counter()

        for path, tags in rows:
            parts = split_relative(path)
            if len(parts) < 3:
                continue
            level1, level2 = parts[0], parts[1]
            if level2 not in taxonomy.get(level1, []):
                continue
            self.level1_counts[level1] += 1
            for tag in tags:
                self.tag_level1[tag][level1] += 1
                self.tag_level2[(level1, tag)][level2] += 1

        self.level1_total = sum(self.level1_counts.values()) or 1
        self.tag_level1_prob = self._normalise(self.tag_level1, len(taxonomy))
        self.tag_level2_prob = self._normalise_2()

    def _normalise(self, table, vocab):
        out = {}
        for tag, counter in table.items():
            total = sum(counter.values())
            out[tag] = {k: (v + SMOOTH) / (total + SMOOTH * vocab) for k, v in counter.items()}
        return out

    def _normalise_2(self):
        out = {}
        for (level1, tag), counter in self.tag_level2.items():
            total = sum(counter.values())
            vocab = max(len(self.taxonomy.get(level1, [])), 1)
            out[(level1, tag)] = {k: (v + SMOOTH) / (total + SMOOTH * vocab) for k, v in counter.items()}
        return out

    def predict(self, tags, text: str, rules):
        # ---- 一级 ----
        level1_scores = defaultdict(float)
        for tag in tags:
            for level1, probability in self.tag_level1_prob.get(tag, {}).items():
                level1_scores[level1] += math.log(probability)
        for rule in rules:
            target = tuple(rule.get('t') or ())
            if len(target) == 2 and target[0] in self.taxonomy:
                if any(str(k).lower() in text for k in rule.get('k') or []):
                    level1_scores[target[0]] += 2.0
        if not level1_scores:
            return None

        ranked1 = sorted(level1_scores.items(), key=lambda item: -item[1])
        level1 = ranked1[0][0]
        margin1 = ranked1[0][1] - (ranked1[1][1] if len(ranked1) > 1 else -99.0)

        # ---- 二级（只在选中的一级里挑）----
        level2_scores = defaultdict(float)
        for tag in tags:
            for level2, probability in self.tag_level2_prob.get((level1, tag), {}).items():
                level2_scores[level2] += math.log(probability)
        for rule in rules:
            target = tuple(rule.get('t') or ())
            if len(target) == 2 and target[0] == level1:
                if any(str(k).lower() in text for k in rule.get('k') or []):
                    level2_scores[target[1]] += 2.0
        if not level2_scores:
            return None

        ranked2 = sorted(level2_scores.items(), key=lambda item: -item[1])
        level2 = ranked2[0][0]
        margin2 = ranked2[0][1] - (ranked2[1][1] if len(ranked2) > 1 else -99.0)
        return level1, level2, margin1, margin2


def evaluate(model, rows, rules, sample: int = 4000) -> None:
    """留出法：80% 训练，20% 评估。"""
    print('\n=== 留出法评估 ===')
    random.seed(42)
    picked = random.sample(rows, min(sample, len(rows)))
    split = int(len(picked) * 0.8)
    train, test = picked[:split], picked[split:]
    trained = Model(train, model.taxonomy)

    stats = Counter()
    good1 = good2 = 0
    by_margin = defaultdict(lambda: [0, 0, 0])  # [总数, 一级对, 二级对]
    for path, tags in test:
        parts = split_relative(path)
        if len(parts) < 3:
            continue
        truth1, truth2 = parts[0], parts[1]
        text = (os.path.basename(path) + ' ' + ' '.join(tags)).lower()
        result = trained.predict(tags, text, rules)
        stats['total'] += 1
        if not result:
            stats['no_evidence'] += 1
            continue
        level1, level2, margin1, margin2 = result
        ok1 = level1 == truth1
        ok2 = ok1 and level2 == truth2
        good1 += ok1
        good2 += ok2
        bucket = 'm1>=2' if margin1 >= 2 else ('m1>=1' if margin1 >= 1 else 'm1<1')
        by_margin[bucket][0] += 1
        by_margin[bucket][1] += ok1
        by_margin[bucket][2] += ok2

    total = max(stats['total'], 1)
    print(f'测试样本: {total}，无证据: {stats["no_evidence"]}')
    print(f'一级准确率: {good1/total*100:.1f}%')
    print(f'二级准确率: {good2/total*100:.1f}%')
    print('按一级置信度分档:')
    for bucket in ('m1>=2', 'm1>=1', 'm1<1'):
        n, a1, a2 = by_margin[bucket]
        if n:
            print(f'  {bucket}: {n} 条，一级 {a1/n*100:.0f}%，二级 {a2/n*100:.0f}%')


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument('--out', default=r'E:\AI音效管理器\auto-classify')
    parser.add_argument('--min-margin', type=float, default=1.0)
    args = parser.parse_args()

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

    print(f'已归类样本: {len(classified)}，待归类: {len(pending)}')
    model = Model(classified, taxonomy)
    print(f'标签词表: {len(model.tag_level1_prob)}')

    evaluate(model, classified, rules)

    # ---- 对待归类出提案 ----
    proposals, unknown = [], 0
    for path, tags, description in pending:
        text = (os.path.basename(path) + ' ' + (description or '') + ' ' + ' '.join(tags)).lower()
        result = model.predict(tags, text, rules)
        if not result:
            unknown += 1
            proposals.append((path, '', '', 0.0, 'unknown'))
            continue
        level1, level2, margin1, margin2 = result
        status = 'auto' if margin1 >= args.min_margin else 'review'
        proposals.append((path, level1, level2, round(margin1, 2), status))

    auto = [p for p in proposals if p[4] == 'auto']
    review = [p for p in proposals if p[4] == 'review']
    print(f'\n待归类 {len(pending)} 条：')
    print(f'  可自动归类: {len(auto)}（{len(auto)/max(len(pending),1)*100:.1f}%）')
    print(f'  需抽查: {len(review)}')
    print(f'  无证据: {unknown}')

    dist = Counter((p[1], p[2]) for p in auto)
    print('\n自动归类分布（Top 10）:')
    for (l1, l2), count in dist.most_common(10):
        print(f'  {l1} / {l2}: {count}')

    out_dir = Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)
    target = out_dir / 'proposals-v2.csv'
    with target.open('w', encoding='utf-8-sig', newline='') as handle:
        writer = csv.writer(handle)
        writer.writerow(['路径', '一级', '二级', '置信度', '状态'])
        for row in proposals:
            writer.writerow(row)
    print(f'\n提案: {target}')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
