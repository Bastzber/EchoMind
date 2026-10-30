# -*- coding: utf-8 -*-
# SoundBot - AI 音效管理器
# Copyright (C) 2026 Nagisa_Huckrick (胡杨)
#
# This program is free software: you can redistribute it and/or modify
# it under the terms of the GNU General Public License as published by
# the Free Software Foundation, either version 3 of the License, or
# (at your option) any later version.

"""CLAP audio/text embeddings and pluggable metadata-text embeddings.

The audio index always uses CLAP so audio and text live in the same vector
space.  A separate metadata index may use CLAP text features or an
OpenAI-compatible embedding endpoint.  Keeping these two responsibilities
explicit prevents a text-only model from accidentally replacing the audio
encoder.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import os
import pickle
import sys
import threading
import time
from pathlib import Path
from typing import Any, Dict, List, Optional, Protocol, runtime_checkable

import httpx

# 已知坏文件黑名单缓存：特殊格式音频会触发 CUDA device-side assert 并污染
# GPU 上下文。清单文件由外部诊断生成（一行一个路径，`#` 开头为注释）。
# 毒文件黑名单策略（2026-10-21 重写）：
# 旧实现把「单次失败」永久追加到一个写死的绝对路径里（豆包会话目录），
# 一次批量超时就把上万条正常文件钉死，之后每轮重建都直接跳过，
# 表现为「原始文件能播但 CLAP 永远索引不出来」。
# 新策略：清单放在用户数据目录、带时间戳、3 天后自动失效、条目过多视为异常并清空。
_BLACKLIST_MAX_AGE_SECONDS = 3 * 24 * 3600
_BLACKLIST_MAX_ENTRIES = 2000
_blacklist_cache: Optional[frozenset] = None
_blacklist_lock = threading.Lock()


def _blacklist_file() -> str:
    override = os.environ.get("ECHOMIND_BLACKLIST") or os.environ.get("_BADFILE_BLACKLIST")
    if override:
        return override
    try:
        import config as _config
        return str(_config.get_user_data_dir() / "poison_files.txt")
    except Exception:
        return os.path.join(os.path.expanduser("~"), ".echomind_poison.txt")


def _load_blacklist() -> frozenset:
    global _blacklist_cache
    if _blacklist_cache is not None:
        return _blacklist_cache
    with _blacklist_lock:
        if _blacklist_cache is not None:
            return _blacklist_cache
        items: set = set()
        now = time.time()
        try:
            with open(_blacklist_file(), "r", encoding="utf-8") as f:
                for line in f:
                    line = line.strip()
                    if not line or line.startswith("#"):
                        continue
                    path, _, ts = line.partition("\t")
                    path = path.strip()
                    if not path:
                        continue
                    try:
                        stamp = float(ts) if ts else 0.0
                    except ValueError:
                        stamp = 0.0
                    # 没有时间戳（旧格式）或已过期：不信任，重新尝试
                    if stamp <= 0 or (now - stamp) > _BLACKLIST_MAX_AGE_SECONDS:
                        continue
                    items.add(path)
        except Exception:
            pass
        if len(items) > _BLACKLIST_MAX_ENTRIES:
            logging.getLogger(__name__).warning(
                "毒文件黑名单异常膨胀（%d 条），本轮忽略以避免正常文件被永久跳过",
                len(items),
            )
            items = set()
        _blacklist_cache = frozenset(items)
        return _blacklist_cache
import numpy as np

# ---- 单 worker 子进程 mel（毒文件隔离，可 kill）----
# 个别毒文件会在 torchaudio mel 频谱 kernel（C 扩展）死锁，并锁污染同一进程内
# 后续所有 processor 调用（线程超时防护下整批全跳过、零写入）。mel 计算移到
# 单个常驻子进程：毒文件超时后 kill 重启该 worker，不影响主流程与后续调用。
_mel_worker: Optional[Any] = None
# RLock（可重入）：_get_mel_worker 持锁期间会在 warm 失败后调用
# _reset_mel_worker，后者需要再次获取同一把锁。用不可重入的 Lock 会让同一
# 线程自锁：_get_mel_worker 永不返回，重建静默卡死且不打任何日志。
_mel_worker_lock = threading.RLock()
_mel_rpc_lock = threading.Lock()
_MEL_WORKER_READY_WAIT = 4.0
# 单文件毒文件重试预算。走到这里的文件，batch 阶段已经失败过一次；此处只做
# "确认它是否真卡死"，worker 在 _get_mel_worker 里已 warm 过，正常文件 5~15s
# 就能出结果。旧值 200s 会让每个新毒文件烧掉 ~400s（两次重试），上万条毒文件
# 就是几十小时，扫描永远跑不完。
MEL_RETRY_TIMEOUT = 20.0
# CLAP 文本塔位置编码上限 77 token；中文 1 字约 1~2 token，取 120 字符留足余量。
TEXT_MAX_CHARS = 120


class EmbedderCudaError(RuntimeError):
    """CUDA 上下文被 device-side assert 污染，进程内不可恢复。"""
# 一个块里只要有一个未知毒文件，整块就要等一次批量超时 + 二分定位。块越大，
# 单个毒文件的连带成本越高：256 条块里 1 个毒文件会拖住 255 个好文件 ~8 分钟。
# 降到 16 条后，二分只需 4 次尝试，连带成本降到 ~2 分钟。
MEL_CHUNK_SIZE = 8
# worker 在 _get_mel_worker 里已 warm 过模型，批量请求不需要再给冷启动留 150s；
# 60s 足够正常 16 条块的 mel 计算（正常 <15s），毒文件也能更快进入二分定位。
MEL_BATCH_TIMEOUT = 90.0
_mel_runtime_blacklist: set = set()
_mel_runtime_blacklist_lock = threading.Lock()


def _spawn_mel_worker():
    import subprocess

    python = sys.executable
    mel_py = Path(__file__).resolve().parent / "melworker.py"
    # 冻结（PyInstaller）后磁盘上没有 melworker.py，改用同一个 exe 加参数
    # 复用自身作为 worker；否则 spawn 出来的是第二个 HTTP 服务，
    # 永远等不到 pickle 回复，所有音频都判为失败。
    if getattr(sys, "frozen", False):
        args = [python, "--mel-worker"]
    else:
        args = [python, str(mel_py)]
    # Windows 下隐藏子进程控制台窗口，避免 worker 启动/重启时闪烁蓝色窗口
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


def _warm_mel_worker(w, timeout=60.0):
    """spawn 后发空请求触发模型加载，确认 worker 就绪再正式使用。

    否则首个正式请求会撞上冷启动（模型加载 20-40s + mel），被 PROC_TIMEOUT
    误杀，kill 后重新 spawn 再次冷启动，形成死循环（正常批全部超时、黑名单
    不增长）。空请求只加载模型，timeout 放宽到 60s。
    """
    try:
        req = {
            "paths": [],
            "sample_rate": 48000,
            "max_samples": 0,
            "model_path": str(config.get_clap_model_name()),
        }
        w.stdin.write(pickle.dumps(req))
        w.stdin.flush()
        box: Dict[str, Any] = {}

        def _rd():
            try:
                box["r"] = pickle.load(w.stdout)
            except Exception as e:
                box["e"] = repr(e)

        t = threading.Thread(target=_rd, daemon=True)
        t.start()
        t.join(timeout)
        if t.is_alive():
            return False
        return "e" not in box
    except Exception:
        return False


def _get_mel_worker():
    global _mel_worker
    if _mel_worker is None:
        with _mel_worker_lock:
            if _mel_worker is None:
                for _attempt in range(2):
                    _mel_worker = _spawn_mel_worker()
                    if _warm_mel_worker(_mel_worker):
                        break
                    _reset_mel_worker()
    return _mel_worker


def reset_mel_worker_safe() -> bool:
    """公开的重启入口：取消任务时用来打断卡在 mel 里的调用。"""
    try:
        _reset_mel_worker()
        return True
    except Exception:
        return False


def _reset_mel_worker():
    global _mel_worker
    with _mel_worker_lock:
        if _mel_worker is not None:
            try:
                _mel_worker.kill()
            except Exception:
                pass
            try:
                _mel_worker.wait(timeout=5)
            except Exception:
                pass
            # Windows 下 Popen.kill 只杀直接子进程；melworker 内部 spawn 的
            # 计算进程（孙进程）需连带强杀，否则毒文件卡死的孙进程成孤儿烧 CPU。
            try:
                import subprocess as _sp

                _sp.run(
                    ["taskkill", "/F", "/T", "/PID", str(_mel_worker.pid)],
                    capture_output=True, timeout=10,
                    # taskkill 是控制台程序：不隐藏窗口时，每次隔离毒文件都会
                    # 弹出一个蓝色 cmd 窗口一闪而过（一分钟可能好几次）。
                    creationflags=getattr(_sp, "CREATE_NO_WINDOW", 0),
                )
            except Exception:
                pass
            try:
                _mel_worker.stdin.close()
            except Exception:
                pass
            try:
                _mel_worker.stdout.close()
            except Exception:
                pass
            _mel_worker = None


def _mel_round_trip(paths, sample_rate, max_samples, timeout):
    """单 worker 提交一批。

    RPC 全程加锁串行：melworker 是单实例，多线程并发写 stdin 会造成
    pickle 流交错、请求错乱，worker 读到脏输入丢弃请求，父进程等结果
    超时误判毒文件，批量把正常文件误杀入黑名单。

    冷启动竞争（worker 活着但尚未就绪）：等就绪后对同一 worker 重试；
    毒文件死锁（读超时）：kill 重启 worker；worker 真崩溃（EOF 且已退出）：
    kill 换新。均重试一次，仍失败返回 {}。

    返回 {path: {input_features: np.ndarray, ...} | None}。
    """
    with _mel_rpc_lock:
        return _mel_round_trip_locked(paths, sample_rate, max_samples, timeout)


def _mel_round_trip_locked(paths, sample_rate, max_samples, timeout):
    import time as _time

    req = {
        "paths": list(paths),
        "sample_rate": int(sample_rate),
        "max_samples": int(max_samples),
        "model_path": str(config.get_clap_model_name()),
    }
    for attempt in range(2):
        w = _get_mel_worker()
        # 写管道必须带超时：worker 卡死时它不再读 stdin，管道缓冲区写满后
        # w.stdin.write() 会**永久阻塞**，读超时那套逻辑根本没机会执行——
        # 这就是「父任务停在 36949/36950 十九分钟」的真正原因。
        payload = pickle.dumps(req)
        write_box: Dict[str, Any] = {}

        def _wr():
            try:
                w.stdin.write(payload)
                w.stdin.flush()
            except Exception as e:
                write_box["e"] = repr(e)

        wt = threading.Thread(target=_wr, daemon=True)
        wt.start()
        wt.join(min(15.0, max(5.0, float(timeout) / 4)))
        if wt.is_alive():
            logging.getLogger(__name__).warning(
                "mel_round_trip write blocked >%.0fs, kill worker and retry",
                min(15.0, max(5.0, float(timeout) / 4)),
            )
            _reset_mel_worker()
            _time.sleep(_MEL_WORKER_READY_WAIT)
            continue
        if "e" in write_box:
            # 写失败（管道断/句柄冲突）：先等就绪再重试同一 worker
            logging.getLogger(__name__).warning(
                "mel_round_trip write fail: %r poll=%s", write_box["e"], w.poll()
            )
            _time.sleep(_MEL_WORKER_READY_WAIT)
            continue
        box: Dict[str, Any] = {}

        def _rd():
            try:
                box["r"] = pickle.load(w.stdout)
            except Exception as e:
                box["e"] = repr(e)
                try:
                    box["err"] = w.stderr.read().decode("utf-8", "replace")[-3000:]
                except Exception:
                    pass

        t = threading.Thread(target=_rd, daemon=True)
        t.start()
        t.join(timeout)
        if t.is_alive():
            # 毒文件死锁：kill 重启，等就绪
            _reset_mel_worker()
            _time.sleep(_MEL_WORKER_READY_WAIT)
            continue
        if "e" in box:
            _log = logging.getLogger(__name__)
            _log.warning("mel_round_trip read err: %s poll=%s", box.get("e"), w.poll())
            if box.get("err"):
                _log.warning("melworker stderr: %s", box["err"])
            # worker 卡死在毒文件上时 read 异常且进程仍未退出（poll None），
            # 一律 kill 重启：不再按“冷启动竞争”保留同一 worker 无限重试。
            _reset_mel_worker()
            _time.sleep(_MEL_WORKER_READY_WAIT)
            continue
        return box.get("r") or {}
    return {}


_note_bad_count: Dict[str, int] = {}


def _note_bad_file(path):
    """记录毒文件：同一文件失败两次才拉黑，且写入用户数据目录并带时间戳。

    单次失败可能只是 worker 冷启动或整批超时的连带结果，直接永久拉黑会
    误伤正常文件（历史上曾因此丢掉 15,000 多条音频索引）。
    """
    with _mel_runtime_blacklist_lock:
        attempts = _note_bad_count.get(path, 0) + 1
        _note_bad_count[path] = attempts
        if path in _mel_runtime_blacklist or attempts < 2:
            return
        _mel_runtime_blacklist.add(path)
    try:
        with open(_blacklist_file(), "a", encoding="utf-8") as f:
            f.write(f"{path}\t{time.time():.0f}\n")
    except Exception:
        pass
def _collect_vectors(chunk, sample_rate, max_samples, sink):
    """把一批路径的向量收进 sink；整块失败时二分定位，而不是逐条重试。

    块里只要有一个毒文件，整块 round trip 就会超时返回空。逐条重试是 O(n) 次
    超时（256 条 × 20s ≈ 85 分钟）；二分是 O(log n)，256 条里 1 个毒文件只需
    ~17 次尝试。只有叶子（单文件）仍失败才判定为毒文件。
    """
    chunk = list(chunk)
    if not chunk:
        return
    result = _mel_round_trip(chunk, sample_rate, max_samples, MEL_RETRY_TIMEOUT)
    missing = []
    for path in chunk:
        vec = result.get(path)
        if vec is not None:
            sink[path] = vec
        else:
            missing.append(path)
    if not missing:
        return
    if len(chunk) == 1:
        _note_bad_file(chunk[0])
        return
    mid = len(chunk) // 2
    _collect_vectors(chunk[:mid], sample_rate, max_samples, sink)
    _collect_vectors(chunk[mid:], sample_rate, max_samples, sink)


def _process_chunks(pending_paths, sample_rate, max_samples, sink,
                    chunk_size=MEL_CHUNK_SIZE, batch_timeout=MEL_BATCH_TIMEOUT):
    """两遍式编码：先编码好文件，再单独处理毒文件。

    旧做法是块失败后立刻二分，于是每个块都要为一个毒文件付出 8 次 worker
    重启（每次 ~25s 模型加载），好文件被堵在身后。现在把两件事拆开：

      pass 1  正常块直接出向量，失败的块只记录待定，不做二分——好文件不再
              为毒文件买单；
      pass 2  只对待定清单二分定位，慢活集中在这里，数量已从几万降到几百。
    """
    deferred = []
    for start in range(0, len(pending_paths), chunk_size):
        chunk = pending_paths[start : start + chunk_size]
        result = _mel_round_trip(chunk, sample_rate, max_samples, batch_timeout)
        for path in chunk:
            vec = result.get(path)
            if vec is not None:
                sink[path] = vec
            else:
                deferred.append(path)
    if not deferred:
        return sink
    # 开关：只跑 pass 1，把定位毒文件的慢活整体推迟。重建要的是"尽快让好文件
    # 入库"，毒文件留给专门的诊断轮次。设置后本轮直接把待定文件判为失败。
    if os.environ.get("ECHOMIND_SKIP_POISON_PASS") == "1":
        logger.warning(
            "skip poison pass: %d deferred paths left unindexed", len(deferred)
        )
        return sink
    for start in range(0, len(deferred), chunk_size):
        _collect_vectors(
            deferred[start : start + chunk_size], sample_rate, max_samples, sink
        )
    return sink


import torch

import config

logger = logging.getLogger(__name__)

if hasattr(config, "HF_ENDPOINT"):
    os.environ.setdefault("HF_ENDPOINT", config.HF_ENDPOINT)
os.environ.setdefault("HF_HUB_DISABLE_SYMLINKS", "1")
os.environ.setdefault("HF_HUB_ENABLE_HF_TRANSFER", "0")

CLAP_PREPROCESSING_VERSION = "clap-deterministic-windows-v2"
_MODEL_HASH_CHUNK_SIZE = 1024 * 1024


def normalize_embedding(value: Any) -> np.ndarray:
    """Return a finite, unit-length float32 vector."""
    vector = np.asarray(value, dtype=np.float32).reshape(-1)
    if vector.size == 0 or not np.all(np.isfinite(vector)):
        raise ValueError("embedding 必须是非空有限向量")
    norm = float(np.linalg.norm(vector))
    if not np.isfinite(norm) or norm <= 1e-12:
        raise ValueError("embedding 范数必须大于 0")
    return vector / norm


def _local_model_descriptor(model_path: Any) -> Dict[str, str]:
    """Return a path-independent identity for one installed local model.

    Release model bundles are verified before their atomic installation, so a
    valid package manifest is the authoritative, cheap identity source. Local
    development directories without such a manifest fall back to streaming
    the actual contents of every model file; filenames and sizes alone are not
    sufficient because weights can change without changing their byte count.
    """
    model_dir = Path(os.fspath(model_path)).expanduser().resolve(strict=False)
    if not model_dir.is_dir():
        raise FileNotFoundError(f"CLAP 本地模型目录不存在: {model_dir}")

    manifest_payload: Dict[str, Any] = {}
    for manifest_path in (
        model_dir.parent / "model-manifest.json",
        model_dir / "model-manifest.json",
    ):
        if not manifest_path.is_file():
            continue
        try:
            candidate = json.loads(manifest_path.read_text(encoding="utf-8"))
            if isinstance(candidate, dict):
                manifest_payload = candidate
                break
        except (OSError, UnicodeDecodeError, ValueError, TypeError):
            logger.warning("CLAP model manifest 无法读取: %s", manifest_path)

    model_id = str(manifest_payload.get("model_id") or "local/clap")
    manifest_revision = str(manifest_payload.get("revision") or "").strip()
    declared_files = manifest_payload.get("files")
    verified_declarations: Dict[str, str] = {}
    if manifest_revision and isinstance(declared_files, dict):
        for raw_relative, raw_checksum in declared_files.items():
            relative = str(raw_relative).replace("\\", "/").strip("/")
            parts = tuple(part for part in relative.split("/") if part)
            checksum = str(raw_checksum or "").strip().lower()
            if (
                not parts
                or any(part in {".", ".."} for part in parts)
                or len(checksum) != 64
                or any(character not in "0123456789abcdef" for character in checksum)
            ):
                continue
            if parts[0] == model_dir.name:
                local_parts = parts[1:]
                canonical_relative = "/".join(parts)
            else:
                local_parts = parts
                canonical_relative = "/".join((model_dir.name, *parts))
            local_file = model_dir.joinpath(*local_parts)
            if local_parts and local_file.is_file():
                verified_declarations[canonical_relative] = checksum

    if verified_declarations:
        identity_payload = {
            "model_id": model_id,
            "revision": manifest_revision,
            "files": dict(sorted(verified_declarations.items())),
        }
        identity_digest = hashlib.sha256(
            json.dumps(identity_payload, ensure_ascii=True, sort_keys=True).encode("utf-8")
        ).hexdigest()
        return {
            "identity": f"local-clap:{identity_digest}",
            "model_id": model_id,
            "revision": manifest_revision,
            "identity_source": "model-manifest",
        }

    content_digest = hashlib.sha256()
    files = sorted(
        (candidate for candidate in model_dir.rglob("*") if candidate.is_file()),
        key=lambda candidate: candidate.relative_to(model_dir).as_posix(),
    )
    for candidate in files:
        if candidate.is_symlink():
            raise ValueError(f"CLAP 模型目录不允许符号链接: {candidate}")
        relative = candidate.relative_to(model_dir).as_posix()
        content_digest.update(relative.encode("utf-8"))
        content_digest.update(b"\0")
        with candidate.open("rb") as source:
            for chunk in iter(lambda: source.read(_MODEL_HASH_CHUNK_SIZE), b""):
                content_digest.update(chunk)
        content_digest.update(b"\0")
    content_sha256 = content_digest.hexdigest()
    identity_payload = {
        "model_id": model_id,
        "revision": manifest_revision or f"content:{content_sha256}",
        "content_sha256": content_sha256,
    }
    identity_digest = hashlib.sha256(
        json.dumps(identity_payload, ensure_ascii=True, sort_keys=True).encode("utf-8")
    ).hexdigest()
    return {
        "identity": f"local-clap:{identity_digest}",
        "model_id": model_id,
        "revision": manifest_revision or f"content:{content_sha256}",
        "identity_source": "content-sha256",
    }


class CLIPEmbedder:
    """Thread-safe singleton wrapper around LAION CLAP."""

    _instance: Optional["CLIPEmbedder"] = None
    _instance_lock = threading.RLock()

    def __new__(cls):
        with cls._instance_lock:
            if cls._instance is None:
                instance = super().__new__(cls)
                instance._initialized = False
                instance._initializing = False
                instance._init_lock = threading.RLock()
                instance._inference_lock = threading.RLock()
                cls._instance = instance
            return cls._instance

    def __init__(self):
        if self._initialized:
            return

        with self._init_lock:
            if self._initialized:
                return
            self._initializing = True
            try:
                self._load_model()
            except Exception:
                # A failed singleton must be retryable after reset_embedder().
                logger.exception("CLAP 模型加载失败")
                raise
            finally:
                self._initializing = False

    def _load_model(self) -> None:
        """(Re)load the CLAP model onto the device. Used at startup and after
        release_gpu() to regain the model for text/audio single-file queries."""
        from transformers import ClapModel, ClapProcessor

        self.device = self._get_device()
        model_path = Path(config.get_clap_model_name()).expanduser()
        descriptor = _local_model_descriptor(model_path)
        logger.info("加载 CLAP 模型 %s 到 %s", model_path, self.device)
        self.model = ClapModel.from_pretrained(
            str(model_path),
            low_cpu_mem_usage=True,
            local_files_only=True,
        )
        self.model.to(self.device)
        self.model.eval()
        self.processor = ClapProcessor.from_pretrained(
            str(model_path), local_files_only=True
        )
        feature_extractor = getattr(self.processor, "feature_extractor", None)
        self.sample_rate = int(getattr(feature_extractor, "sampling_rate", 48000))
        self.max_samples = self._processor_max_samples(feature_extractor)
        self._model_identity = descriptor["identity"]
        # Preserve the historical private name for compatibility with
        # old diagnostics while exposing the package model ID below.
        self._model_name = self._model_identity
        self._model_id = descriptor["model_id"]
        self._model_revision = descriptor["revision"]
        self._fingerprint = self._build_fingerprint()
        self._initialized = True
        logger.info(
            "CLAP 模型加载完成（窗口 %.2fs，fingerprint=%s）",
            self.max_samples / self.sample_rate,
            self._fingerprint[:12],
        )

    def release_gpu(self) -> None:
        """释放父进程的 GPU 模型：全量音频重建的向量计算在 melworker 子进程
        （独立 CUDA 上下文）内完成，父进程若仍持有 GPU 模型，会与子进程的
        CUDA 上下文共存，在部分 Windows 驱动上导致进程级崩溃（无 traceback）。
        释放后如需 text 查询/单文件编码，会经 _ensure_model 惰性重载。"""
        model = getattr(self, "model", None)
        if model is not None:
            try:
                self.model = None
                del model
                import gc

                gc.collect()
                if torch.cuda.is_available():
                    torch.cuda.empty_cache()
                logger.info("父进程已释放 GPU 模型，音频向量计算交给子进程独占 GPU")
            except Exception:
                logger.exception("release_gpu 失败（忽略）")

    def _ensure_model(self) -> None:
        if getattr(self, "model", None) is None:
            with self._init_lock:
                if getattr(self, "model", None) is None:
                    self._load_model()

    def _get_device(self) -> torch.device:
        if torch.cuda.is_available():
            return torch.device("cuda")
        try:
            if torch.backends.mps.is_available():
                return torch.device("mps")
        except AttributeError:
            pass
        return torch.device("cpu")

    def _processor_max_samples(self, feature_extractor: Any) -> int:
        max_samples = getattr(feature_extractor, "nb_max_samples", None)
        if isinstance(max_samples, (int, float)) and max_samples > 0:
            return int(max_samples)
        max_length_s = getattr(feature_extractor, "max_length_s", None)
        if isinstance(max_length_s, (int, float)) and max_length_s > 0:
            return int(round(max_length_s * self.sample_rate))
        # LAION CLAP's published feature extractor uses a 10 second window.
        return 10 * self.sample_rate

    def _build_fingerprint(self) -> str:
        payload = {
            "model": getattr(self, "_model_identity", self._model_name),
            "revision": getattr(self, "_model_revision", "local"),
            "dimension": self.get_embedding_dim(),
            "sample_rate": self.sample_rate,
            "max_samples": self.max_samples,
            "preprocessing": CLAP_PREPROCESSING_VERSION,
        }
        return hashlib.sha256(
            json.dumps(payload, ensure_ascii=True, sort_keys=True).encode("utf-8")
        ).hexdigest()

    @staticmethod
    def _stable_model_identity(model_path: Any) -> str:
        """Identify local model contents without including their install path."""
        return _local_model_descriptor(model_path)["identity"]

    @property
    def fingerprint(self) -> str:
        return self._fingerprint

    @property
    def engine_manifest(self) -> Dict[str, Any]:
        """Describe the exact audio-vector engine without exposing install paths."""
        return {
            "model_id": getattr(self, "_model_id", self._model_name),
            "model_revision": getattr(self, "_model_revision", "local"),
            "dimensions": self.get_embedding_dim(),
            "preprocessing_version": CLAP_PREPROCESSING_VERSION,
            "sample_rate": self.sample_rate,
            "window_samples": self.max_samples,
            "engine_fingerprint": self.fingerprint,
        }

    def audio_to_embedding(self, audio_path: str) -> np.ndarray:
        """Encode an audio file using deterministic processor-sized windows."""
        self._ensure_model()
        try:
            from core.audio_service import get_audio_service

            decoded = get_audio_service().decode(
                audio_path,
                target_sample_rate=self.sample_rate,
                mono=True,
            )
            audio = decoded.samples
            audio = np.asarray(audio, dtype=np.float32).reshape(-1)
            if audio.size == 0:
                raise ValueError("音频为空")
            if audio.size <= self.max_samples:
                return self._process_audio_segment(audio)
            return self._process_long_audio(audio)
        except Exception as exc:
            raise RuntimeError(f"[Embedder] 处理 {audio_path} 失败: {exc}") from exc

    def _processor_inputs(self, audio: np.ndarray):
        # Segments are never longer than max_samples, so rand_trunc cannot pick
        # a random crop. Padding is deterministic for the final short segment.
        kwargs = {
            "sampling_rate": self.sample_rate,
            "max_length": self.max_samples,
            "truncation": "rand_trunc",
            "padding": "repeatpad",
            "return_tensors": "pt",
        }
        try:
            return self.processor(audio=[audio], **kwargs).to(self.device)
        except TypeError:
            return self.processor(audios=[audio], **kwargs).to(self.device)

    @staticmethod
    def _output_vector(outputs: Any) -> np.ndarray:
        tensor = outputs.pooler_output if hasattr(outputs, "pooler_output") else outputs
        return normalize_embedding(tensor.detach().cpu().numpy()[0])

    def _process_audio_segment(self, audio: np.ndarray) -> np.ndarray:
        segment = np.asarray(audio[: self.max_samples], dtype=np.float32)
        with self._inference_lock:
            inputs = self._processor_inputs(segment)
            with torch.inference_mode():
                outputs = self.model.get_audio_features(**inputs)
        return self._output_vector(outputs)

    def _process_long_audio(
        self,
        audio: np.ndarray,
        window_size: Optional[int] = None,
        hop_size: Optional[int] = None,
    ) -> np.ndarray:
        """Encode every deterministic window and mean-pool normalized vectors.

        ``window_size`` and ``hop_size`` remain accepted for compatibility and
        are interpreted as seconds when supplied by older callers.
        """
        window_samples = (
            int(window_size * self.sample_rate) if window_size else self.max_samples
        )
        window_samples = min(max(1, window_samples), self.max_samples)
        hop_samples = int(hop_size * self.sample_rate) if hop_size else window_samples
        hop_samples = max(1, hop_samples)

        embeddings: List[np.ndarray] = []
        for start in range(0, len(audio), hop_samples):
            segment = audio[start : start + window_samples]
            if segment.size == 0:
                continue
            embeddings.append(self._process_audio_segment(segment))
            if start + window_samples >= len(audio):
                break

        if not embeddings:
            raise RuntimeError("无法提取有效的音频片段")
        return normalize_embedding(np.mean(np.stack(embeddings), axis=0))

    def text_to_embedding(self, text: str) -> np.ndarray:
        self._ensure_model()
        text = str(text or "").strip()
        if not text:
            raise ValueError("文本不能为空")
        # CLAP 文本塔的位置编码上限是 77 token；超长 metadata 会让 kernel 越界，
        # 在部分驱动上直接触发 device-side assert（不可恢复，整个 CUDA 上下文报废）。
        text = text[:TEXT_MAX_CHARS]
        try:
            with self._inference_lock:
                inputs = self.processor(text=[text], return_tensors="pt").to(self.device)
                with torch.inference_mode():
                    outputs = self.model.get_text_features(**inputs)
            return self._output_vector(outputs)
        except Exception as exc:
            message = str(exc)
            if "device-side assert" in message or "CUDA error" in message:
                # 上下文已中毒：重试只会继续失败，必须让调用方停下并重启进程。
                raise EmbedderCudaError(
                    f"[Embedder] CUDA 上下文已损坏: {message}"
                ) from exc
            raise RuntimeError(f"[Embedder] 文本嵌入失败: {exc}") from exc

    def get_embedding_dim(self) -> int:
        config_dim = getattr(getattr(self, "model", None), "config", None)
        dim = getattr(config_dim, "projection_dim", 512)
        return int(dim or 512)

    def encode_audio_batch(
        self, audio_paths: Sequence[str]
    ) -> Dict[str, Optional[np.ndarray]]:
        """Encode many audio files with a single batched model forward.

        Per-file output is deterministic and equals ``audio_to_embedding``
        (deterministic windows, mean-pooled, L2-normalized); the batch only
        changes execution order and throughput. Decoding runs on a small
        thread pool; a failed file yields ``None`` without affecting others.
        """
        from concurrent.futures import ThreadPoolExecutor, wait, as_completed
        import time
        from core.audio_service import get_audio_service

        paths = list(audio_paths)
        if not paths:
            return {}
        # 全量音频重建时父进程必须让出 GPU：向量计算全部在 melworker 子进程
        # （独立 CUDA 上下文）内完成，父进程继续持有 GPU 模型会在 Windows 部分
        # 驱动上与子进程上下文共存导致进程级崩溃（无 traceback、循环重启）。
        self.release_gpu()
        # 已知坏文件黑名单：这些特殊格式录音会触发 CUDA device-side assert，
        # 且崩溃会污染整个 GPU 上下文导致后续批次全部失败。跳过它们。
        _BAD_BLACKLIST = _load_blacklist()
        if _BAD_BLACKLIST:
            paths = [p for p in paths if p not in _BAD_BLACKLIST]
            if not paths:
                return {orig: None for orig in audio_paths}
        service = get_audio_service()
        sample_rate = self.sample_rate
        max_samples = self.max_samples

        # decode+mel+GPU forward 全流程在单常驻子进程（melworker.py）内完成，
        # 毒文件在任意阶段死锁（decode/mel/forward）均由父进程超时 kill 重启隔离；
        # 不再在父进程做任何 GPU forward（CUDA 挂起无法杀线程，只能进程级隔离）。
        pass

        # 逐文件做 mel 特征提取（单常驻子进程隔离，可 kill）。
        # 个别毒文件会在 torchaudio mel 频谱 kernel（C 扩展）死锁，并锁污染
        # 同一进程内后续所有 processor 调用（线程超时防护下整批全跳过、零写入）。
        # mel 计算在单常驻子进程：毒文件超时后 kill 重启 worker，不影响主流程；
        # 定位出的毒文件记入黑名单，后续直接跳过。
        # 30s：正常 64 条 mel 批（~5-15s）可通过；毒文件批 30s 放弃并 kill
        # 整棵进程树，随后逐文件 30s 定位入黑名单。太短（8s）会把单文件
        # mel 稍慢的正常大文件误杀入黑名单（曾一夜误杀上万条）；太长（90s）
        # 毒文件定位太慢。
        PROC_TIMEOUT = MEL_BATCH_TIMEOUT
        # 单文件重试预算见模块级 MEL_RETRY_TIMEOUT（20s）：worker 已 warm，
        # 真毒文件不再享受 200s 的超长等待；定位靠二分（_collect_vectors），
        # 不靠逐条扫。
        MEL_CHUNK = MEL_CHUNK_SIZE
        vectors_by_path: Dict[str, np.ndarray] = {}

        pending_paths = list(paths)
        with _mel_runtime_blacklist_lock:
            skip = _mel_runtime_blacklist
        pending_paths = [p for p in pending_paths if p not in skip]
        if not pending_paths:
            return {p: None for p in paths}
        _process_chunks(
            pending_paths, sample_rate, max_samples, vectors_by_path,
            chunk_size=MEL_CHUNK, batch_timeout=PROC_TIMEOUT,
        )

        if not vectors_by_path:
            return {p: None for p in paths}

        result: Dict[str, Optional[np.ndarray]] = {}
        for path, vec in vectors_by_path.items():
            try:
                result[path] = normalize_embedding(
                    np.asarray(vec, dtype=np.float32).reshape(-1)
                )
            except Exception:
                result[path] = None
        return result

        # 合并逐文件 inputs 为批量张量，一次批量 forward
        sample_key = next(iter(inputs_by_path))
        inputs: Dict[str, Any] = {}
        for key, value in inputs_by_path[sample_key].items():
            tensors = []
            for p in inputs_by_path:
                t = inputs_by_path[p][key]
                if isinstance(t, np.ndarray):
                    t = torch.from_numpy(np.ascontiguousarray(t))
                tensors.append(t)
            if all(isinstance(t, torch.Tensor) for t in tensors):
                inputs[key] = torch.cat(tensors, dim=0).to(self.device)
            else:
                inputs[key] = value

        # Sanitize NaN/Inf features: feeding them into the CUDA kernel raises
        # "device-side assert triggered" and permanently poisons the GPU context.
        # Beyond replacing values, drop whole windows whose mel rows are
        # NaN/Inf/all-zero/all-constant (the model's layer-norm divides by zero
        # on constant rows and asserts on device).
        for key, value in inputs.items():
            if isinstance(value, torch.Tensor) and value.dtype.is_floating_point:
                inputs[key] = torch.nan_to_num(
                    value, nan=0.0, posinf=0.0, neginf=0.0
                )
        feats = inputs.get("input_features")
        if feats is not None and isinstance(feats, torch.Tensor) and feats.dim() >= 2:
            # 进一步截断 mel 特征到合理范围（log-mel 正常约 0~20），
            # 防止个别文件因极端增益产生超范围有限值在模型内部溢出。
            feats = feats.clamp(-30.0, 30.0)
            inputs["input_features"] = feats
            flat = feats.reshape(feats.size(0), -1).float()
            row_bad = (
                torch.isnan(flat).any(dim=1)
                | torch.isinf(flat).any(dim=1)
                | (flat.std(dim=1) == 0)
            )
            if bool(row_bad.any()):
                keep = ~row_bad
                for key, value in list(inputs.items()):
                    if (
                        isinstance(value, torch.Tensor)
                        and value.size(0) == feats.size(0)
                    ):
                        inputs[key] = value[keep]
                flat_index = [
                    flat_index[i] for i, k in enumerate(keep.tolist()) if k
                ]
                if len(flat_index) == 0:
                    return {p: None for p in paths}

        # 分块 GPU forward：单次 forward 窗口数过多时，长时间连续大负载
        # 会触发偶发性 CUDA 挂起（批量规模相关，无法靠单文件定位）。
        # 每块 32 窗口 forward 一次（128 窗口实测在 5 万级全量重建落库时
        # 仍会偶发长时间停滞），块间清空显存缓存，降低挂起概率。
        CHUNK = 32
        vectors: Optional[np.ndarray] = None
        with self._inference_lock:
            with torch.inference_mode():
                n_windows = len(flat_index)
                chunk_vecs: List[np.ndarray] = []
                for start in range(0, n_windows, CHUNK):
                    end = min(start + CHUNK, n_windows)
                    sub_inputs = {
                        key: (
                            value[start:end]
                            if isinstance(value, torch.Tensor)
                            and value.size(0) == n_windows
                            else value
                        )
                        for key, value in inputs.items()
                    }
                    outputs = self.model.get_audio_features(**sub_inputs)
                    tensor = (
                        outputs.pooler_output
                        if hasattr(outputs, "pooler_output")
                        else outputs
                    )
                    chunk_vecs.append(tensor.detach().cpu().numpy())
                    if start + CHUNK < n_windows:
                        torch.cuda.empty_cache()
                if chunk_vecs:
                    vectors = np.concatenate(chunk_vecs, axis=0)

        accum: Dict[str, List[np.ndarray]] = {p: [] for p in paths}
        for (path, _win_index), vector in zip(flat_index, vectors):
            accum[path].append(vector)

        result: Dict[str, Optional[np.ndarray]] = {}
        for path, vectors_for_file in accum.items():
            if not vectors_for_file:
                result[path] = None
                continue
            try:
                pooled = np.stack(vectors_for_file).mean(axis=0)
                result[path] = normalize_embedding(pooled)
            except Exception:
                result[path] = None
        return result


@runtime_checkable
class TextEmbeddingProvider(Protocol):
    """Embedding interface for the separate metadata-text index."""

    @property
    def fingerprint(self) -> str: ...

    async def embed_texts(self, texts: List[str]) -> List[np.ndarray]: ...


class CLAPTextEmbeddingProvider:
    def __init__(self, embedder: Optional[CLIPEmbedder] = None):
        # Provider construction happens on FastAPI request/background-task
        # coroutines. Model loading is owned exclusively by ModelPreloader's
        # worker, so never perform a synchronous load from this async path.
        self.embedder = embedder or peek_embedder()
        if self.embedder is None:
            raise RuntimeError("CLAP 模型不可用")

    @property
    def fingerprint(self) -> str:
        return f"clap-text:{self.embedder.fingerprint}"

    async def embed_texts(self, texts: List[str]) -> List[np.ndarray]:
        # CLAP has one shared inference lock; sequential calls avoid scheduling
        # competing model forwards while still keeping the event loop free.
        result: List[np.ndarray] = []
        for text in texts:
            vector = await asyncio.to_thread(self.embedder.text_to_embedding, text)
            result.append(normalize_embedding(vector))
        return result


class OpenAICompatibleTextEmbeddingProvider:
    """Metadata embeddings from LM Studio, Ollama or an OpenAI-compatible API.

    ``endpoint`` may point at a provider-specific route.  Doubao Ark's
    multimodal embedding endpoint (``/embeddings/multimodal``) requires
    structured inputs (``{"type": "text", "text": ...}``), which is handled
    transparently here so the rest of the pipeline stays provider-agnostic.
    """

    def __init__(self, config_data: Dict[str, Any], client: Optional[httpx.AsyncClient] = None):
        self.base_url = str(config_data.get("base_url", "")).rstrip("/")
        self.model = str(config_data.get("model", ""))
        self.api_key = str(config_data.get("api_key", ""))
        self.endpoint = str(config_data.get("endpoint", "/embeddings")).lstrip("/")
        if not self.base_url:
            raise ValueError("Embedding API 地址未配置")
        self._owns_client = client is None
        self._client = client or httpx.AsyncClient(timeout=httpx.Timeout(30.0))

    @property
    def fingerprint(self) -> str:
        payload = {
            "kind": "openai-compatible",
            "url": self.base_url,
            "model": self.model,
            "endpoint": self.endpoint,
        }
        digest = hashlib.sha256(json.dumps(payload, sort_keys=True).encode()).hexdigest()
        return f"openai-text:{digest}"

    async def embed_texts(self, texts: List[str]) -> List[np.ndarray]:
        if not texts:
            return []
        headers = {"Content-Type": "application/json"}
        if self.api_key:
            headers["Authorization"] = f"Bearer {self.api_key}"

        if self.endpoint == "embeddings/multimodal":
            # Doubao multimodal endpoint accepts ONE input per call and
            # returns data as {"embedding": [...]}.  Batch via bounded
            # concurrency (gather preserves order).
            semaphore = asyncio.Semaphore(8)

            async def _embed_one(text: str) -> np.ndarray:
                async with semaphore:
                    response = await self._client.post(
                        f"{self.base_url}/{self.endpoint}",
                        headers=headers,
                        json={"model": self.model, "input": [{"type": "text", "text": text}]},
                    )
                    response.raise_for_status()
                    data = response.json().get("data")
                    if isinstance(data, dict) and "embedding" in data:
                        return normalize_embedding(data["embedding"])
                    raise RuntimeError("Doubao multimodal embedding 返回结构异常")

            return list(await asyncio.gather(*(_embed_one(text) for text in texts)))

        response = await self._client.post(
            f"{self.base_url}/{self.endpoint}",
            headers=headers,
            json={"model": self.model, "input": texts},
        )
        response.raise_for_status()
        raw = response.json().get("data", [])
        if isinstance(raw, dict):
            vectors = [normalize_embedding(raw["embedding"])]
        elif isinstance(raw, list):
            ordered = sorted(raw, key=lambda item: int(item.get("index", 0)))
            vectors = [normalize_embedding(item["embedding"]) for item in ordered]
        else:
            raise RuntimeError("Embedding 服务返回了无法识别的 data 结构")
        if len(vectors) != len(texts):
            raise RuntimeError("Embedding 服务返回的向量数量不匹配")
        return vectors

    async def aclose(self) -> None:
        if self._owns_client:
            await self._client.aclose()


def get_text_embedding_config_fingerprint(
    config_override: Optional[Dict[str, Any]] = None,
) -> str:
    """Hash provider/model settings while explicitly excluding credentials."""
    if config_override is None:
        from core.llm_config_manager import get_llm_config_manager

        config_override = get_llm_config_manager().get_embedding_config()
    safe = json.loads(json.dumps(config_override, default=str))
    for section in safe.values():
        if isinstance(section, dict):
            section.pop("api_key", None)
            section.pop("headers", None)
    digest = hashlib.sha256(
        json.dumps(safe, ensure_ascii=False, sort_keys=True).encode("utf-8")
    ).hexdigest()
    return f"text-config:{digest}"


def get_text_embedding_provider(
    config_override: Optional[Dict[str, Any]] = None,
) -> TextEmbeddingProvider:
    """Build the configured provider for metadata text only."""
    if config_override is None:
        from core.llm_config_manager import get_llm_config_manager

        config_override = get_llm_config_manager().get_embedding_config()
    provider = str(config_override.get("provider", "default"))
    if provider == "default":
        return CLAPTextEmbeddingProvider()
    if provider not in {"local", "external"}:
        raise ValueError(f"不支持的文本 Embedding 提供者: {provider}")
    return OpenAICompatibleTextEmbeddingProvider(config_override.get(provider, {}))


_embedder: Optional[CLIPEmbedder] = None
_embedder_loading_failed = False
_embedder_lock = threading.RLock()


def peek_embedder() -> Optional[CLIPEmbedder]:
    """Return an already-loaded CLAP embedder without starting any load.

    This is the only accessor suitable for event-loop request paths.  It does
    not instantiate the model preloader and never calls ``CLIPEmbedder()``.
    Synchronous indexing workers should continue to use :func:`get_embedder`.
    """
    with _embedder_lock:
        if _embedder is not None and getattr(_embedder, "_initialized", True):
            return _embedder

    # A preloader may own the shared instance without publishing it through
    # this module-level slot.  Inspect only an existing preloader: calling
    # get_preloader() here would create lifecycle state on a request path.
    try:
        from core import model_preloader as preloader_module

        preloader = getattr(preloader_module, "_preloader", None)
        if preloader is not None:
            preloaded = preloader.get_embedder()
            if preloaded is not None and getattr(preloaded, "_initialized", True):
                return preloaded
    except (ImportError, AttributeError):
        pass

    # Cover callers that constructed the singleton directly (including the
    # preloader while it is publishing its result) without constructing a new
    # model or waiting on initialization.
    instance = CLIPEmbedder._instance
    if instance is not None and getattr(instance, "_initialized", False):
        return instance
    return None


def get_embedder() -> Optional[CLIPEmbedder]:
    """Get the shared embedder, preferring the preloaded instance."""
    global _embedder, _embedder_loading_failed
    try:
        from core.model_preloader import get_preloader

        preloaded = get_preloader().get_embedder()
        if preloaded is not None:
            return preloaded
    except ImportError:
        pass

    with _embedder_lock:
        if _embedder is None and not _embedder_loading_failed:
            try:
                _embedder = CLIPEmbedder()
            except Exception as exc:
                logger.error("无法加载模型: %s", exc)
                _embedder_loading_failed = True
        return _embedder


def is_embedder_available() -> bool:
    """Report readiness without constructing or synchronously loading CLAP."""
    return peek_embedder() is not None


def is_embedder_loaded() -> bool:
    return peek_embedder() is not None


def get_embedder_fingerprint(load: bool = False) -> str:
    embedder = get_embedder() if load else peek_embedder()
    return embedder.fingerprint if embedder is not None else "clap:unavailable"


def get_clap_engine_manifest(load: bool = False) -> Dict[str, Any]:
    """Return manifest fields for SQLite index compatibility checks.

    A missing optional model is represented explicitly and never triggers a
    network download. When the model is already loaded, runtime processor and
    dimension values take precedence over package metadata.
    """
    embedder = get_embedder() if load else peek_embedder()
    if embedder is not None:
        return dict(embedder.engine_manifest)

    model_path = Path(config.get_clap_model_name()).expanduser()
    if not model_path.is_dir():
        return {
            "model_id": None,
            "model_revision": "unavailable",
            "preprocessing_version": CLAP_PREPROCESSING_VERSION,
            "dimensions": None,
            "engine_fingerprint": "clap:unavailable",
        }
    try:
        descriptor = _local_model_descriptor(model_path)
    except (OSError, ValueError, TypeError) as exc:
        logger.warning("CLAP 本地模型身份读取失败: %s", exc)
        return {
            "model_id": None,
            "model_revision": "unavailable",
            "preprocessing_version": CLAP_PREPROCESSING_VERSION,
            "dimensions": None,
            "engine_fingerprint": "clap:unavailable",
        }
    fingerprint_payload = {
        "model_identity": descriptor["identity"],
        "model_id": descriptor["model_id"],
        "model_revision": descriptor["revision"],
        "preprocessing_version": CLAP_PREPROCESSING_VERSION,
    }
    fingerprint = hashlib.sha256(
        json.dumps(fingerprint_payload, sort_keys=True).encode("utf-8")
    ).hexdigest()
    return {
        "model_id": descriptor["model_id"],
        "model_revision": descriptor["revision"],
        "preprocessing_version": CLAP_PREPROCESSING_VERSION,
        "dimensions": None,
        "engine_fingerprint": fingerprint,
    }


def reset_embedder() -> None:
    """Fully reset both module and class-level singleton state."""
    global _embedder, _embedder_loading_failed
    with _embedder_lock, CLIPEmbedder._instance_lock:
        _embedder = None
        _embedder_loading_failed = False
        CLIPEmbedder._instance = None
