# -*- coding: utf-8 -*-
"""Breeze 语音服务守护：健康探测 + 崩溃后自动拉起。

背景：breeze-server 是 C++ 原生进程，遇到畸形输入会 0xc0000005 直接退出
（P8 已在源头上加标准化，但驱动/显存问题仍可能让它崩）。
以前崩了之后界面一直转圈，用户得关掉整个 EchoMind 再开 —— 语音功能等于挂了。

这里每 15 秒探一次 /health，连续 3 次失败就按候选路径把服务重新拉起来，
并且限制重启频率，避免一个坏模型把 CPU 占死。
"""
from __future__ import annotations

import json
import logging
import os
import subprocess
import sys
import threading
import time
import urllib.request
from pathlib import Path
from typing import Any, Dict, List, Optional

logger = logging.getLogger(__name__)

PROBE_INTERVAL = 15.0          # 每 15 秒探一次
FAILURES_BEFORE_RESTART = 3    # 连续 3 次失败（45 秒）才重启，避开瞬时抖动
STARTUP_GRACE = 20.0           # 刚启动时给 20 秒宽限，模型加载慢
MAX_RESTARTS = 3               # 10 分钟内最多重启 3 次
RESTART_WINDOW = 600.0

_state: Dict[str, Any] = {
    'running': False,
    'thread': None,
    'failures': 0,
    'restarts': [],
    'last_error': '',
    'last_healthy': 0.0,
}
_lock = threading.Lock()


def _backend_root() -> Path:
    """打包后是 resources/backend/soundbot-backend，取上两级的 resources。"""
    if getattr(sys, 'frozen', False):
        return Path(sys.executable).resolve().parent.parent.parent
    return Path(__file__).resolve().parent.parent.parent


def _candidates() -> List[Path]:
    env_dir = os.environ.get('ECHOMIND_BREEZE_DIR')
    out: List[Path] = []
    if env_dir:
        out.append(Path(env_dir))
    out.append(_backend_root() / 'breeze')
    appdata = os.environ.get('APPDATA')
    if appdata:
        out.append(Path(appdata) / 'EchoMind' / 'breeze')
    out.append(Path('E:/AI音效管理器/breeze'))
    return out


def _find_file(base: Path, names: List[str], depth: int = 2) -> Optional[Path]:
    if not base.exists():
        return None
    for name in names:
        direct = base / name
        if direct.is_file():
            return direct
    if depth <= 0:
        return None
    try:
        for entry in base.iterdir():
            if entry.is_dir():
                found = _find_file(entry, names, depth - 1)
                if found:
                    return found
    except OSError:
        pass
    return None


def resolve_paths() -> Optional[Dict[str, str]]:
    """找 breeze-server.exe 和 gguf 模型。找不到返回 None。"""
    model_names = ['breeze-tts-2-q8_0.gguf', 'breeze-tts-2.gguf']
    home = Path(os.path.expanduser('~'))
    for base in _candidates():
        exe = _find_file(base, ['breeze-server.exe'], 2)
        if not exe:
            continue
        model = (
            _find_file(base / 'weights', model_names, 1)
            or _find_file(base / 'breeze-weights', model_names, 1)
            or _find_file(base, model_names, 2)
            or _find_file(home / 'breeze-weights', model_names, 1)
        )
        if not model:
            continue
        return {'exe': str(exe), 'model': str(model), 'cwd': str(exe.parent)}
    return None


def probe(timeout: float = 3.0) -> bool:
    try:
        from core import tts

        url = tts.breeze_url() + '/health'
    except Exception:
        url = 'http://127.0.0.1:8080/health'
    try:
        with urllib.request.urlopen(url, timeout=timeout) as resp:
            body = resp.read().decode('utf-8', 'ignore')
        data = json.loads(body or '{}')
        return data.get('status') == 'ok'
    except Exception:
        return False


def _do_restart() -> bool:
    now = time.time()
    with _lock:
        _state['restarts'] = [t for t in _state['restarts'] if now - t < RESTART_WINDOW]
        if len(_state['restarts']) >= MAX_RESTARTS:
            _state['last_error'] = '重启次数超限（10 分钟内 %d 次），停止重试' % MAX_RESTARTS
            logger.error('[Breeze] %s', _state['last_error'])
            return False
        _state['restarts'].append(now)

    paths = resolve_paths()
    if not paths:
        with _lock:
            _state['last_error'] = '找不到 breeze-server.exe 或 gguf 模型'
        logger.warning('[Breeze] %s', _state['last_error'])
        return False

    try:
        creationflags = 0
        if os.name == 'nt':
            creationflags = 0x08000000  # CREATE_NO_WINDOW
        subprocess.Popen(
            [paths['exe'], paths['model'], '--port', '8080', '--host', '127.0.0.1'],
            cwd=paths['cwd'],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            creationflags=creationflags,
        )
        logger.warning('[Breeze] 服务无响应，已尝试重新拉起: %s', paths['exe'])
        return True
    except Exception as exc:
        with _lock:
            _state['last_error'] = '拉起失败: %s' % exc
        logger.error('[Breeze] %s', _state['last_error'])
        return False


def _loop() -> None:
    time.sleep(STARTUP_GRACE)
    while True:
        try:
            if probe():
                with _lock:
                    _state['failures'] = 0
                    _state['last_healthy'] = time.time()
                time.sleep(PROBE_INTERVAL)
                continue

            with _lock:
                _state['failures'] += 1
                failures = _state['failures']
            logger.debug('[Breeze] 健康探测失败 %d/%d', failures, FAILURES_BEFORE_RESTART)
            if failures >= FAILURES_BEFORE_RESTART:
                if _do_restart():
                    with _lock:
                        _state['failures'] = 0
                    # 模型加载要几十秒，别马上又判失败
                    time.sleep(60.0)
                else:
                    time.sleep(PROBE_INTERVAL * 4)
            else:
                time.sleep(PROBE_INTERVAL)
        except Exception as exc:
            logger.debug('[Breeze] 守护线程异常: %s', exc)
            time.sleep(PROBE_INTERVAL)


def start() -> bool:
    """起守护线程（幂等）。"""
    with _lock:
        if _state['running']:
            return False
        _state['running'] = True
    thread = threading.Thread(target=_loop, name='breeze-guard', daemon=True)
    _state['thread'] = thread
    thread.start()
    logger.info('[Breeze] 守护线程已启动（每 %.0f 秒探测一次）', PROBE_INTERVAL)
    return True


def status() -> Dict[str, Any]:
    with _lock:
        return {
            'guard_running': _state['running'],
            'failures': _state['failures'],
            'recent_restarts': len(_state['restarts']),
            'last_error': _state['last_error'],
            'last_healthy': _state['last_healthy'],
            'paths': resolve_paths(),
        }