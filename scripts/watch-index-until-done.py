#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""值守：保证索引一定跑完。

- 每 120 秒直接读数据库看待办数（后端忙时 HTTP 会超时）
- 连续 5 次没有进展 -> 杀掉后端重启 + 重新调度对账
- 待办归零 -> 写入大羽标注 -> 弹置顶窗口 -> 写完成标记
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

REPO = Path(r'E:\音效库管理软件\EchoMind\EchoMind-main')
DB = Path(os.environ['APPDATA']) / 'EchoMind' / 'db' / 'soundmind.db'
LOG = Path(r'E:\AI音效管理器\index-watch.log')
DONE = Path(r'E:\AI音效管理器\import-done.json')
KINDS = ('waveform', 'audio_vector', 'text_vector')
POLL = 120
STALL_LIMIT = 10


def log(msg: str) -> None:
    line = time.strftime('%H:%M:%S') + '  ' + msg
    print(line, flush=True)
    with LOG.open('a', encoding='utf-8') as handle:
        handle.write(line + '\n')


def pending_counts() -> dict:
    import sqlite3
    conn = sqlite3.connect('file:' + str(DB).replace('\\', '/') + '?mode=ro', uri=True, timeout=30)
    try:
        rows = conn.execute(
            "SELECT kind, SUM(state IN ('pending','processing')) FROM file_artifacts GROUP BY kind"
        ).fetchall()
        return {row[0]: int(row[1] or 0) for row in rows}
    finally:
        conn.close()


def backend_alive() -> bool:
    # 索引跑满时 /health 也可能几秒才回，别把"忙"当成"挂"
    try:
        with urllib.request.urlopen('http://127.0.0.1:8000/api/v1/health', timeout=30) as response:
            return response.status == 200
    except Exception:
        pass
    try:
        with urllib.request.urlopen('http://127.0.0.1:8000/', timeout=10) as response:
            return response.status < 500
    except Exception:
        return False


def run_powershell(command: str, timeout: int = 300) -> subprocess.CompletedProcess:
    return subprocess.run(
        ['powershell', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', command],
        capture_output=True, text=True, timeout=timeout, encoding='utf-8', errors='replace',
    )


def restart_backend() -> None:
    log('重启后端…')
    run_powershell(
        "Get-CimInstance Win32_Process -Filter \"Name='electron.exe'\" | "
        "Where-Object { $_.CommandLine -like '*EchoMind-main*' } | "
        "ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }; "
        "Get-NetTCPConnection -LocalPort 8000 -State Listen -ErrorAction SilentlyContinue | "
        "ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }",
        timeout=120,
    )
    time.sleep(4)
    subprocess.Popen(
        ['powershell', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', str(REPO / 'scripts' / 'dev.ps1')],
        cwd=str(REPO), stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    )
    deadline = time.time() + 240
    while time.time() < deadline:
        if backend_alive():
            log('后端已恢复')
            break
        time.sleep(5)
    kick_reconcile()


def kick_reconcile() -> None:
    body = json.dumps({'kinds': list(KINDS)}).encode()
    try:
        request = urllib.request.Request(
            'http://127.0.0.1:8000/api/v1/projects/default/index/reconcile',
            data=body, method='POST', headers={'Content-Type': 'application/json'},
        )
        with urllib.request.urlopen(request, timeout=60) as response:
            log('已调度对账: ' + response.read().decode()[:120])
    except Exception as exc:
        log('调度对账失败: ' + str(exc)[:120])


def notify(summary: str) -> None:
    script = REPO / 'scripts' / 'notify-when-import-done.ps1'
    message = summary.replace("'", "''")
    command = (
        "Add-Type -AssemblyName System.Windows.Forms; "
        "Add-Type -AssemblyName System.Drawing; "
        "$f = New-Object System.Windows.Forms.Form; "
        "$f.Text='EchoMind - 索引完成'; $f.TopMost=$true; $f.Width=660; $f.Height=320; "
        "$f.StartPosition='CenterScreen'; $f.BackColor=[System.Drawing.Color]::FromArgb(32,32,36); "
        "$l = New-Object System.Windows.Forms.Label; $l.Dock='Fill'; "
        "$l.Text='" + message + "'; $l.ForeColor=[System.Drawing.Color]::White; "
        "$l.Font=New-Object System.Drawing.Font('Microsoft YaHei',12); $l.TextAlign='MiddleCenter'; "
        "$b = New-Object System.Windows.Forms.Button; $b.Text='知道了'; $b.Dock='Bottom'; $b.Height=44; "
        "$b.Add_Click({ $f.Close() }); "
        "$f.Controls.Add($l); $f.Controls.Add($b); "
        "$t = New-Object System.Windows.Forms.Timer; $t.Interval=8000; "
        "$t.Add_Tick({ $f.TopMost=$true; $f.Activate(); [System.Media.SystemSounds]::Exclamation.Play() }); $t.Start(); "
        "for ($i=0;$i -lt 3;$i++){ [System.Media.SystemSounds]::Exclamation.Play(); Start-Sleep -Milliseconds 350 }; "
        "[System.Windows.Forms.Application]::Run($f); $t.Stop(); $f.Dispose()"
    )
    subprocess.run(
        ['powershell', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', command],
        timeout=86400, capture_output=True,
    )


def main() -> int:
    log('值守启动')
    last = None
    stall = 0
    restarts = 0
    missing = 0
    while True:
        counts = pending_counts()
        total_pending = sum(counts.values())
        log('待办 ' + json.dumps(counts, ensure_ascii=False) + '  合计 ' + str(total_pending))

        if total_pending == 0:
            log('索引已完成，开始写入大羽标注')
            annotate = subprocess.run(
                [str(REPO / '.venv' / 'Scripts' / 'python.exe'),
                 str(REPO / 'scripts' / 'apply_annotations_bulk.py'), '--apply'],
                cwd=str(REPO), capture_output=True, text=True, encoding='utf-8', errors='replace', timeout=7200,
            )
            tail = '\n'.join((annotate.stdout or '').strip().splitlines()[-3:])
            log('标注结果: ' + tail)
            DONE.write_text(json.dumps({
                'finished_at': time.strftime('%Y-%m-%d %H:%M:%S'),
                'pending': counts,
                'annotate': tail,
            }, ensure_ascii=False, indent=1), encoding='utf-8')
            summary = '索引全部完成\n\n' + json.dumps(counts, ensure_ascii=False) + '\n\n' + tail
            notify(summary)
            log('通知已弹出，值守结束')
            return 0

        if last is not None and total_pending >= last:
            stall += 1
            log('无进展计数 ' + str(stall) + '/' + str(STALL_LIMIT))
            if stall >= STALL_LIMIT:
                restarts += 1
                log('连续无进展，第 ' + str(restarts) + ' 次重启')
                restart_backend()
                stall = 0
        else:
            stall = 0
        last = total_pending

        if not backend_alive():
            missing += 1
            log('后端无响应 ' + str(missing) + '/3')
            if missing >= 3:
                log('后端确实挂了，拉起')
                restart_backend()
                missing = 0
        else:
            missing = 0
        time.sleep(POLL)


if __name__ == '__main__':
    sys.exit(main())
