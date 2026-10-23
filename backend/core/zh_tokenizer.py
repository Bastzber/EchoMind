# -*- coding: utf-8 -*-
"""中文 FTS 分词：汉字二元组（bigram）+ 分隔符归一。

SQLite 没有内置中文分词。这里用无词典的二元组方案：
「玻璃破碎」→ 玻璃 / 璃破 / 破碎，召回率接近词典分词，
索引体积约为原文的 1.3 倍，且写入与查询共用同一函数，不会对不齐。
"""
from __future__ import annotations

import re
import unicodedata

_SEP = re.compile(r"[_\-./\\]+")
_HAN = re.compile(r"[\u3400-\u9fff]+")
_SPACE = re.compile(r"\s+")


def tokenize(text: str) -> str:
    """把任意字符串归一化为 FTS 可用的 token 串。"""
    s = unicodedata.normalize("NFKC", str(text or "")).lower()
    s = _SEP.sub(" ", s)
    words = [w for w in _SPACE.split(s) if w]
    for run in _HAN.findall(s):
        chars = list(run)
        if len(chars) == 1:
            words.append(chars[0])
        else:
            words.extend(chars[i] + chars[i + 1] for i in range(len(chars) - 1))
    seen = set()
    out = []
    for word in words:
        if word not in seen:
            seen.add(word)
            out.append(word)
    return " ".join(out)


def build_match(query: str, limit: int = 12) -> str:
    """构造 FTS5 MATCH 表达式：每个 token 前缀匹配，token 之间 AND。"""
    tokens = tokenize(query).split()[:limit]
    if not tokens:
        return ""
    return " AND ".join(f'"{t}"*' for t in tokens)
