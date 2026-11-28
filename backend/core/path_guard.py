# -*- coding: utf-8 -*-
"""后端磁盘路径边界校验。

后端的写接口如果直接拿请求里的 path 当磁盘路径用，同机任何进程
（以及经 CORS 进来的浏览器请求）都能借它读、写、删库外的文件。
这里的规矩只有一条：路径必须落在素材库根目录以内。

素材库根目录从数据库索引推出来（list_library_roots），不信任请求里传的任何根——
这一点和 sfx.py 里「先算 base_dir 再 relative_to」的写法一致，
只是把边界换成了用户真正的素材库，而不是生成目录。
"""

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


def app_generated_roots() -> List[str]:
    """本程序自己写出来的目录：语音缓存、生成结果、临时导出。

    这些不是素材库，但它们是本程序产出的文件 —— 拿它们当「另存为」的 source
    不该被素材库边界拦住（11-24 反馈：克隆结果在 tts_cache 里，保存直接报
    「source 不在素材库范围内」，用户只能自己去缓存目录手工拷）。
    """
    try:
        import config

        base = Path(config.get_user_data_dir())
    except Exception:
        base = Path(os.environ.get("APPDATA", ".")) / "EchoMind"
    return [str(base / name) for name in ("tts_cache", "generated", "temp")]


def resolve_generated_source(target: str, library_roots: Iterable[str], *, field: str = "source") -> Path:
    """source 可以是素材库里的文件，也可以是本程序生成的缓存文件。

    仍然拒绝空路径和不存在的绝对路径；不限制用户往哪儿导出（那是用户自己
    在系统对话框里选的位置）。
    """
    raw = str(target or "").strip()
    if not raw:
        raise PathOutsideLibrary("%s 不能为空" % field)
    candidate = Path(raw)
    if not candidate.is_absolute():
        raise PathOutsideLibrary("%s 必须是绝对路径：%s" % (field, raw))
    allowed = [str(r) for r in library_roots if str(r).strip()] + app_generated_roots()
    if not is_inside(raw, allowed):
        raise PathOutsideLibrary("%s 不是本程序生成的文件，也不在素材库内：%s" % (field, raw))
    return candidate
