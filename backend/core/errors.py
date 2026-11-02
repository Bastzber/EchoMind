# -*- coding: utf-8 -*-
"""后端统一的错误契约。

原来是 main.py 里的一个类，11-02 拆路由时被当作依赖搬进了 ai.py，
导致 main.py 的异常处理器反而找不到它。现在下沉到 core，所有模块从这里取。
"""
from __future__ import annotations

from typing import Any, Dict, Optional


class SoundBotAPIError(Exception):
    """Structured error contract shared by backend, Electron and renderer."""

    def __init__(
        self,
        code: str,
        message: str,
        *,
        status_code: int = 400,
        retryable: bool = False,
        details: Optional[Dict[str, Any]] = None,
    ):
        super().__init__(message)
        self.status_code = status_code
        self.payload = {
            "code": code,
            "message": message,
            "retryable": retryable,
            "details": details or {},
        }
