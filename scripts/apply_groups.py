# -*- coding: utf-8 -*-
"""方案 B：按批准的分组搬文件（--groups 1,2,3 或 --all）。"""
from __future__ import annotations

import argparse
import csv
import glob
import os
import shutil
import sqlite3
from datetime import datetime
from pathlib import Path

LIBRARY_ROOT = Path(r'F:\CJ音效库整合包V1')


def latest_csv() -> str:
    files = sorted(glob.glob(r'E:\AI音效管理器\auto-classify\groups-B-*.csv'))
    if not files:
        raise SystemExit('找不到分组 CSV，先跑 scripts/group_approval.py')
    return files[-1]


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
    parser.add_argument('--groups', default='', help='批准通过的组号，如 1,2,7')
    parser.add_argument('--all', action='store_true')
    args = parser.parse_args()

    approved = set()
    if args.all:
        approved = {'all'}
    else:
        approved = {x.strip() for x in args.groups.split(',') if x.strip()}
    if not approved:
        raise SystemExit('请用 --groups 1,2 或 --all 指定批准的组')

    path = latest_csv()
    print('分组文件:', path)
    rows = []
    with open(path, encoding='utf-8-sig', newline='') as handle:
        for row in csv.DictReader(handle):
            if 'all' in approved or row['组号'] in approved:
                rows.append(row)
    print('批准条目:', len(rows))

    db = Path(os.environ['APPDATA']) / 'EchoMind' / 'db' / 'soundmind.db'
    conn = sqlite3.connect(str(db), timeout=180)
    conn.execute('PRAGMA busy_timeout = 180000')
    cursor = conn.cursor()

    all_paths = {}
    for uuid, p in cursor.execute("SELECT file_uuid, path FROM files WHERE project_id='default'"):
        all_paths.setdefault(Path(p).name, []).append((uuid, p))

    moved, failed, rollback = 0, [], []
    stamp = datetime.now().strftime('%Y%m%d-%H%M%S')
    for row in rows:
        name = row['文件名']
        candidates = all_paths.get(name) or []
        target = None
        for uuid, p in candidates:
            if not os.path.exists(p):
                continue
            parts = Path(p).parts
            if any(x in ('_待人工判断', '_待归类') for x in parts):
                target = (uuid, p)
                break
        if not target:
            failed.append((name, '找不到待归类源文件'))
            continue
        uuid, source = target
        destination_dir = LIBRARY_ROOT / row['建议一级'] / row['建议二级']
        try:
            destination_dir.mkdir(parents=True, exist_ok=True)
            destination = unique_path(destination_dir / Path(source).name)
            shutil.move(source, str(destination))
            cursor.execute(
                "UPDATE files SET path=?, canonical_path=?, updated_at=? WHERE file_uuid=?",
                (str(destination), str(destination).lower(), datetime.now().isoformat(), uuid),
            )
            rollback.append([str(destination), source])
            moved += 1
            if moved % 200 == 0:
                conn.commit()
                print(f'  已移动 {moved}...', flush=True)
        except Exception as exc:
            failed.append((name, str(exc)[:120]))
    conn.commit()
    conn.close()

    out = Path(r'E:\AI音效管理器\auto-classify') / f'rollback-B-{stamp}.csv'
    with out.open('w', encoding='utf-8-sig', newline='') as handle:
        writer = csv.writer(handle)
        writer.writerow(['现路径', '原路径'])
        writer.writerows(rollback)
    print(f'\n已移动 {moved}，失败 {len(failed)}')
    print('回滚清单:', out)
    for name, reason in failed[:5]:
        print('  失败:', name, reason)
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
