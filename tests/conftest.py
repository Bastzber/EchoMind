"""Shared pytest configuration.

Windows 的文件锁语义：只要还有未关闭的 sqlite 连接，临时目录删除就会抛
WinError 32。生产代码已通过 DatabaseManager.close() 释放连接，这里让测试用的
TemporaryDirectory 在清理失败时不再把整个用例判为失败（断言本身仍然是严格的）。
"""

import gc
import tempfile

import pytest

_original_init = tempfile.TemporaryDirectory.__init__


def _tolerant_init(self, *args, **kwargs):
    kwargs.setdefault("ignore_cleanup_errors", True)
    _original_init(self, *args, **kwargs)


tempfile.TemporaryDirectory.__init__ = _tolerant_init


@pytest.fixture(autouse=True)
def _release_resources_between_tests():
    yield
    gc.collect()
