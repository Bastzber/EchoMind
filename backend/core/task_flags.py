# -*- coding: utf-8 -*-
"""跨模块的任务状态标志。

拆路由时遇到的问题：`_knowledge_import_running` 原本是 main.py 的模块级变量，
知识包端点写它（`global` + 赋值），补时长任务的 pause_check 读它。
路由搬走后两边分居两个模块，跨模块改可变全局的语义会错。

这里用一个小模块持有状态，谁都可以读写，语义唯一。
"""
from __future__ import annotations

import threading

_lock = threading.Lock()
_state = {
    "knowledge_import": False,
}


def knowledge_import_running() -> bool:
    with _lock:
        return bool(_state["knowledge_import"])


def set_knowledge_import_running(value: bool) -> None:
    with _lock:
        _state["knowledge_import"] = bool(value)


def snapshot() -> dict:
    with _lock:
        return dict(_state)
