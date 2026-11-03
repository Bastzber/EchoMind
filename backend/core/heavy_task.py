# -*- coding: utf-8 -*-
"""重任务闸门 + 排队：同一时间只让一个重活（导入/知识包/补时长/哈希/波形）占资源。

背景：files 表被五条链路同时写——导入、补时长、哈希补算、知识包导入、波形。
SQLite 只有一个写者、机械盘只有一条队列，撞在一起就是「进度卡住 + 界面读取失败」
（用户 11-01 20:5x 实测：知识包导入时 [Hash] 补算抢锁，报 database is locked）。

两套接口：
  enter(name)/leave(name)  老的占用登记（不排队，谁先到谁跑）
  acquire(name)            排队版：按提交顺序轮到自己才返回，前端能看到排第几

为什么加排队：原来只有 busy() 自旋，后到的任务可能先抢到，用户点了导入没反应、
也不知道是在排队还是卡死了。现在等的人会登记进 _waiting，status() 能报出队位。
"""
from __future__ import annotations

import itertools
import threading
import time
from typing import Dict, List, Optional

_lock = threading.Lock()
_active: Dict[str, int] = {}

# 排队登记：[(序号, 任务名, 提交时刻)]。序号单调递增，保证先来先服务。
_waiting: List[tuple] = []
_seq = itertools.count(1)


def enter(name: str) -> None:
    with _lock:
        _active[name] = _active.get(name, 0) + 1


def leave(name: str) -> None:
    with _lock:
        count = _active.get(name) or 0
        if count <= 1:
            _active.pop(name, None)
        else:
            _active[name] = count - 1


def busy(except_name: Optional[str] = None) -> bool:
    """有别的重活在跑就返回 True（except_name 用来忽略自己那一类）。"""
    with _lock:
        return any(name != except_name for name in _active)


def snapshot() -> Dict[str, int]:
    with _lock:
        return dict(_active)


def _my_turn(name: str, ticket: int) -> bool:
    """轮到我了：没有别的重活在跑，且没有比我更早的任务在等。"""
    with _lock:
        if any(other != name for other in _active):
            return False
        for seq, other_name, _since in sorted(_waiting):
            if seq == ticket:
                return True
            if other_name != name:
                return False
        return True


class BusyTimeout(RuntimeError):
    """排队超时。"""


def acquire(name: str, timeout: float = 1800.0, poll: float = 0.4):
    """排队等轮到自己，然后占住资源。用法：

        with acquire('import'):
            ...重活...
    """
    return _QueueSlot(name, timeout, poll)


class _QueueSlot:
    def __init__(self, name: str, timeout: float, poll: float):
        self.name = name
        self.timeout = timeout
        self.poll = poll
        self.ticket: Optional[int] = None

    def __enter__(self):
        with _lock:
            self.ticket = next(_seq)
            _waiting.append((self.ticket, self.name, time.time()))
        deadline = time.time() + self.timeout
        try:
            while not _my_turn(self.name, self.ticket):
                if time.time() > deadline:
                    raise BusyTimeout(
                        '等了 %.0f 秒还没轮到（当前在跑：%s）'
                        % (self.timeout, ', '.join(snapshot()) or '无')
                    )
                time.sleep(self.poll)
        finally:
            with _lock:
                _waiting[:] = [item for item in _waiting if item[0] != self.ticket]
        enter(self.name)
        return self

    def __exit__(self, exc_type, exc, tb):
        leave(self.name)
        return False


def wait_turn(name: str, timeout: float = 1800.0, poll: float = 0.4) -> None:
    """排队等轮到自己并占住资源；配套原有的 leave(name) 用。

    给异步任务用：它们原来直接 enter(name) 不排队，后到的可能先抢到。
    """
    _QueueSlot(name, timeout, poll).__enter__()


def queue_status() -> Dict[str, object]:
    """给前端看的队列快照：谁在跑、谁在等、等了多久。"""
    now = time.time()
    with _lock:
        running = dict(_active)
        waiting = [
            {'name': entry[1], 'waited': round(now - entry[2], 1)}
            for entry in sorted(_waiting)
        ]
    return {
        'running': running,
        'waiting': waiting,
        'waiting_count': len(waiting),
        'busy': bool(running),
    }