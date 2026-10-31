# -*- coding: utf-8 -*-
"""SQLite 写冲突重试（B6 的一半）。

索引任务、描述包写入、向量包导入可能同时跑，撞上写锁时 SQLite 抛
`database is locked`。连接已经设了 busy_timeout，但长事务超过阈值仍会失败。
这里给批量写路径提供统一重试，避免一次失败就把整批写成 500。
"""
from __future__ import annotations

import logging
import sqlite3
import time
from typing import Any, Callable, TypeVar

logger = logging.getLogger(__name__)

T = TypeVar("T")


def is_lock_error(exc: BaseException) -> bool:
    text = str(exc).lower()
    return "database is locked" in text or "acquire_write" in text or "database table is locked" in text


def run_with_retry(
    fn: Callable[[], T],
    *,
    attempts: int = 5,
    base_delay: float = 0.2,
    label: str = "write",
) -> T:
    """执行一次写操作，遇到锁冲突按 0.2/0.5/1/2s 退避重试。

    非锁错误立刻抛出，不做无意义重试。
    """
    last: Exception | None = None
    for attempt in range(1, max(1, attempts) + 1):
        try:
            return fn()
        except sqlite3.OperationalError as exc:
            if not is_lock_error(exc):
                raise
            last = exc
            delay = base_delay * (2 ** (attempt - 1))
            logger.warning(
                "[DB] %s 撞写锁（第 %d/%d 次），%.1fs 后重试: %s",
                label, attempt, attempts, delay, exc,
            )
            time.sleep(min(delay, 4.0))
    assert last is not None
    raise last