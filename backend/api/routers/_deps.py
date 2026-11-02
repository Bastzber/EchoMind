# -*- coding: utf-8 -*-
"""路由模块访问主模块（main.py）内部辅助函数的桥。

为什么需要它：main.py 里有 `_repair_index_task`、`_deferred_reconcile`、`_detect_library_root`
这类私有辅助，路由搬出来后要调用它们。直接 `import main` 会把入口模块再执行一遍
（打包后灾难），所以运行时从 sys.modules 里取已经加载的那份。

约定：入口是 `python main.py`，模块名是 `__main__`；uvicorn 方式启动时是 `__main__` 或 `main`。
"""
from __future__ import annotations

import sys
from typing import Any


def main_module() -> Any:
    """返回已加载的主模块对象（不触发重新导入）。"""
    for name in ("__main__", "main", "backend.main"):
        module = sys.modules.get(name)
        if module is not None and hasattr(module, "get_db_manager"):
            return module
    raise RuntimeError("找不到主模块：路由模块必须在 main.py 启动之后被调用")


def call(name: str, *args, **kwargs):
    """调用主模块里的函数：call("_repair_index_task", ...)。"""
    func = getattr(main_module(), name, None)
    if func is None:
        raise AttributeError(f"主模块里没有 {name}")
    return func(*args, **kwargs)


def attr(name: str):
    """取主模块里的属性（配置、错误类、pydantic 模型等）。"""
    module = main_module()
    if not hasattr(module, name):
        raise AttributeError(f"主模块里没有 {name}")
    return getattr(module, name)
