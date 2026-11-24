# -*- coding: utf-8 -*-
"""OmniVoice 内置引擎的子进程 worker（pickle + stdio RPC）。

为什么要子进程：OmniVoice 是 3GB 级的 Qwen3 底座 + 音频码本，跑在 CUDA 上；
驱动/显存出问题会直接把进程带走。放在独立进程里，崩了只丢这一条，主服务照跑。
跟 melworker 同一套协议（pickle 请求 / pickle 应答），父进程侧见 omnivoice_local.py。

协议：
    {"op": "ping"}                                  -> {"ok": True, "sample_rate": 24000}
    {"op": "synth", "text": str, "ref_audio": str,
     "ref_text": str, "speed": float}               -> {"ok": True, "pcm": bytes, "sample_rate": int}
                                                    或 {"ok": False, "error": str}
"""
from __future__ import annotations

import os
import pickle
import sys
import traceback
from pathlib import Path

def _vendor_candidates():
    """vendored omnivoice 的位置：冻结包在 sys._MEIPASS/vendor，源码运行在 backend/vendor。"""
    seen = []
    meipass = getattr(sys, "_MEIPASS", "")
    if meipass:
        seen.append(Path(meipass) / "vendor")
    here = Path(__file__).resolve()
    seen.append(here.parents[1] / "vendor")
    seen.append(here.parent / "vendor")
    return seen


for _candidate in _vendor_candidates():
    if (_candidate / "omnivoice").is_dir():
        if str(_candidate) not in sys.path:
            sys.path.insert(0, str(_candidate))
        os.environ.setdefault("ECHOMIND_OMNIVOICE_VENDOR", str(_candidate))
        break

_MODEL = None
_CHECKPOINT = ""


def _load(checkpoint: str):
    global _MODEL, _CHECKPOINT
    if _MODEL is not None and _CHECKPOINT == checkpoint:
        return _MODEL
    import torch
    from omnivoice import OmniVoice

    device = "cuda" if torch.cuda.is_available() else "cpu"
    dtype = torch.bfloat16 if device == "cuda" else torch.float32
    try:
        _MODEL = OmniVoice.from_pretrained(
            checkpoint, device_map=device, dtype=dtype, load_asr=False
        )
    except ImportError as exc:
        # device_map 需要 accelerate；冻结包里万一没带上，退回手动搬模型
        if "accelerate" not in str(exc):
            raise
        _MODEL = OmniVoice.from_pretrained(checkpoint, dtype=dtype, load_asr=False)
        _MODEL = _MODEL.to(device)
    _CHECKPOINT = checkpoint
    return _MODEL


def _handle(req: dict) -> dict:
    op = str(req.get("op") or "")
    if op == "ping":
        return {"ok": True, "sample_rate": 24000}
    if op != "synth":
        return {"ok": False, "error": "unknown op: " + op}

    text = str(req.get("text") or "").strip()
    if not text:
        return {"ok": False, "error": "文本不能为空"}
    checkpoint = str(req.get("checkpoint") or "")
    if not checkpoint:
        return {"ok": False, "error": "缺少模型目录"}

    model = _load(checkpoint)
    kwargs = {}
    ref_audio = str(req.get("ref_audio") or "").strip()
    ref_text = str(req.get("ref_text") or "").strip()
    if ref_audio and ref_text:
        kwargs["ref_audio"] = ref_audio
        kwargs["ref_text"] = ref_text
    try:
        speed = float(req.get("speed") or 1.0)
        if abs(speed - 1.0) > 0.01:
            kwargs["speed"] = max(0.5, min(2.0, speed))
    except Exception:
        pass

    audios = model.generate(text, **kwargs)
    if not audios:
        return {"ok": False, "error": "模型没有返回音频"}
    audio = audios[0].detach().to("cpu").float().numpy().squeeze()
    sample_rate = int(getattr(model, "sampling_rate", 24000) or 24000)
    import numpy as np

    pcm = (np.clip(audio, -1.0, 1.0) * 32767.0).astype("<i2").tobytes()
    return {"ok": True, "pcm": pcm, "sample_rate": sample_rate}


def _main() -> None:
    stdin = sys.stdin.buffer
    stdout = sys.stdout.buffer
    while True:
        try:
            req = pickle.load(stdin)
        except EOFError:
            return
        except Exception:
            return
        try:
            reply = _handle(req)
        except Exception as exc:
            reply = {"ok": False, "error": "%s: %s" % (type(exc).__name__, str(exc)[:300])}
            try:
                traceback.print_exc(file=sys.stderr)
            except Exception:
                pass
        try:
            pickle.dump(reply, stdout)
            stdout.flush()
        except Exception:
            return


if __name__ == "__main__":
    _main()
