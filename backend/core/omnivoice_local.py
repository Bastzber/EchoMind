# -*- coding: utf-8 -*-
"""OmniVoice 内置引擎（不依赖 VoiceStudio）。

模型 = k2-fsa/OmniVoice（Qwen3 底座 + 8 路音频码本 + Higgs Audio 2 分词器），
约 3.1 GB。EchoMind 自己下载、自己加载，用户机器上不需要装 VoiceStudio。

三个注意点：
1. 权重不随包发：首次使用该引擎时下载到 <用户数据>/models/omnivoice。
   本机已经有 VoiceStudio 下载过的那份，直接复用，不重下 3.1 GB。
2. 推理在子进程（omnivoice_worker.py）里跑，CUDA 崩了不连累主服务。
3. 许可：omnivoice 包是 AGPL-3.0-only；音频分词器权重是 Boson Higgs Audio 2
   社区许可。自用无碍，对外分发要附许可并按 AGPL 提供对应源码。
"""
from __future__ import annotations

import json
import logging
import os
import pickle
import subprocess
import sys
import threading
import time
from pathlib import Path
from typing import Any, Dict, Optional

logger = logging.getLogger(__name__)

HF_REPO = "k2-fsa/OmniVoice"
SAMPLE_RATE = 24000
DOWNLOAD_SIZE_GB = 3.1

_worker: Optional[subprocess.Popen] = None
_worker_lock = threading.Lock()
_rpc_lock = threading.Lock()


# ---------------- 权重位置 ----------------

def _user_data_root() -> Path:
    try:
        from core import config

        base = config.get_user_data_dir()
    except Exception:
        base = Path(os.environ.get("APPDATA", ".")) / "EchoMind"
    return Path(base)


def weights_dir() -> Path:
    return _user_data_root() / "models" / "omnivoice"


def _looks_like_checkpoint(path: Path) -> bool:
    return (
        (path / "config.json").is_file()
        and (path / "model.safetensors").is_file()
        and (path / "audio_tokenizer").is_dir()
    )


def find_local_weights() -> str:
    """找一份可用的 OmniVoice 权重目录，找不到返回空串。

    顺序：EchoMind 自己的目录 -> 本机已存在的 HF 缓存（比如 VoiceStudio 下过的那份）。
    复用缓存是为了省掉 3.1 GB 的重复下载，用户机器上通常只有第一处。
    """
    own = weights_dir()
    if _looks_like_checkpoint(own):
        return str(own)

    candidates = []
    hf_home = os.environ.get("HF_HOME") or os.environ.get("HUGGINGFACE_HUB_CACHE")
    if hf_home:
        candidates.append(Path(hf_home))
    local_app = os.environ.get("LOCALAPPDATA")
    if local_app:
        candidates.append(Path(local_app) / "OmniVoice" / "hf_cache")
        candidates.append(Path(local_app) / "huggingface" / "hub")
    for base in candidates:
        snapshots = base / "models--k2-fsa--OmniVoice" / "snapshots"
        if not snapshots.is_dir():
            continue
        for snap in snapshots.iterdir():
            if snap.is_dir() and _looks_like_checkpoint(snap):
                return str(snap)
    return ""


def weights_state() -> Dict[str, Any]:
    path = find_local_weights()
    return {
        "present": bool(path),
        "path": path,
        "size_gb": DOWNLOAD_SIZE_GB,
        "repo": HF_REPO,
    }


def available() -> bool:
    return bool(find_local_weights())


def download_weights(progress_log: Optional[list] = None) -> Dict[str, Any]:
    """下载权重到 EchoMind 自己的目录。成功返回 {ok, path}。"""
    target = weights_dir()
    if _looks_like_checkpoint(target):
        return {"ok": True, "path": str(target), "cached": True}
    try:
        from huggingface_hub import snapshot_download
    except Exception as exc:
        return {"ok": False, "error": "缺少 huggingface_hub: %s" % exc}

    def _note(text: str) -> None:
        logger.info("[OmniVoice] %s", text)
        if progress_log is not None:
            progress_log.append(text)

    _note("开始下载 %s（约 %.1f GB）到 %s" % (HF_REPO, DOWNLOAD_SIZE_GB, target))
    target.mkdir(parents=True, exist_ok=True)
    try:
        snapshot_download(
            repo_id=HF_REPO,
            local_dir=str(target),
            allow_patterns=["*.json", "*.safetensors", "*.jinja", "README.md", "audio_tokenizer/*", ".gitattributes"],
        )
    except Exception as exc:
        # 已经有一份本机缓存就先用那份，别把用户卡在下载上
        fallback = find_local_weights()
        if fallback:
            _note("下载失败（%s），改用本机已有权重：%s" % (exc, fallback))
            return {"ok": True, "path": fallback, "fallback": True}
        return {"ok": False, "error": "下载失败: %s" % str(exc)[:300]}

    if not _looks_like_checkpoint(target):
        fallback = find_local_weights()
        if fallback:
            return {"ok": True, "path": fallback, "fallback": True}
        return {"ok": False, "error": "下载完成但目录不完整（缺 audio_tokenizer）"}
    _note("权重就绪")
    return {"ok": True, "path": str(target)}


# ---------------- 子进程 ----------------

def _spawn_worker() -> subprocess.Popen:
    python = sys.executable
    worker_py = Path(__file__).resolve().parent / "omnivoice_worker.py"
    # 冻结后磁盘上没有 worker 脚本，用同一个 exe 加参数复用自身
    if getattr(sys, "frozen", False):
        args = [python, "--omnivoice-worker"]
    else:
        args = [python, str(worker_py)]
    flags = 0
    if os.name == "nt":
        flags = getattr(subprocess, "CREATE_NO_WINDOW", 0)
    return subprocess.Popen(
        args,
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        cwd=str(Path(__file__).resolve().parents[1]),
        creationflags=flags,
    )


def _kill_worker() -> None:
    global _worker
    if _worker is None:
        return
    try:
        _worker.kill()
    except Exception:
        pass
    _worker = None


def _get_worker() -> subprocess.Popen:
    global _worker
    with _worker_lock:
        if _worker is not None and _worker.poll() is None:
            return _worker
        _worker = _spawn_worker()
        logger.info("[OmniVoice] worker 已启动 pid=%s", getattr(_worker, "pid", "?"))
        return _worker


def _rpc(request: Dict[str, Any], timeout: float) -> Dict[str, Any]:
    with _rpc_lock:
        worker = _get_worker()
        try:
            worker.stdin.write(pickle.dumps(request))
            worker.stdin.flush()
        except Exception as exc:
            _kill_worker()
            return {"ok": False, "error": "写入 worker 失败: %s" % exc}

        box: Dict[str, Any] = {}

        def _read() -> None:
            try:
                box["reply"] = pickle.load(worker.stdout)
            except Exception as exc:  # worker 挂了
                box["error"] = repr(exc)

        reader = threading.Thread(target=_read, daemon=True)
        reader.start()
        reader.join(timeout)
        if reader.is_alive():
            _kill_worker()
            return {"ok": False, "error": "OmniVoice 合成超时（%.0fs）" % timeout}
        if "error" in box:
            _kill_worker()
            try:
                err = worker.stderr.read(4000).decode("utf-8", "replace")
            except Exception:
                err = ""
            logger.warning("[OmniVoice] worker stderr: %s", err[-1500:])
            return {"ok": False, "error": "OmniVoice worker 异常退出"}
        return box.get("reply") or {"ok": False, "error": "worker 没有返回"}


def warmup(timeout: float = 180.0) -> bool:
    """加载模型（第一次 30~90 秒）。返回是否就绪。"""
    checkpoint = find_local_weights()
    if not checkpoint:
        return False
    reply = _rpc({"op": "synth", "text": "预热", "checkpoint": checkpoint}, timeout)
    return bool(reply.get("ok"))


def synth(
    text: str,
    ref_audio: str = "",
    ref_text: str = "",
    speed: float = 1.0,
    timeout: float = 300.0,
) -> Dict[str, Any]:
    """合成一段语音，返回 {ok, pcm, sample_rate} 或 {ok: False, error}。"""
    checkpoint = find_local_weights()
    if not checkpoint:
        return {"ok": False, "error": "OmniVoice 权重还没下载（约 3.1 GB），先点下载"}
    return _rpc(
        {
            "op": "synth",
            "text": text,
            "ref_audio": ref_audio or "",
            "ref_text": ref_text or "",
            "speed": speed,
            "checkpoint": checkpoint,
        },
        timeout,
    )


def shutdown() -> None:
    _kill_worker()
