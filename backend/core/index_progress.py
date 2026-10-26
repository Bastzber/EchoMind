# -*- coding: utf-8 -*-
"""索引进度心跳：影子索引完成前 ready 不会变，界面靠这个数字判断"在动"。

主进程（main.py）读取 stats() 展示；索引器（indexer.py）每编码一批 bump 一次。
"""
from __future__ import annotations

import threading
from typing import Dict

_lock = threading.Lock()
_state: Dict[str, int] = {"audio": 0, "text": 0}


def reset() -> None:
    with _lock:
        _state["audio"] = 0
        _state["text"] = 0


def bump(kind: str, n: int = 1) -> None:
    key = "audio" if kind.startswith("audio") else "text"
    with _lock:
        _state[key] = int(_state.get(key, 0)) + int(n)


def stats() -> Dict[str, int]:
    with _lock:
        return dict(_state)
