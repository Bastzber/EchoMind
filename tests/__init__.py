# -*- coding: utf-8 -*-
"""测试包初始化。

Windows 的文件锁语义：只要还有未关闭的 sqlite 连接，TemporaryDirectory 清理就会抛
WinError 32，把一条本来通过的用例判成 ERROR。pytest 通过 conftest.py 容忍了这件事，
但 `python -m unittest discover` 不加载 conftest —— 它只导入包本身，所以在这里再兜一次。
"""
import tempfile

_original_init = tempfile.TemporaryDirectory.__init__


def _tolerant_init(self, *args, **kwargs):
    kwargs.setdefault("ignore_cleanup_errors", True)
    _original_init(self, *args, **kwargs)


if not getattr(tempfile.TemporaryDirectory, "_echomind_tolerant", False):
    tempfile.TemporaryDirectory.__init__ = _tolerant_init
    tempfile.TemporaryDirectory._echomind_tolerant = True
