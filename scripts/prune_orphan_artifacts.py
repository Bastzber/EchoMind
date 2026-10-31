# -*- coding: utf-8 -*-
"""清理 file_artifacts 里的孤儿行（对应的 files 行已不存在）。

背景：file_artifacts 对 files 有 ON DELETE CASCADE，但历史上有些删除路径
（或多连接写）没走到 cascade，留下了没有文件对应的工件行。它们会让界面
永远显示「待索引 N」——数码对不上，实际又没有文件可索引。
（2026-10-31 实测：音频 pending 6 / 文本 pending 8 / 波形 pending 1）

用法：
    python scripts/prune_orphan_artifacts.py                  # 只统计（dry-run）
    python scripts/prune_orphan_artifacts.py --apply          # 真正删除（先写 JSON 日志）
    python scripts/prune_orphan_artifacts.py --db <sqlite> --project default

删除前会把被删的完整行写进 %APPDATA%\\EchoMind\\db\\orphan-artifacts-<时间>.json，
事后要还原可以直接按那个文件插回去。
"""
from __future__ import annotations

import argparse
import json
import os
import sqlite3
import sys
import time
from pathlib import Path

SUMMARY_SQL = """
    SELECT a.project_id, a.kind, a.state, COUNT(*) AS n
    FROM file_artifacts a
    LEFT JOIN files f ON f.file_uuid = a.file_uuid
    WHERE f.file_uuid IS NULL {project_clause}
    GROUP BY a.project_id, a.kind, a.state
    ORDER BY a.project_id, a.kind, a.state
"""

ORPHAN_ROWS_SQL = """
    SELECT a.project_id, a.file_uuid, a.kind, a.state,
           a.source_fingerprint, a.engine_fingerprint,
           a.error_code, a.error_message, a.updated_at
    FROM file_artifacts a
    LEFT JOIN files f ON f.file_uuid = a.file_uuid
    WHERE f.file_uuid IS NULL {project_clause}
    ORDER BY a.project_id, a.kind, a.state
"""

DELETE_SQL = """
    DELETE FROM file_artifacts
    WHERE rowid IN (
        SELECT a.rowid
        FROM file_artifacts a
        LEFT JOIN files f ON f.file_uuid = a.file_uuid
        WHERE f.file_uuid IS NULL {project_clause}
    )
"""


def default_db_path() -> Path:
    appdata = os.environ.get("APPDATA")
    if not appdata:
        raise SystemExit("找不到 APPDATA，请用 --db 指定数据库路径")
    return Path(appdata) / "EchoMind" / "db" / "soundmind.db"


def connect(path: Path, read_only: bool) -> sqlite3.Connection:
    if read_only:
        uri = "file:" + path.as_posix() + "?mode=ro"
        conn = sqlite3.connect(uri, uri=True, timeout=15)
    else:
        conn = sqlite3.connect(str(path), timeout=15)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA busy_timeout=15000")
    return conn


def project_clause(project_id: str | None) -> str:
    return "AND a.project_id = ?" if project_id else ""


def params(project_id: str | None) -> tuple:
    return (project_id,) if project_id else ()


def report(conn: sqlite3.Connection, project_id: str | None) -> int:
    rows = conn.execute(
        SUMMARY_SQL.format(project_clause=project_clause(project_id)), params(project_id)
    ).fetchall()
    if not rows:
        print("没有孤儿工件行。")
        return 0
    total = 0
    print(f"{'project':<12} {'kind':<14} {'state':<12} {'rows':>6}")
    for row in rows:
        total += row["n"]
        print(f"{row['project_id']:<12} {row['kind']:<14} {row['state']:<12} {row['n']:>6}")
    print(f"{'合计':<12} {'':<14} {'':<12} {total:>6}")
    return total


def main() -> int:
    parser = argparse.ArgumentParser(description="清理 file_artifacts 孤儿行")
    parser.add_argument("--db", type=Path, default=None, help="数据库路径（默认 %APPDATA%\\EchoMind\\db\\soundmind.db）")
    parser.add_argument("--project", default=None, help="只处理指定工程（默认全部）")
    parser.add_argument("--apply", action="store_true", help="真正删除；不带则只统计")
    args = parser.parse_args()

    db_path = args.db or default_db_path()
    if not db_path.is_file():
        raise SystemExit(f"数据库不存在: {db_path}")
    print(f"数据库: {db_path}")

    if not args.apply:
        conn = connect(db_path, read_only=True)
        try:
            total = report(conn, args.project)
        finally:
            conn.close()
        if total:
            print("\n这是 dry-run，什么都没删。确认无误后加 --apply 执行。")
        return 0

    conn = connect(db_path, read_only=False)
    try:
        # 先把要删的行落盘，删错了能按日志插回去
        rows = conn.execute(
            ORPHAN_ROWS_SQL.format(project_clause=project_clause(args.project)),
            params(args.project),
        ).fetchall()
        if not rows:
            print("没有孤儿工件行，什么都不用删。")
            return 0
        journal = db_path.parent / f"orphan-artifacts-{time.strftime('%Y%m%d-%H%M%S')}.json"
        journal.write_text(
            json.dumps([dict(row) for row in rows], ensure_ascii=False, indent=1),
            encoding="utf-8",
        )
        print(f"已备份待删行: {journal}（{len(rows)} 行）")

        before = report(conn, args.project)
        cursor = conn.execute(
            DELETE_SQL.format(project_clause=project_clause(args.project)),
            params(args.project),
        )
        conn.commit()
        print(f"已删除 {cursor.rowcount} 行（统计口径合计 {before}）")
        print("\n删除后：")
        report(conn, args.project)
    finally:
        conn.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
