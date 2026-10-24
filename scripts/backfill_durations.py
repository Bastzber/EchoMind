#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""回填 files.duration：音频时长（秒）。

背景：导入时大量文件把 duration 写成了 0（实测一个 4.07 秒的 wav 在库里是 0），
导致列表显示 00:00.000、按时长排序全乱。这里重新读文件头把时长补上。

用法：python scripts/backfill_durations.py [--db PATH] [--limit N]
"""
from __future__ import annotations

import argparse
import os
import sqlite3
import sys
import time
import wave

AUDIO_PROBE_SUFFIXES = {'.wav', '.mp3', '.m4a', '.aac', '.flac', '.ogg', '.wma', '.aif', '.aiff', '.opus'}


def probe_duration(path: str) -> float | None:
    suffix = os.path.splitext(path)[1].lower()
    if suffix not in AUDIO_PROBE_SUFFIXES:
        return None
    try:
        if suffix == '.wav':
            with wave.open(path, 'rb') as handle:
                rate = handle.getframerate() or 1
                return handle.getnframes() / rate
        from mutagen import File as MutagenFile
        audio = MutagenFile(path)
        info = getattr(audio, 'info', None)
        if info is not None and getattr(info, 'length', None):
            return float(info.length)
    except Exception:
        return None
    return None


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument('--db', default=os.path.join(os.environ['APPDATA'], 'EchoMind', 'db', 'soundmind.db'))
    parser.add_argument('--limit', type=int, default=0, help='只处理前 N 条（调试用）')
    args = parser.parse_args()

    if not os.path.exists(args.db):
        print('数据库不存在:', args.db)
        return 1

    conn = sqlite3.connect(args.db, timeout=60)
    conn.execute('PRAGMA busy_timeout = 60000')
    cursor = conn.cursor()

    sql = "SELECT file_uuid, path FROM files WHERE duration IS NULL OR duration <= 0"
    if args.limit:
        sql += ' LIMIT %d' % args.limit
    rows = cursor.execute(sql).fetchall()
    print('待回填: %d 条' % len(rows))

    updated = 0
    failed = 0
    started = time.time()
    batch = []
    for index, (file_uuid, path) in enumerate(rows, 1):
        duration = probe_duration(path)
        if duration and duration > 0:
            batch.append((duration, file_uuid))
        else:
            failed += 1
        if len(batch) >= 200:
            cursor.executemany("UPDATE files SET duration=? WHERE file_uuid=?", batch)
            conn.commit()
            updated += len(batch)
            batch.clear()
            print('  已处理 %d / %d（成功 %d，失败 %d，%.0fs）'
                  % (index, len(rows), updated, failed, time.time() - started), flush=True)
    if batch:
        cursor.executemany("UPDATE files SET duration=? WHERE file_uuid=?", batch)
        conn.commit()
        updated += len(batch)

    print('完成：回填 %d 条，读不出时长 %d 条，耗时 %.0fs'
          % (updated, failed, time.time() - started))
    conn.close()
    return 0


if __name__ == '__main__':
    sys.exit(main())
