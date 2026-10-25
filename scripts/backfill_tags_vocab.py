# -*- coding: utf-8 -*-
"""方案 B：从描述/文件名里匹配已有标签词表，给缺标签文件补标签。

比语义近邻可靠：描述里本来就会出现「合成器、氛围、旋律、空灵」这类词，
直接命中就能用，不需要猜。
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sqlite3
from collections import Counter
from datetime import datetime
from pathlib import Path

TARGET = 6
MIN_TAG_LEN = 2


def parse_tags(value: str) -> list:
    try:
        data = json.loads(value or '[]')
    except Exception:
        return []
    return [str(t).strip() for t in data if str(t).strip()]


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument('--apply', action='store_true')
    parser.add_argument('--limit', type=int, default=0)
    parser.add_argument('--show', type=int, default=10)
    args = parser.parse_args()

    db = Path(os.environ['APPDATA']) / 'EchoMind' / 'db' / 'soundmind.db'
    conn = sqlite3.connect(str(db), timeout=180)
    conn.execute('PRAGMA busy_timeout = 180000')
    rows = conn.execute(
        "SELECT file_uuid, COALESCE(tags,'[]'), filename, COALESCE(ai_description,'') "
        "FROM files WHERE project_id='default'"
    ).fetchall()

    # 词表 = 库里已经出现过的标签（只留长度 >=2 的实词）
    vocab = Counter()
    targets = []
    for uuid, tags_json, filename, description in rows:
        tags = parse_tags(tags_json)
        if len(tags) >= TARGET:
            for tag in tags:
                if len(tag) >= MIN_TAG_LEN:
                    vocab[tag] += 1
        else:
            targets.append((uuid, tags, filename, description))
    print(f'词表: {len(vocab)} 个标签，待补: {len(targets)}')
    if args.limit:
        targets = targets[: args.limit]

    # 长词优先，避免「短尾」把「短尾冲击」这类词盖住
    ordered_vocab = sorted(vocab, key=len, reverse=True)
    pattern = re.compile('|'.join(re.escape(tag) for tag in ordered_vocab))

    # 共现统计：已标注文件里，某个标签出现时其它标签的出现频率
    cooc = {}
    for _uuid, tags_json, _fn, _desc in rows:
        tags = parse_tags(tags_json)
        if len(tags) < TARGET:
            continue
        for tag in tags:
            bucket = cooc.setdefault(tag, Counter())
            for other in tags:
                if other != tag:
                    bucket[other] += 1

    def fill_cooccurring(base_tags, limit):
        """按共现概率给已命中的标签补位。"""
        scores = Counter()
        for tag in base_tags:
            bucket = cooc.get(tag)
            if not bucket:
                continue
            total = sum(bucket.values()) or 1
            for other, count in bucket.items():
                if other not in base_tags and len(other) >= MIN_TAG_LEN:
                    scores[other] += count / total
        picked = []
        for other, _score in scores.most_common():
            if len(picked) >= limit:
                break
            if any(other != x and (other in x or x in other) for x in base_tags + picked):
                continue
            picked.append(other)
        return picked

    stamp = datetime.now().strftime('%Y%m%d-%H%M%S')
    if args.apply:
        conn.execute(
            """CREATE TABLE IF NOT EXISTS tag_auto_backup (
                   file_uuid TEXT PRIMARY KEY, old_tags TEXT NOT NULL, new_tags TEXT NOT NULL,
                   created_at TEXT NOT NULL, batch TEXT NOT NULL)"""
        )
        conn.commit()

    filled = skipped = 0
    tag_hits = Counter()
    for index, (uuid, existing, filename, description) in enumerate(targets, start=1):
        text = f'{filename} {description}'
        found = set(pattern.findall(text))
        # 同一词根只留最长的：'呼啸' 与 '呼啸声' 只保留后者
        candidates = sorted(found, key=len, reverse=True)
        kept = []
        seen = set(existing)
        for tag in candidates:
            if tag in seen:
                continue
            if any(tag != other and (tag in other or other in tag) for other in kept):
                continue
            kept.append(tag)
            seen.add(tag)
        room = max(0, TARGET - len(existing))
        hits = kept[:room]
        if len(hits) < room:
            hits += fill_cooccurring(existing + hits, room - len(hits))
        if not hits:
            skipped += 1
            continue
        merged = list(existing) + hits
        if args.apply:
            conn.execute(
                "UPDATE files SET tags=?, updated_at=? WHERE file_uuid=?",
                (json.dumps(merged, ensure_ascii=False), datetime.now().isoformat(), uuid),
            )
            conn.execute(
                "INSERT OR REPLACE INTO tag_auto_backup VALUES (?,?,?,?,?)",
                (uuid, json.dumps(existing, ensure_ascii=False),
                 json.dumps(merged, ensure_ascii=False), datetime.now().isoformat(), stamp),
            )
        filled += 1
        for tag in hits:
            tag_hits[tag] += 1
        if index <= args.show:
            print(f'  {filename[:40]}: {existing} → +{hits}')
        if args.apply and index % 500 == 0:
            conn.commit()
            print(f'  ... {index}/{len(targets)}', flush=True)

    if args.apply:
        conn.commit()
        conn.execute("UPDATE file_artifacts SET state='stale' WHERE kind='text_vector'")
        conn.commit()
    conn.close()

    print(f'\n补标签 {filled}，无匹配 {skipped}（{filled/max(len(targets),1)*100:.0f}%）')
    print('最常命中的标签:', ', '.join(f'{t}({c})' for t, c in tag_hits.most_common(8)))
    if not args.apply:
        print('[DRY RUN] 未写数据库')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
