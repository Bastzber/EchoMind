# -*- coding: utf-8 -*-
"""内容哈希：给每个素材一个与路径无关的身份。

路径会变（换盘、改名、挪目录），内容不会。sha256 用于：
1. 换机器/换盘后按哈希重连元数据；
2. 同哈希不同路径 = 重复素材；
3. 增量导入时跳过已存在的文件。
"""
from __future__ import annotations

import hashlib
import logging
import os
from pathlib import Path
from typing import Optional

logger = logging.getLogger(__name__)

_CHUNK = 1024 * 1024


def sha256_file(path: str | os.PathLike) -> Optional[str]:
    """流式计算文件 sha256；读不了返回 None（不阻塞入库）。"""
    try:
        digest = hashlib.sha256()
        with open(path, "rb") as handle:
            for chunk in iter(lambda: handle.read(_CHUNK), b""):
                digest.update(chunk)
        return digest.hexdigest()
    except (OSError, PermissionError) as exc:
        logger.debug("计算哈希失败 %s: %s", path, exc)
        return None
