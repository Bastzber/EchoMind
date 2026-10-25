# -*- coding: utf-8 -*-
"""音效库目录健康检查：数据库里的目录 vs 磁盘上的目录。

用户在资源管理器里给文件夹改名/移动后，库里存的还是旧路径：
- 列表里还能看到（读数据库），但点了放不出来
- 左侧目录树还是旧的

这里只做「检测」——找出库里存在、磁盘上已消失的目录，交给 repair-paths 修复。
"""
from __future__ import annotations

import os
from collections import Counter
from typing import Dict, Iterable, List


def collect_directories(paths: Iterable[str]) -> Dict[str, int]:
    """把文件路径归到目录，返回 {目录: 文件数}。"""
    counts: Counter = Counter()
    for path in paths:
        if not path:
            continue
        directory = os.path.dirname(str(path))
        if directory:
            counts[directory] += 1
    return dict(counts)


def detect_missing(directories: Dict[str, int]) -> List[Dict[str, object]]:
    """找出磁盘上不存在的目录，按文件数降序。"""
    missing = []
    for directory, count in directories.items():
        if not os.path.isdir(directory):
            missing.append({"path": directory, "files": int(count)})
    missing.sort(key=lambda item: (-int(item["files"]), str(item["path"])))
    return missing


def common_root(paths: Iterable[str]) -> str:
    """推导库根目录（所有路径的公共前缀，按目录边界对齐）。"""
    candidates = [str(p) for p in paths if p]
    if not candidates:
        return ""
    try:
        prefix = os.path.commonpath(candidates)
    except ValueError:
        return ""
    if os.path.isfile(prefix) or not os.path.splitext(prefix)[1]:
        return prefix
    return os.path.dirname(prefix)


def folder_health(paths: Iterable[str], limit: int = 200) -> Dict[str, object]:
    """一次算完：目录总数、缺失目录、涉及文件数、库根。"""
    path_list = [str(p) for p in paths if p]
    directories = collect_directories(path_list)
    missing = detect_missing(directories)
    missing_files = sum(int(item["files"]) for item in missing)
    return {
        "total_files": len(path_list),
        "total_dirs": len(directories),
        "missing_count": len(missing),
        "missing_files": missing_files,
        "missing": missing[: max(1, int(limit))],
        "root": common_root(path_list),
        "healthy": not missing,
    }
