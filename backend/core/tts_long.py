# -*- coding: utf-8 -*-
"""长文本转语音：流式读 Breeze 的 chunked 响应，边收边写 WAV，进度可查。

为什么单独一个模块：
  一次 10 分钟的稿子要跑 6 分钟以上，不能像短句那样同步等 HTTP 返回
  （前端会一直转圈、用户以为卡死、超时还可能被代理掐断）。
  Breeze 的 /v1/audio/speech 本来就按 2 秒音频一 chunk 推，
  这里把它读下来直接追加进目标 WAV，进度按已落盘字节算。

输出位置由调用方给（用户自定义文件夹），不给就落 %APPDATA%\\EchoMind\\generated\\YYYYMMDD。
"""
from __future__ import annotations

import json
import logging
import os
import struct
import threading
import time
import urllib.error
import urllib.request
import uuid
import wave
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, Optional

logger = logging.getLogger(__name__)

SAMPLE_RATE = 24000
# 后处理提速倍数：1.0 表示只压静音不提速。
# Breeze 默认语速 2.5 字/秒，1.2 倍后到 3.0 左右，接近自然朗读又不过分赶。
# 实测（232 字那段）：
#   原始 Breeze 输出          104 秒   2.23 字/秒
#   压静音 + 1.2 倍           81.6 秒  2.84 字/秒   最长停顿 0.78 -> 0.22 秒
#   压静音 + 1.3 倍           75.3 秒  3.08 字/秒
#   压静音 + 1.45 倍          67.5 秒  3.44 字/秒（再高开始有金属音）
# 取 1.3：听感自然，停顿也压到位了。要更快用 ECHOMIND_TTS_TEMPO 覆盖。
TEMPO = float(os.environ.get('ECHOMIND_TTS_TEMPO', '1.3'))

# job_id -> 进度字典。只放内存：长文本生成是交互操作，重启丢了就重来。
_JOBS: Dict[str, Dict[str, Any]] = {}
_JOBS_LOCK = threading.Lock()
_MAX_JOBS = 40


def default_out_dir() -> Path:
    base = Path(os.environ.get('APPDATA') or Path.home()) / 'EchoMind' / 'generated'
    target = base / datetime.now().strftime('%Y%m%d')
    target.mkdir(parents=True, exist_ok=True)
    return target


def _safe_name(name: str, fallback: str) -> str:
    """文件名去掉 Windows 不认的字符，保留中文。"""
    raw = (name or '').strip() or fallback
    bad = '<>:"/\\|?*\r\n\t'
    cleaned = ''.join(ch for ch in raw if ch not in bad).strip(' .')
    if not cleaned:
        cleaned = fallback
    if not cleaned.lower().endswith('.wav'):
        cleaned += '.wav'
    return cleaned[:120]


def _resolve_target(out_dir: Optional[str], filename: Optional[str]) -> Path:
    # 用户自己选的目录：不创建不存在的父级链（错的盘符会静默造目录）
    if out_dir:
        folder = Path(out_dir).expanduser()
        if not folder.is_dir():
            raise ValueError('输出文件夹不存在：%s' % folder)
    else:
        folder = default_out_dir()
    stamp = datetime.now().strftime('%H%M%S')
    return folder / _safe_name(filename or ('语音_%s' % stamp), '语音_%s' % stamp)


def _open_wav(path: Path, channels: int = 1) -> wave.Wave_write:
    w = wave.open(str(path), 'wb')
    w.setnchannels(channels)
    w.setsampwidth(2)
    w.setframerate(SAMPLE_RATE)
    return w


def _event(job_id: str, **fields: Any) -> None:
    with _JOBS_LOCK:
        job = _JOBS.get(job_id)
        if not job:
            return
        job.update(fields)
        job['updated_at'] = time.time()


def get_job(job_id: str) -> Optional[Dict[str, Any]]:
    with _JOBS_LOCK:
        job = _JOBS.get(job_id)
        return dict(job) if job else None


def cancel_job(job_id: str) -> bool:
    with _JOBS_LOCK:
        job = _JOBS.get(job_id)
        if not job or job.get('status') not in ('running', 'queued'):
            return False
        job['cancel_requested'] = True
    return True


def _prune() -> None:
    with _JOBS_LOCK:
        if len(_JOBS) <= _MAX_JOBS:
            return
        finished = [
            (jid, j) for jid, j in _JOBS.items()
            if j.get('status') in ('done', 'failed', 'cancelled')
        ]
        finished.sort(key=lambda kv: kv[1].get('updated_at', 0))
        for jid, _ in finished[: max(0, len(_JOBS) - _MAX_JOBS)]:
            _JOBS.pop(jid, None)


def _worker(
    job_id: str,
    text: str,
    target: Path,
    split_chars: int,
    breeze_parts: Dict[str, Any],
) -> None:
    """后台线程：读 Breeze 流、边写 WAV、边更新进度。"""
    started = time.time()
    total_bytes = 0
    writer = None
    try:
        req = urllib.request.Request(
            breeze_parts['url'], data=breeze_parts['body'],
            headers=breeze_parts['headers'], method='POST',
        )
        # 估时长给前端展示：中文约 5.3 字/秒
        estimate = max(1.0, len(text) / 5.3)
        _event(job_id, status='running', estimated_seconds=round(estimate, 1),
               started_at=started, target=str(target))

        with urllib.request.urlopen(req, timeout=7200) as resp:
            writer = _open_wav(target)
            while True:
                with _JOBS_LOCK:
                    if (_JOBS.get(job_id) or {}).get('cancel_requested'):
                        break
                chunk = resp.read(65536)
                if not chunk:
                    break
                writer.writeframes(chunk)
                total_bytes += len(chunk)
                seconds = total_bytes / (SAMPLE_RATE * 2)
                pct = min(99.0, seconds / estimate * 100.0) if estimate else 0.0
                _event(
                    job_id,
                    seconds_generated=round(seconds, 1),
                    bytes=total_bytes,
                    progress=round(pct, 1),
                )
    except Exception as exc:
        logger.warning('[TTS-Long] 生成失败 %s: %s', job_id, exc)
        _event(job_id, status='failed', error='%s: %s' % (type(exc).__name__, str(exc)[:300]))
        return
    finally:
        if writer is not None:
            try:
                writer.close()
            except Exception:
                pass

    with _JOBS_LOCK:
        cancelled = bool((_JOBS.get(job_id) or {}).get('cancel_requested'))
    seconds = total_bytes / (SAMPLE_RATE * 2)
    if cancelled:
        _event(job_id, status='cancelled', seconds_generated=round(seconds, 1),
               progress=round(min(99.0, seconds / max(1.0, len(text) / 5.3) * 100), 1))
        return
    # 后处理：压缩过长静音 + 整体提速。Breeze 默认语速约 2.5 字/秒，
    # 而且停顿偏长，听感一顿一顿的。这里压完静音再按 TEMPO 提速，
    # 音高不变（atempo 是时域处理）。失败就保持原文件，不影响生成结果。
    post = {}
    try:
        from core.tts_postprocess import tighten

        post = tighten(str(target), tempo=TEMPO)
        if post.get('ok') and post.get('duration_final'):
            seconds = float(post['duration_final'])
            total_bytes = target.stat().st_size
            logger.info(
                '[TTS-Long] 后处理 %s: %.1f -> %.1f 秒 (静音省 %.1f, 提速 %.2fx)',
                job_id, post.get('duration_before', seconds), seconds,
                post.get('saved_by_pause', 0), post.get('tempo', 1.0),
            )
    except Exception as exc:
        logger.warning('[TTS-Long] 后处理跳过 %s: %s', job_id, exc)
        post = {'ok': False, 'reason': str(exc)[:120]}

    _event(
        job_id, status='done', progress=100.0,
        seconds_generated=round(seconds, 1), bytes=total_bytes,
        path=str(target), elapsed=round(time.time() - started, 1),
        postprocess=post,
    )
    logger.info('[TTS-Long] 完成 %s -> %s (%.1f 秒音频)', job_id, target, seconds)


def start_long_tts(
    text: str,
    breeze_parts: Dict[str, Any],
    out_dir: Optional[str] = None,
    filename: Optional[str] = None,
    split_chars: int = 150,
) -> Dict[str, Any]:
    """起一个后台生成任务，立刻返回 job_id。"""
    content = (text or '').strip()
    if not content:
        raise ValueError('文本不能为空')
    if len(content) > 200000:
        raise ValueError('文本太长（上限 20 万字）')
    target = _resolve_target(out_dir, filename)
    # 同名覆盖会悄悄毁掉上一次的成品，加时间戳后缀
    if target.exists():
        target = target.with_name('%s_%s.wav' % (target.stem, datetime.now().strftime('%H%M%S')))

    job_id = uuid.uuid4().hex[:12]
    with _JOBS_LOCK:
        _JOBS[job_id] = {
            'job_id': job_id,
            'status': 'queued',
            'progress': 0.0,
            'seconds_generated': 0.0,
            'bytes': 0,
            'chars': len(content),
            'target': str(target),
            'created_at': time.time(),
            'updated_at': time.time(),
        }
    _prune()

    thread = threading.Thread(
        target=_worker,
        args=(job_id, content, target, split_chars, breeze_parts),
        name='tts-long-' + job_id,
        daemon=True,
    )
    thread.start()
    return get_job(job_id) or {'job_id': job_id, 'status': 'queued'}
