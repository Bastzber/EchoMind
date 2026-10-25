#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""自动续跑：反复踢应用的索引任务，直到 audio_vector / text_vector 全 ready。

应用的任务每次能跑几千条就断，断了这里 3 分钟后再踢一次，直到做完。
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
LOG = Path(r'E:\AI音效管理器\kick.log')
DONE = Path(r'E:\AI音效管理器\import-done.json')
POLL = 240


def log(msg: str) -> None:
    line = time.strftime('%H:%M:%S') + '  ' + msg
    print(line, flush=True)
    try:
        with LOG.open('a', encoding='utf-8') as handle:
            handle.write(line + '\n')
    except Exception:
        pass


def counts() -> dict:
    conn = sqlite3.connect('file:' + str(DB).replace('\\', '/') + '?mode=ro', uri=True, timeout=20)
    try:
        rows = conn.execute(
            "SELECT kind, SUM(state IN ('pending','processing','stale')) FROM file_artifacts "
            "WHERE kind IN ('audio_vector','text_vector') GROUP BY kind"
        ).fetchall()
        return {row[0]: int(row[1] or 0) for row in rows}
    finally:
        conn.close()


def ready_count(kind: str) -> int:
    conn = sqlite3.connect('file:' + str(DB).replace('\\', '/') + '?mode=ro', uri=True, timeout=20)
    try:
        return int(conn.execute(
            "SELECT COUNT(*) FROM file_artifacts WHERE kind=? AND state='ready'", (kind,)
        ).fetchone()[0])
    finally:
        conn.close()


def kick(kind: str) -> bool:
    body = json.dumps({'kinds': [kind]}).encode()
    for path in ('/api/v1/projects/default/index/rebuild', '/api/v1/projects/default/index/reconcile'):
        try:
            request = urllib.request.Request(
                'http://127.0.0.1:8000' + path, data=body, method='POST',
                headers={'Content-Type': 'application/json'})
            with urllib.request.urlopen(request, timeout=180) as response:
                log('已调度 %s -> %s' % (kind, response.read().decode()[:90]))
                return True
        except Exception as exc:
            log('调度失败 %s: %s' % (path, str(exc)[:80]))
    return False


def notify(summary: str) -> None:
    message = summary.replace("'", "''")
    command = (
        "Add-Type -AssemblyName System.Windows.Forms; Add-Type -AssemblyName System.Drawing; "
        "$f = New-Object System.Windows.Forms.Form; $f.Text='EchoMind - 索引完成'; $f.TopMost=$true; "
        "$f.Width=700; $f.Height=360; $f.StartPosition='CenterScreen'; "
        "$f.BackColor=[System.Drawing.Color]::FromArgb(32,32,36); "
        "$l = New-Object System.Windows.Forms.Label; $l.Dock='Fill'; $l.Text='" + message + "'; "
        "$l.ForeColor=[System.Drawing.Color]::White; $l.Font=New-Object System.Drawing.Font('Microsoft YaHei',12); "
        "$l.TextAlign='MiddleCenter'; "
        "$b = New-Object System.Windows.Forms.Button; $b.Text='知道了'; $b.Dock='Bottom'; $b.Height=44; "
        "$b.Add_Click({ $f.Close() }); $f.Controls.Add($l); $f.Controls.Add($b); "
        "$t = New-Object System.Windows.Forms.Timer; $t.Interval=8000; "
        "$t.Add_Tick({ $f.TopMost=$true; $f.Activate(); [System.Media.SoundPlayer]::new('C:\\Windows\\Media\\notify.wav').Play() }); "
        "$t.Start(); for ($i=0;$i -lt 3;$i++){ [System.Media.SoundPlayer]::new('C:\\Windows\\Media\\notify.wav').Play(); Start-Sleep -Milliseconds 600 }; "
        "[System.Windows.Forms.Application]::Run($f); $t.Stop(); $f.Dispose()"
    )
    subprocess.run(['powershell', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', command], timeout=86400)


def main() -> int:
    log('续跑值守启动')
    while True:
        state = counts()
        audio_pending = state.get('audio_vector', 0)
        text_pending = state.get('text_vector', 0)
        log('待办 audio=%d text=%d (ready audio=%d text=%d)'
            % (audio_pending, text_pending, ready_count('audio_vector'), ready_count('text_vector')))

        if audio_pending == 0 and text_pending == 0:
            log('全部完成')
            tail = ''
            try:
                annotate = subprocess.run(
                    [str(REPO / '.venv' / 'Scripts' / 'python.exe'),
                     str(REPO / 'scripts' / 'apply_annotations_bulk.py')],
                    cwd=str(REPO), capture_output=True, text=True, encoding='utf-8', errors='replace', timeout=3600)
                tail = '\n'.join((annotate.stdout or '').strip().splitlines()[-2:])
                subprocess.run(
                    [str(REPO / '.venv' / 'Scripts' / 'python.exe'),
                     str(REPO / 'scripts' / 'rebuild_tag_layers.py')],
                    cwd=str(REPO), capture_output=True, timeout=3600)
            except Exception as exc:
                log('补标注失败: %s' % str(exc)[:120])
            DONE.write_text(json.dumps({
                'finished_at': time.strftime('%Y-%m-%d %H:%M:%S'), 'state': state, 'tail': tail,
            }, ensure_ascii=False, indent=1), encoding='utf-8')
            notify('索引全部完成\n\naudio 待办 0，text 待办 0\n' + tail)
            log('已通知，结束')
            return 0

        # 文本向量走 BGE（轻量、不吃大显存），先做；音频向量的 CLAP 需要空闲 GPU
        kind = 'text_vector' if text_pending else 'audio_vector'
        before = ready_count(kind)
        kick(kind)
        time.sleep(POLL)
        after = ready_count(kind)
        log('%s ready: %d -> %d（%+d）' % (kind, before, after, after - before))


if __name__ == '__main__':
    sys.exit(main())
