# -*- coding: utf-8 -*-
"""导入报告：把「描述包里没匹配上的条目」导出成 CSV，方便人工核对。"""
from __future__ import annotations

import csv
import os
from datetime import datetime
from pathlib import Path
from typing import Dict, Iterable, List

CSV_HEADERS = ["相对路径", "文件名", "原因", "描述"]


def reports_dir() -> Path:
    base = os.environ.get("APPDATA") or str(Path.home())
    path = Path(base) / "EchoMind" / "reports"
    path.mkdir(parents=True, exist_ok=True)
    return path


def write_unmatched_csv(rows: Iterable[Dict[str, str]], prefix: str = "desc-unmatched") -> str:
    """写出未匹配清单，返回文件绝对路径。

    rows: [{"rel": ..., "filename": ..., "reason": ..., "description": ...}]
    UTF-8 BOM 是为了 Excel 双击打开时中文不乱码。
    """
    items: List[Dict[str, str]] = list(rows)
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    target = reports_dir() / f"{prefix}-{stamp}.csv"
    with target.open("w", encoding="utf-8-sig", newline="") as handle:
        writer = csv.writer(handle)
        writer.writerow(CSV_HEADERS)
        for item in items:
            writer.writerow([
                item.get("rel", ""),
                item.get("filename", ""),
                item.get("reason", ""),
                (item.get("description", "") or "").replace("\n", " ")[:500],
            ])
    return str(target)
