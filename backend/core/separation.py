# -*- coding: utf-8 -*-
"""AI 分轨（Demucs）：把人声、鼓、贝斯、其他拆成独立 WAV。

相比中置声道消除，Demucs 是神经网络分离，人声干净、低频不会被削掉；
代价是要下模型、每首歌十几到几十秒（有显卡更快）。
"""
from __future__ import annotations

import logging
import threading
from pathlib import Path
from typing import Dict, List, Optional

logger = logging.getLogger(__name__)

# htdemucs 默认 4 轨；htdemucs_ft 是微调版，质量更好但慢 4 倍
SUPPORTED_MODELS = ("htdemucs", "htdemucs_ft")
DEFAULT_MODEL = "htdemucs"

_MODEL_CACHE: Dict[str, object] = {}
_MODEL_LOCK = threading.Lock()


def _pick_device() -> str:
    try:
        import torch
        if torch.cuda.is_available():
            return "cuda"
    except Exception:
        pass
    return "cpu"


def load_model(model_name: str = DEFAULT_MODEL):
    """懒加载并缓存模型（第一次会下载权重，约 80~300 MB）。"""
    if model_name not in SUPPORTED_MODELS:
        model_name = DEFAULT_MODEL
    with _MODEL_LOCK:
        if model_name in _MODEL_CACHE:
            return _MODEL_CACHE[model_name]
        from demucs.pretrained import get_model

        logger.info("加载 Demucs 模型: %s（首次会下载权重）", model_name)
        model = get_model(model_name)
        model.eval()
        device = _pick_device()
        try:
            model.to(device)
        except Exception as exc:
            logger.warning("Demucs 放到 %s 失败（%s），回退 CPU", device, exc)
            device = "cpu"
        _MODEL_CACHE[model_name] = (model, device)
        logger.info("Demucs 就绪: %s @ %s", model_name, device)
        return _MODEL_CACHE[model_name]


def _load_audio(path: Path, samplerate: int, channels: int):
    """用 PyAV 解码成 (channels, samples) 的 float32 张量（不依赖外部 ffmpeg）。"""
    import av
    import numpy as np
    import torch

    layout = "stereo" if channels >= 2 else "mono"
    chunks = []
    with av.open(str(path)) as container:
        stream = next((s for s in container.streams if s.type == "audio"), None)
        if stream is None:
            raise RuntimeError("文件里没有音频流")
        resampler = av.AudioResampler(format="fltp", layout=layout, rate=samplerate)
        for frame in container.decode(stream):
            for out_frame in resampler.resample(frame):
                chunks.append(out_frame.to_ndarray())
        for out_frame in resampler.resample(None):
            chunks.append(out_frame.to_ndarray())

    if not chunks:
        raise RuntimeError("没有解出音频数据")
    data = np.concatenate(chunks, axis=1)
    if channels >= 2 and data.shape[0] == 1:
        data = np.repeat(data, channels, axis=0)
    return torch.from_numpy(np.ascontiguousarray(data))


def _save_wav(tensor, path: Path, samplerate: int) -> None:
    """把 (channels, samples) 的 float 张量写成 16bit PCM WAV（不依赖 ffmpeg / soundfile）。"""
    import numpy as np
    import wave

    data = tensor.detach().cpu().float().numpy()
    if data.ndim == 1:
        data = data[None, :]
    channels = int(data.shape[0])
    peak = float(np.max(np.abs(data))) if data.size else 0.0
    if peak > 0.999:
        data = data / peak * 0.999
    interleaved = np.clip(data.T, -1.0, 1.0)
    pcm = (interleaved * 32767.0).astype("<i2")
    path.parent.mkdir(parents=True, exist_ok=True)
    with wave.open(str(path), "wb") as handle:
        handle.setnchannels(channels)
        handle.setsampwidth(2)
        handle.setframerate(int(samplerate))
        handle.writeframes(pcm.tobytes())


def separate(
    source: str,
    out_dir: str,
    model_name: str = DEFAULT_MODEL,
    stems: Optional[List[str]] = None,
    write_instrumental: bool = True,
) -> Dict[str, object]:
    """把一首歌拆成多轨。

    stems 为空时输出模型自带的全部轨（htdemucs 是 vocals/drums/bass/other）。
    返回 {ok, stems: {名称: 路径}, instrumental, error}
    """
    import torch
    from demucs.apply import apply_model

    src = Path(source)
    if not src.is_file():
        return {"ok": False, "stems": {}, "instrumental": "", "error": "源文件不存在"}

    try:
        model, device = load_model(model_name)
        samplerate = model.samplerate
        channels = getattr(model, "audio_channels", 2)

        wav = _load_audio(src, samplerate, channels)
        if wav.shape[0] == 1 and channels == 2:
            wav = wav.repeat(2, 1)
        ref = wav.mean(0)
        mean = ref.mean()
        std = ref.std() if float(ref.std()) > 1e-8 else torch.tensor(1.0)
        normalized = (wav - mean) / std

        with torch.no_grad():
            sources = apply_model(model, normalized[None], device=device, progress=False)[0]
        sources = sources * std + mean

        names = list(getattr(model, "sources", ["drums", "bass", "other", "vocals"]))
        wanted = [name for name in names if not stems or name in stems]
        if not wanted:
            wanted = names

        target_dir = Path(out_dir)
        target_dir.mkdir(parents=True, exist_ok=True)
        written: Dict[str, str] = {}
        for index, name in enumerate(names):
            if name not in wanted:
                continue
            out_path = target_dir / f"{src.stem}_{name}.wav"
            _save_wav(sources[index], out_path, samplerate)
            written[name] = str(out_path)

        instrumental_path = ""
        if write_instrumental and "vocals" in names and len(names) > 1:
            keep = [i for i, name in enumerate(names) if name != "vocals"]
            mix = sum(sources[i] for i in keep)
            peak = float(mix.abs().max()) if mix.numel() else 0.0
            if peak > 0.99:
                mix = mix * (0.99 / peak)
            instrumental_path = str(target_dir / f"{src.stem}_instrumental.wav")
            _save_wav(mix, Path(instrumental_path), samplerate)

        return {
            "ok": True,
            "stems": written,
            "instrumental": instrumental_path,
            "device": device,
            "model": model_name,
            "error": "",
        }
    except Exception as exc:
        logger.warning("Demucs 分轨失败 %s: %s", src.name, exc)
        return {"ok": False, "stems": {}, "instrumental": "", "error": f"{type(exc).__name__}: {str(exc)[:180]}"}
