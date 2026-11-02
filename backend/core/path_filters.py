# -*- coding: utf-8 -*-
"""扫描时的目录排除：系统目录、缓存、版本控制、临时目录一律不进库。

11-02 用户实测：库根目录下同级的 AI生成音效 / 克隆测试 被误扫，提示补录 9 个。
根目录修正后这类误扫基本消失，但系统垃圾目录（回收站、System Volume Information）
仍会混进 rglob 结果，这里统一挡掉。
"""
from __future__ import annotations

import os
from typing import Iterable, Set

_EXCLUDED = {
    '$recycle.bin',
    'system volume information',
    'node_modules',
    '__pycache__',
    '.git',
    '.svn',
    '.cache',
    'temp',
    'tmp',
}


def is_excluded_dir(name: str) -> bool:
    """目录名本身该跳过吗（以 . 开头的一律跳过）。"""
    if not name:
        return False
    if name.startswith('.'):
        return True
    return name.strip().lower() in _EXCLUDED


def prune_walk_dirs(dirs: Iterable[str]) -> Set[str]:
    """给 os.walk 的 dirnames 就地剪枝：返回要剔除的名字集合。"""
    return {name for name in dirs if is_excluded_dir(name)}


def is_excluded_path(path: str) -> bool:
    """整条路径上任一段是排除目录就跳过（给 rglob 用）。"""
    parts = str(path).replace('/', os.sep).split(os.sep)
    return any(is_excluded_dir(part) for part in parts[:-1])
