# -*- coding: utf-8 -*-
"""常驻子进程 mel 特征提取 worker（stdin/stdout pickle 循环）。

父进程通过 stdin 发送 {"paths", "sample_rate", "max_samples", "model_path"}，
worker 逐文件 decode + ClapProcessor，返回 {path: {"input_values": np.ndarray, "attention_mask": np.ndarray} | None}。

设计原因：个别毒文件会在 torchaudio mel 频谱 kernel（C 扩展）死锁，
且会锁污染同一进程内后续所有 processor 调用（6s 超时防护下整批全跳过、零写入）。
子进程隔离后，毒文件进程被父进程 kill/重启，不影响其他 worker 与主流程。
"""

from __future__ import annotations

import os
import pickle
import sys
import threading

import numpy as np

# 脚本以绝对路径启动时 sys.path[0] 是 backend/core，需显式补上 backend 目录
_BACKEND_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _BACKEND_DIR not in sys.path:
    sys.path.insert(0, _BACKEND_DIR)

# Windows 下启动后立即隐藏本进程控制台窗口，避免 worker 重启时闪烁蓝色窗口
if os.name == "nt":
    try:
        import ctypes

        _hwnd = ctypes.windll.kernel32.GetConsoleWindow()
        if _hwnd:
            ctypes.windll.user32.ShowWindow(_hwnd, 0)  # SW_HIDE
    except Exception:
        pass


# 单文件解码超时。正常文件解码 < 1s；30s 会让"慢解码"文件把整个块拖过父进程
# 的批量超时，导致好文件陪葬。8s 足够覆盖慢盘/大文件，又能让块在父进程超时前结束。
DECODE_TIMEOUT = 8.0


def _process_one(service, processor, path, sample_rate, max_samples):
    try:
        # decode 用独立线程 + 超时：个别毒文件会让解码无限挂起（ffmpeg/audioread 卡死），
        # 若在 worker 主线程同步 decode，整批会陪葬被父进程 kill。
        box: dict = {}

        def _decode():
            box["d"] = service.decode(path, target_sample_rate=sample_rate, mono=True)

        t = threading.Thread(target=_decode, daemon=True)
        t.start()
        t.join(DECODE_TIMEOUT)
        if t.is_alive():
            return None, "decode_timeout"
        if "d" not in box:
            return None, ("decode_error:" + str(box.get("e", "unknown"))[:60])
        decoded = box["d"]
        audio = np.asarray(decoded.samples, dtype=np.float32).reshape(-1)
        if audio.size == 0:
            return None, "decode_empty"
        # 极端值防护：CLAP 的 log-mel 对超大样本会触发 CUDA device-side assert
        max_abs = float(np.max(np.abs(audio)))
        if max_abs > 1.0:
            audio = audio / max_abs
        win = audio[:max_samples] if audio.size > max_samples else audio
        if win.size == 0:
            return None, "window_empty"
        if not np.all(np.isfinite(win)):
            win = np.where(np.isfinite(win), win, 0.0).astype(np.float32)
        try:
            out = processor(
                audio=[win],
                sampling_rate=sample_rate,
                max_length=max_samples,
                truncation="rand_trunc",
                padding="repeatpad",
                return_tensors="pt",
            )
        except TypeError:
            out = processor(
                audios=[win],
                sampling_rate=sample_rate,
                max_length=max_samples,
                truncation="rand_trunc",
                padding="repeatpad",
                return_tensors="pt",
            )
        except Exception as exc:
            return None, "processor_error:" + str(exc)[:60]
        return {k: v.numpy() for k, v in out.items()}, ""
    except Exception as exc:
        return None, "process_exception:" + str(exc)[:60]


def _forward_one(model, features):
    """对单文件特征做 GPU forward，返回 512 维向量（或 None）。

    特征先做 nan/inf 清理与数值截断，防止 CUDA kernel 溢出 assert。
    毒特征若导致 forward 挂起，由父进程超时 kill 整个 worker 隔离。
    """
    import torch

    try:
        input_features = features.get("input_features")
        attention_mask = features.get("attention_mask")
        if input_features is None:
            return None
        feat = torch.from_numpy(np.ascontiguousarray(input_features)).float().to(model.device)
        if attention_mask is not None:
            mask = torch.from_numpy(np.ascontiguousarray(attention_mask)).long().to(model.device)
        else:
            mask = None
        feat = torch.nan_to_num(feat, nan=0.0, posinf=0.0, neginf=0.0)
        if feat.numel() > 0:
            feat = feat.clamp(-30.0, 30.0)
        with torch.inference_mode():
            if mask is not None:
                out = model.get_audio_features(input_features=feat, attention_mask=mask)
            else:
                out = model.get_audio_features(input_features=feat)
        tensor = getattr(out, "pooler_output", out)
        return tensor.detach().cpu().numpy()
    except Exception:
        return None


def compute_mel_batch(paths, sample_rate, max_samples, model_path):
    """供 ProcessPoolExecutor 调用的模块级函数（可 pickle，在子进程运行）。

    返回 {path: np.ndarray | None}（512 维音频向量）。
    一批内 processor 只初始化一次；毒文件（mel 卡死）由父进程
    result(timeout) 超时 + 重建池处理。
    """
    from transformers import ClapModel, ClapProcessor

    from core.audio_service import get_audio_service

    try:
        processor = ClapProcessor.from_pretrained(model_path, local_files_only=True)
        service = get_audio_service()
        model = ClapModel.from_pretrained(model_path, local_files_only=True)
        model.eval()
        result = {}
        for p in paths:
            feats, reason = _process_one(service, processor, p, sample_rate, max_samples)
            if feats is None:
                _diag(f'文件处理失败 {reason}: {p[:120]}')
                # 把失败原因带回去（父进程会写进日志/artifact），
                # 否则只有一句「批量编码未产出向量」，根本不知道卡在哪一步。
                result[p] = {"error": reason or "feats_none"}
                continue
            vec = _forward_one(model, feats)
            result[p] = vec if vec is not None else {"error": "forward_none"}
        return result
    except Exception as exc:
        return {p: {"error": "batch_exception:" + str(exc)[:60]} for p in paths}


def _resolve_window(req, sample_rate, max_samples):
    """每个请求都更新窗口参数。

    预热请求带的是 max_samples=0（只加载模型、不算音频）。若把它固化成会话级
    参数，后续每个文件都会取空窗口、一律返回 None——表现就是"全部文件提不出
    特征"，而且不报任何错误。
    """
    rate = int(req.get("sample_rate") or 0)
    window = int(req.get("max_samples") or 0)
    if rate > 0:
        sample_rate = rate
    if window > 0:
        max_samples = window
    return sample_rate, max_samples


def _diag(msg: str) -> None:
    """把 worker 侧信息写到文件：子进程的 stderr 父进程通常看不到。"""
    try:
        import os
        import time

        base = os.path.join(os.environ.get('APPDATA', '.'), 'EchoMind', 'logs')
        os.makedirs(base, exist_ok=True)
        with open(os.path.join(base, 'melworker.log'), 'a', encoding='utf-8') as fh:
            fh.write(f'{time.strftime("%Y-%m-%d %H:%M:%S")} {msg}\n')
    except Exception:
        pass


def _main() -> None:
    _diag('worker 启动')
    for name in ('cffi', 'miniaudio'):
        try:
            mod = __import__(name)
            _diag(f'{name} 导入成功 {getattr(mod, "__version__", "")}')
        except Exception as exc:
            _diag(f'{name} 导入失败: {exc!r}')
    from transformers import ClapModel, ClapProcessor

    from core.audio_service import get_audio_service

    processor = None
    service = None
    model = None
    sample_rate = 48000
    max_samples = 0
    while True:
        try:
            req = pickle.load(sys.stdin.buffer)
        except EOFError:
            break
        except Exception:
            # 脏输入：清掉并继续
            continue
        if processor is None:
            model_path = req.get("model_path")
            processor = ClapProcessor.from_pretrained(model_path, local_files_only=True)
            service = get_audio_service()
            model = ClapModel.from_pretrained(model_path, local_files_only=True)
            model.eval()
            sample_rate = int(req["sample_rate"])
            max_samples = int(req["max_samples"])
        sample_rate, max_samples = _resolve_window(req, sample_rate, max_samples)
        results = {}
        for path in req.get("paths", []):
            feats = _process_one(
                service, processor, path, sample_rate, max_samples
            )
            if feats is None:
                results[path] = None
                continue
            vec = _forward_one(model, feats)
            results[path] = vec if vec is not None else None
        try:
            sys.stdout.buffer.write(pickle.dumps(results))
            sys.stdout.buffer.flush()
        except BrokenPipeError:
            break


if __name__ == "__main__":
    _main()
