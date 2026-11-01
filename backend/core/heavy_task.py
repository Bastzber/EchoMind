# -*- coding: utf-8 -*-
"""重任务闸门：同一时间只让一个重活（导入/知识包/补时长/哈希/波形）占资源。

背景：files 表被五条链路同时写——导入、补时长、哈希补算、知识包导入、波形。
SQLite 只有一个写者、机械盘只有一条队列，撞在一起就是「进度卡住 + 界面读取失败」
（用户 11-01 20:5x 实测：知识包导入时 [Hash] 补算抢锁，报 database is locked）。

谁要占资源：enter(name)；谁要让路：busy(name) 为真就 sleep。
"""
from __future__ import annotations

import threading
from typing import Dict, Optional

_lock = threading.Lock()
_active: Dict[str, int] = {}


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
