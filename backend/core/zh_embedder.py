# -*- coding: utf-8 -*-
"""P3：中文文本向量（BGE-M3）。

只做文本侧 embedding，音频侧仍用 CLAP。模型缺失时返回 None，调用方回退 CLAP 文本塔。
"""
from __future__ import annotations

import logging
import os  # noqa: F401  （_PREFERRED 读取环境变量）
from pathlib import Path
from typing import List, Optional

import numpy as np

logger = logging.getLogger(__name__)

_ROOT = Path(__file__).resolve().parents[2]
_roots = [_ROOT / "models"]
try:
    import config as _app_config

    _roots.insert(0, Path(_app_config.MODELS_DIR))
except Exception:
    pass

# 默认 bge-small-zh：512 维、92MB、速度快、区分度好（0.86 vs 0.40）
# 想要更强的 BGE-M3 时设置环境变量 ECHOMIND_EMBED_MODEL=bge-m3，
# 并重建文本索引（维度会从 512 变 1024）
_PREFERRED = os.environ.get("ECHOMIND_EMBED_MODEL", "bge-small-zh")
_ORDER = ("bge-m3", "bge-small-zh") if _PREFERRED == "bge-m3" else ("bge-small-zh", "bge-m3")
CANDIDATES = [root / name for name in _ORDER for root in _roots]


def _complete(path: Path) -> bool:
    """目录里要有 config 和权重才算可用（避免只有配置的半成品）。"""
    if not (path / "config.json").exists():
        return False
    return any(
        (path / name).exists() for name in ("model.safetensors", "pytorch_model.bin")
    )


MODEL_DIR = next((p for p in CANDIDATES if _complete(p)), CANDIDATES[-1])
DIM = 1024
_state = {"model": None, "tokenizer": None, "device": None, "failed": False, "dim": DIM}


def available() -> bool:
    return _complete(MODEL_DIR)


def _device() -> str:
    try:
        import torch

        if torch.cuda.is_available():
            return "cuda"
    except Exception:
        pass
    return "cpu"


def load() -> bool:
    """懒加载模型；成功返回 True。"""
    if _state["model"] is not None:
        return True
    if _state["failed"] or not available():
        return False
    try:
        import torch
        from transformers import AutoModel, AutoTokenizer

        device = _device()
        _state["tokenizer"] = AutoTokenizer.from_pretrained(str(MODEL_DIR))
        model = AutoModel.from_pretrained(str(MODEL_DIR))
        model.eval()
        model.to(device)
        _state["model"] = model
        _state["device"] = device
        _state["dim"] = int(model.config.hidden_size)
        logger.info("[Embed] BGE-M3 加载完成，device=%s", device)
        return True
    except Exception as exc:
        logger.warning("[Embed] BGE-M3 加载失败: %s", exc)
        _state["failed"] = True
        return False


def encode(texts: List[str], batch_size: int = 16, max_length: int = 256) -> Optional[np.ndarray]:
    """返回 L2 归一化后的向量矩阵 (n, 1024)；模型不可用返回 None。"""
    if not texts:
        return np.zeros((0, _state.get("dim") or DIM), dtype=np.float32)
    if not load():
        return None
    import torch

    model = _state["model"]
    tokenizer = _state["tokenizer"]
    device = _state["device"]
    outputs = []
    with torch.no_grad():
        for start in range(0, len(texts), batch_size):
            chunk = [t or "" for t in texts[start:start + batch_size]]
            batch = tokenizer(
                chunk, padding=True, truncation=True, max_length=max_length, return_tensors="pt"
            ).to(device)
            hidden = model(**batch).last_hidden_state
            mask = batch["attention_mask"].unsqueeze(-1).float()
            summed = (hidden * mask).sum(dim=1)
            counts = mask.sum(dim=1).clamp(min=1e-6)
            vectors = (summed / counts).cpu().numpy()
            outputs.append(vectors)
    matrix = np.vstack(outputs).astype(np.float32)
    norms = np.linalg.norm(matrix, axis=1, keepdims=True)
    norms[norms == 0] = 1.0
    return matrix / norms


def status() -> dict:
    return {
        "available": available(),
        "loaded": _state["model"] is not None,
        "failed": _state["failed"],
        "device": _state["device"],
        "path": str(MODEL_DIR),
        "model": MODEL_DIR.name,
        "dim": _state.get("dim"),
    }
