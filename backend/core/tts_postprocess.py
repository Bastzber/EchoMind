# -*- coding: utf-8 -*-
"""长音频后处理：压缩过长的静音，并可整体提速。

Breeze 本地模型的两个毛病，实测数据（232 字 / 91.8 秒那次）：
  语速      2.53 字/秒   正常朗读 4~5 字/秒
  静音占比  22.8%        其中 13 处超过 0.35 秒，共 6.84 秒
听感就是「一顿一顿、拖拖拉拉」。

这里做两件事，都不改变音色：
  1. 静音压缩：超过阈值的停顿压短，句子接得更紧
  2. 整体提速：用 ffmpeg 的 atempo，变速不变调

为什么用 atempo 而不是简单重采样：重采样会连音高一起改，
男声会变成尖嗓子。atempo 是时域处理，音高不动。
"""
from __future__ import annotations

import io
import wave
from pathlib import Path
from typing import Dict

import numpy as np

# 超过这个长度的静音会被压缩
MAX_PAUSE_SECONDS = 0.35
# 压缩后的目标长度
TARGET_PAUSE_SECONDS = 0.18
# 静音判定阈值（相对满幅）
SILENCE_THRESHOLD = 0.006
# 两端的留白保留长度
EDGE_KEEP_SECONDS = 0.08


def _read_wav(path: Path) -> Dict[str, object]:
    with wave.open(str(path), 'rb') as reader:
        channels = reader.getnchannels()
        width = reader.getsampwidth()
        rate = reader.getframerate()
        frames = reader.readframes(reader.getnframes())
    samples = np.frombuffer(frames, dtype=np.int16).astype(np.float32) / 32768.0
    if channels > 1:
        samples = samples.reshape(-1, channels).mean(axis=1)
    return {'samples': samples, 'rate': rate, 'width': width}


def _write_wav(path: Path, samples: np.ndarray, rate: int) -> None:
    clipped = np.clip(samples, -1.0, 1.0)
    pcm = (clipped * 32767.0).astype(np.int16)
    with wave.open(str(path), 'wb') as writer:
        writer.setnchannels(1)
        writer.setsampwidth(2)
        writer.setframerate(rate)
        writer.writeframes(pcm.tobytes())


def compress_pauses(samples: np.ndarray, rate: int,
                    max_pause: float = MAX_PAUSE_SECONDS,
                    target_pause: float = TARGET_PAUSE_SECONDS) -> np.ndarray:
    """把过长的静音段压到目标长度。

    只动纯静音段，语音部分一个采样点都不碰，所以不会伤到音质。
    """
    if samples.size == 0:
        return samples
    quiet = np.abs(samples) < SILENCE_THRESHOLD
    max_len = int(rate * max_pause)
    target_len = int(rate * target_pause)

    pieces = []
    cursor = 0
    index = 0
    total = len(samples)
    while index < total:
        if not quiet[index]:
            index += 1
            continue
        start = index
        while index < total and quiet[index]:
            index += 1
        run_len = index - start
        if run_len < max_len:
            continue
        # 段首段尾的留白保留一点，中间压掉
        keep_head = min(target_len // 2, run_len // 2)
        keep_tail = min(target_len - keep_head, run_len - keep_head)
        pieces.append((cursor, start + keep_head))
        cursor = index - keep_tail
    if not pieces:
        return samples
    pieces.append((cursor, total))

    chunks = [samples[a:b] for a, b in pieces if b > a]
    if not chunks:
        return samples
    return np.concatenate(chunks)


def speed_up(path: Path, tempo: float) -> bool:
    """用 atempo 整体提速，音高不变。返回是否成功。"""
    if tempo <= 1.001:
        return False
    try:
        import av
    except Exception:
        return False

    source = Path(path)
    temp = source.with_name(source.stem + '.speed.tmp.wav')
    try:
        with av.open(str(source)) as inp:
            in_stream = inp.streams.audio[0]
            layout_name = in_stream.layout.name if in_stream.layout else 'mono'
            graph = av.filter.Graph()
            buffer_node = graph.add_abuffer(
                format='s16',
                sample_rate=in_stream.rate,
                layout=layout_name,
                time_base=None,
            )
            atempo_node = graph.add('atempo', str(round(float(tempo), 3)))
            sink = graph.add('abuffersink')
            buffer_node.link_to(atempo_node)
            atempo_node.link_to(sink)
            graph.configure()

            # PyAV 18 的 AudioFrame 没有 reformat，要用 AudioResampler 统一格式
            resampler = av.AudioResampler(format='s16', layout=layout_name, rate=in_stream.rate)
            with av.open(str(temp), 'w', format='wav') as out:
                out_stream = out.add_stream('pcm_s16le', rate=in_stream.rate)
                out_stream.layout = layout_name
                for frame in inp.decode(in_stream):
                    for converted in resampler.resample(frame):
                        buffer_node.push(converted)
                for converted in resampler.resample(None):
                    buffer_node.push(converted)
                buffer_node.push(None)
                # sink.pull() 一次返回一帧，没数据时抛 EOFError
                while True:
                    try:
                        out_frame = sink.pull()
                    except (EOFError, av.error.EOFError):
                        break
                    if out_frame is None:
                        break
                    for packet in out_stream.encode(out_frame):
                        out.mux(packet)
                for packet in out_stream.encode(None):
                    out.mux(packet)
        temp.replace(source)
        return True
    except Exception:
        try:
            if temp.exists():
                temp.unlink()
        except Exception:
            pass
        return False


def tighten(path: str, tempo: float = 1.0) -> Dict[str, object]:
    """对一个已经写好的 wav 做后处理。失败时保持原文件不动。"""
    target = Path(path)
    if not target.is_file():
        return {'ok': False, 'reason': 'file-missing'}
    before = target.stat().st_size
    result: Dict[str, object] = {'ok': False}
    try:
        data = _read_wav(target)
        samples = data['samples']
        rate = int(data['rate'])
        duration_before = len(samples) / float(rate)
        trimmed = compress_pauses(samples, rate)
        if len(trimmed) < len(samples):
            _write_wav(target, trimmed, rate)
        duration_mid = len(trimmed) / float(rate)
        result.update({
            'ok': True,
            'duration_before': round(duration_before, 2),
            'duration_after_pause': round(duration_mid, 2),
            'saved_by_pause': round(duration_before - duration_mid, 2),
        })
        if tempo > 1.001:
            if speed_up(target, tempo):
                after = _read_wav(target)
                result['duration_final'] = round(len(after['samples']) / float(after['rate']), 2)
                result['tempo'] = tempo
            else:
                result['duration_final'] = round(duration_mid, 2)
                result['tempo'] = 1.0
        else:
            result['duration_final'] = round(duration_mid, 2)
            result['tempo'] = 1.0
    except Exception as exc:  # pragma: no cover - 后处理失败不该影响主流程
        result = {'ok': False, 'reason': str(exc)[:160]}
    result['size_delta'] = int(target.stat().st_size) - before
    return result
