#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""值守索引：只保证"有活干"，绝不因为 HTTP 慢就重启后端。

- 每 2 分钟读数据库看待办
- 没有在跑的索引任务 -> 立刻重新调度（这是唯一手段）
- 连续 20 分钟没有任何进展，且重试 3 次无效 -> 才重启后端
"""
from __future__ import annotations

import json
import os
import sqlite3
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

REPO = Path(r'E:\音效库管理软件\EchoMind\EchoMind-main')
DB = Path(os.environ['APPDATA']) / 'EchoMind' / 'db' / 'soundmind.db'
LOG = Path(r'E:\AI音效管理器\index-watch.log')
DONE = Path(r'E:\AI音效管理器\import-done.json')
POLL = 120
STALL_LIMIT = 10      # 20 分钟没进展
KICK_COOLDOWN = 180   # 两次调度至少隔 3 分钟


def log(message: str) -> None:
    line = time.strftime('%H:%M:%S') + '  ' + message
    print(line, flush=True)
    try:
        with LOG.open('a', encoding='utf-8') as handle:
            handle.write(line + '\n')
    except Exception:
        pass


def query(sql: str):
    conn = sqlite3.connect('file:' + str(DB).replace('\\', '/') + '?mode=ro', uri=True, timeout=20)
    try:
        return conn.execute(sql).fetchall()
    finally:
        conn.close()


def pending_counts() -> dict:
    for _ in range(3):
        try:
            rows = query(
                "SELECT kind, SUM(state IN ('pending','processing','stale')) "
                "FROM file_artifacts GROUP BY kind"
            )
            return {row[0]: int(row[1] or 0) for row in rows}
        except Exception as exc:
            log('读库失败（重试）: ' + str(exc)[:80])
            time.sleep(5)
    return {}


def active_job() -> bool:
    try:
        rows = query(
            "SELECT COUNT(*) FROM jobs WHERE state IN ('running','pending') "
            "AND kind IN ('index_reconcile','index_rebuild','folder_import')"
        )
        return bool(rows and rows[0][0])
    except Exception:
        return True


def kick_reconcile() -> bool:
    body = json.dumps({'kinds': ['waveform', 'audio_vector', 'text_vector']}).encode()
    try:
        request = urllib.request.Request(
            'http://127.0.0.1:8000/api/v1/projects/default/index/reconcile',
            data=body, method='POST', headers={'Content-Type': 'application/json'},
        )
        with urllib.request.urlopen(request, timeout=90) as response:
            log('已调度: ' + response.read().decode()[:110])
            return True
    except Exception as exc:
        log('调度失败: ' + str(exc)[:110])
        return False


def restart_backend() -> None:
    log('重启后端（最后的办法）')
    subprocess.run(
        ['powershell', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command',
         "Get-CimInstance Win32_Process -Filter \"Name='electron.exe'\" | "
         "Where-Object { $_.CommandLine -like '*EchoMind-main*' } | "
         "ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }; "
         "Get-NetTCPConnection -LocalPort 8000 -State Listen -ErrorAction SilentlyContinue | "
         "ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }"],
        capture_output=True, timeout=120,
    )
    time.sleep(5)
    subprocess.Popen(
        ['powershell', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', str(REPO / 'scripts' / 'dev.ps1')],
        cwd=str(REPO), stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    )
    time.sleep(60)


def notify(summary: str) -> None:
    message = summary.replace("'", "''")
    command = (
        "Add-Type -AssemblyName System.Windows.Forms; Add-Type -AssemblyName System.Drawing; "
        "$f = New-Object System.Windows.Forms.Form; $f.Text='EchoMind - 索引完成'; $f.TopMost=$true; "
        "$f.Width=680; $f.Height=340; $f.StartPosition='CenterScreen'; "
        "$f.BackColor=[System.Drawing.Color]::FromArgb(32,32,36); "
        "$l = New-Object System.Windows.Forms.Label; $l.Dock='Fill'; $l.Text='" + message + "'; "
        "$l.ForeColor=[System.Drawing.Color]::White; $l.Font=New-Object System.Drawing.Font('Microsoft YaHei',12); "
        "$l.TextAlign='MiddleCenter'; "
        "$b = New-Object System.Windows.Forms.Button; $b.Text='知道了'; $b.Dock='Bottom'; $b.Height=44; "
        "$b.Add_Click({ $f.Close() }); $f.Controls.Add($l); $f.Controls.Add($b); "
        "$t = New-Object System.Windows.Forms.Timer; $t.Interval=8000; "
        "$t.Add_Tick({ $f.TopMost=$true; $f.Activate(); [System.Media.SystemSounds]::Exclamation.Play() }); "
        "$t.Start(); for ($i=0;$i -lt 3;$i++){ [System.Media.SystemSounds]::Exclamation.Play(); Start-Sleep -Milliseconds 350 }; "
        "[System.Windows.Forms.Application]::Run($f); $t.Stop(); $f.Dispose()"
    )
    subprocess.run(['powershell', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', command], timeout=86400)


def main() -> int:
    log('值守启动（只按进度判断，不做健康检查重启）')
    last = None
    stall = 0
    last_kick = 0.0
    while True:
        counts = pending_counts()
        total = sum(counts.values())
        log('待办 ' + json.dumps(counts, ensure_ascii=False) + ' 合计 ' + str(total))

        if counts and total == 0:
            log('全部完成，写入标注')
            annotate = subprocess.run(
                [str(REPO / '.venv' / 'Scripts' / 'python.exe'),
                 str(REPO / 'scripts' / 'apply_annotations_bulk.py')],
                cwd=str(REPO), capture_output=True, text=True, encoding='utf-8', errors='replace', timeout=3600,
            )
            tag = subprocess.run(
                [str(REPO / '.venv' / 'Scripts' / 'python.exe'),
                 str(REPO / 'scripts' / 'rebuild_tag_layers.py')],
                cwd=str(REPO), capture_output=True, text=True, encoding='utf-8', errors='replace', timeout=3600,
            )
            tail = '\n'.join((annotate.stdout or '').strip().splitlines()[-2:])
            DONE.write_text(json.dumps({
                'finished_at': time.strftime('%Y-%m-%d %H:%M:%S'),
                'counts': counts, 'annotate': tail,
            }, ensure_ascii=False, indent=1), encoding='utf-8')
            notify('索引全部完成\n\n' + json.dumps(counts, ensure_ascii=False) + '\n\n' + tail)
            log('已通知，值守结束')
            return 0

        if not active_job() and time.time() - last_kick > KICK_COOLDOWN:
            log('没有在跑的索引任务 -> 重新调度')
            if kick_reconcile():
                last_kick = time.time()

        if last is not None and total >= last:
            stall += 1
            log('无进展 ' + str(stall) + '/' + str(STALL_LIMIT))
            if stall >= STALL_LIMIT:
                log('二十分钟无进展，重启后端')
                restart_backend()
                stall = 0
                last_kick = time.time()
        else:
            stall = 0
        last = total
        time.sleep(POLL)


if __name__ == '__main__':
    sys.exit(main())
