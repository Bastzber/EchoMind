# -*- coding: utf-8 -*-
"""后端磁盘路径边界校验。

后端的写接口如果直接拿请求里的 path 当磁盘路径用，同机任何进程
（以及经 CORS 进来的浏览器请求）都能借它读、写、删库外的文件。
这里的规矩只有一条：路径必须落在素材库根目录以内。

素材库根目录从数据库索引推出来（list_library_roots），不信任请求里传的任何根——
这一点和 sfx.py 里「先算 base_dir 再 relative_to」的写法一致，
只是把边界换成了用户真正的素材库，而不是生成目录。
"""
from __future__ import annotations

import os
from pathlib import Path
from typing import Iterable, List


class PathOutsideLibrary(Exception):
    """路径落在素材库之外。"""


def _normalize(path_value: str) -> str:
    return os.path.normcase(os.path.abspath(str(path_value)))


def is_inside(target: str, roots: Iterable[str]) -> bool:
    """target 是否在 roots 任意一个目录之内（含等于根本身）。"""
    if not target:
        return False
    target_abs = _normalize(target)
    for root in roots:
        root_abs = _normalize(str(root))
        if not root_abs:
            continue
        if target_abs == root_abs:
            return True
        try:
            if os.path.commonpath([target_abs, root_abs]) == root_abs:
                return True
        except ValueError:
            # 不同盘符走 commonpath 会抛 ValueError，那必然不在同一棵树里
            continue
    return False


def resolve_in_library(target: str, roots: Iterable[str], *, field: str = "path") -> Path:
    """校验并把路径转成 Path；越界抛 PathOutsideLibrary。"""
    roots_list: List[str] = [str(r) for r in roots if str(r).strip()]
    if not roots_list:
        # 库还没索引出来时宁可拒绝，也不要退化成「随便写」
        raise PathOutsideLibrary("%s 校验失败：素材库根目录未知" % field)
    if not is_inside(target, roots_list):
        raise PathOutsideLibrary("%s 不在素材库范围内：%s" % (field, target))
    return Path(target)
