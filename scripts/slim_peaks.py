# -*- coding: utf-8 -*-
"""把 files.peaks_json 压成紧凑格式（3 位小数 + 无空格），把库瘦下来。

背景（2026-11-10 实测）：
    peaks_json 平均 39.8 KB/条，65149 条 = 2.62 GB，占 3.32 GB 主库的 79%。
    原因是 json.dumps(float32 序列) 会把 float32 展开成 17 位有效数字
    （3.1982603104552254e-05）。渲染端只画 2000 个像素柱，3 位小数足够。

做法：
    逐条读 peaks_json -> round(3) -> json.dumps(separators=(',',':'))，
    分批提交，只更新确实变短的行。可重复跑，跑第二次不会再有改动。

用法：
    python scripts/slim_peaks.py --dry-run          # 只量尺寸，不写库
    python scripts/slim_peaks.py --apply            # 真写
    python scripts/slim_peaks.py --apply --vacuum   # 写完顺手 VACUUM 回收空间

注意：
    写之前先停掉 EchoMind 和 soundbot-backend，否则 VACUUM 拿不到独占锁。
    先复制一份 soundmind.db 再动，回滚就是拷回去。
"""

from __future__ import annotations

import argparse
import json
import os
import sqlite3
import sys
import time
from pathlib import Path

BATCH = 500
DECIMALS = 3


def default_db_path() -> Path:
    appdata = os.environ.get("APPDATA") or str(Path.home() / "AppData" / "Roaming")
    return Path(appdata) / "EchoMind" / "db" / "soundmind.db"


def slim(peaks_raw: str) -> str:
    values = json.loads(peaks_raw)
    if not isinstance(values, list):
        raise ValueError("peaks_json 不是数组")
    return json.dumps(
        [round(float(value), DECIMALS) for value in values],
        separators=(",", ":"),
    )


def main() -> int:
    parser = argparse.ArgumentParser(description="压缩 files.peaks_json")
    parser.add_argument("--db", default=str(default_db_path()), help="soundmind.db 路径")
    parser.add_argument("--apply", action="store_true", help="真写库（默认只统计）")
    parser.add_argument("--dry-run", action="store_true", help="只统计（默认行为）")
    parser.add_argument("--vacuum", action="store_true", help="写完后 VACUUM 回收空间")
    parser.add_argument("--batch", type=int, default=BATCH)
    args = parser.parse_args()

    db_path = Path(args.db)
    if not db_path.exists():
        print(f"[失败] 找不到库: {db_path}")
        return 2

    write_mode = args.apply and not args.dry_run
    conn = sqlite3.connect(str(db_path), timeout=120)
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA synchronous=NORMAL")
    cursor = conn.cursor()

    total_before = cursor.execute(
        "SELECT COALESCE(SUM(LENGTH(peaks_json)), 0) FROM files WHERE peaks_json IS NOT NULL"
    ).fetchone()[0]
    rows_total = cursor.execute(
        "SELECT COUNT(*) FROM files WHERE peaks_json IS NOT NULL"
    ).fetchone()[0]
    print(f"库      : {db_path}")
    print(f"体积    : {db_path.stat().st_size / 1e9:.2f} GB")
    print(f"待处理  : {rows_total} 条，peaks_json 合计 {total_before / 1e9:.3f} GB")
    print(f"模式    : {'写入' if write_mode else '只统计（--apply 才写）'}")

    if not rows_total:
        print("没有 peaks_json，收工")
        return 0

    started = time.time()
    last_id = 0
    seen = 0
    changed = 0
    after_total = 0
    errors = 0
    pending = []

    while True:
        batch = cursor.execute(
            "SELECT id, peaks_json FROM files "
            "WHERE peaks_json IS NOT NULL AND id > ? ORDER BY id LIMIT ?",
            (last_id, args.batch),
        ).fetchall()
        if not batch:
            break
        for row_id, raw in batch:
            last_id = row_id
            seen += 1
            try:
                compact = slim(raw)
            except Exception as exc:  # 脏数据跳过，不拖垮整轮
                errors += 1
                if errors <= 5:
                    print(f"  [跳过] id={row_id} {exc}")
                after_total += len(raw)
                continue
            after_total += len(compact)
            if len(compact) < len(raw):
                changed += 1
                if write_mode:
                    pending.append((compact, row_id))
        if write_mode and pending:
            cursor.executemany("UPDATE files SET peaks_json=? WHERE id=?", pending)
            conn.commit()
            pending.clear()
        if seen % 5000 < args.batch:
            rate = seen / max(time.time() - started, 0.001)
            print(f"  ... {seen}/{rows_total} 条  {rate:.0f} 条/秒  "
                  f"已省 {(total_before - after_total) / 1e9:.2f} GB")

    if write_mode and pending:
        cursor.executemany("UPDATE files SET peaks_json=? WHERE id=?", pending)
        conn.commit()

    elapsed = time.time() - started
    saved = total_before - after_total
    print()
    print(f"处理    : {seen} 条，改动 {changed} 条，异常 {errors} 条，{elapsed:.0f} 秒")
    print(f"peaks   : {total_before / 1e9:.3f} GB -> {after_total / 1e9:.3f} GB "
          f"（省 {saved / 1e9:.3f} GB，{saved / max(total_before, 1) * 100:.1f}%）")

    if not write_mode:
        print("未写入。加 --apply 才会改库。")
        conn.close()
        return 0

    if args.vacuum:
        print()
        print("VACUUM 中（大库要几分钟，别中断）...")
        t0 = time.time()
        conn.execute("PRAGMA wal_checkpoint(TRUNCATE)")
        conn.isolation_level = None
        conn.execute("VACUUM")
        print(f"VACUUM 完成 {time.time() - t0:.0f} 秒，"
              f"库现在 {db_path.stat().st_size / 1e9:.2f} GB")

    conn.close()

    verify = sqlite3.connect(f"file:{db_path.as_posix()}?mode=ro", uri=True, timeout=60)
    v = verify.cursor()
    print("integrity_check:", v.execute("PRAGMA integrity_check").fetchone()[0])
    print("files 总数     :", v.execute("SELECT COUNT(*) FROM files").fetchone()[0])
    print("peaks 合计     :",
          v.execute("SELECT SUM(LENGTH(peaks_json)) FROM files").fetchone()[0])
    sample = v.execute(
        "SELECT LENGTH(peaks_json) FROM files WHERE peaks_json IS NOT NULL LIMIT 5"
    ).fetchall()
    print("样本长度       :", [s[0] for s in sample])
    verify.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
