#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""一键打包发布版：软件 + 后端(.caf/转码/路径修复) + 描述包 + 安装指南 + 更新说明，并做完整性校验。

用法：
    python scripts/package_release.py --version 0.3.0-beta.11
    python scripts/package_release.py --version 0.3.0-beta.11 --skip-backend   # 后端没改时复用
"""
from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
import time
import urllib.request
import zipfile
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
DIST_DIR = REPO / 'dist-electron-v5'
UNPACKED = DIST_DIR / 'win-unpacked'
RELEASE_DIR = REPO / 'release'
LOG = Path(r'E:\AI音效管理器\package-release.log')


def log(msg: str) -> None:
    line = time.strftime('%H:%M:%S') + '  ' + msg
    print(line, flush=True)
    try:
        with LOG.open('a', encoding='utf-8') as fh:
            fh.write(line + '\n')
    except Exception:
        pass


def run(cmd, cwd=REPO, timeout=3600):
    log('执行: ' + ' '.join(str(c) for c in cmd))
    result = subprocess.run(cmd, cwd=str(cwd), capture_output=True, text=True,
                            encoding='utf-8', errors='replace', timeout=timeout)
    if result.returncode != 0:
        log('失败输出:\n' + (result.stdout or '')[-1500:] + (result.stderr or '')[-800:])
        raise SystemExit('命令失败: ' + ' '.join(str(c) for c in cmd))
    return result


def newest_source_time() -> float:
    """后端相关源文件里最新的修改时间，用来判断后端要不要重打。"""
    patterns = ['backend/**/*.py', 'config/*.json']
    newest = 0.0
    for pattern in patterns:
        for path in REPO.glob(pattern):
            if '.venv' in str(path) or '__pycache__' in str(path):
                continue
            newest = max(newest, path.stat().st_mtime)
    return newest


def find_backend_dir() -> Path:
    for candidate in [REPO / 'dist' / 'backend' / 'soundbot-backend',
                      REPO / 'dist-electron' / 'backend' / 'soundbot-backend']:
        if (candidate / 'soundbot-backend.exe').exists():
            return candidate
    raise SystemExit('找不到后端构建产物')


def export_description_pack() -> Path:
    """从运行中的后端导出描述包；后端没开就复用 release 里的。"""
    target = REPO / 'assets' / 'descriptions' / 'EchoMind-描述包.json'
    try:
        with urllib.request.urlopen(
            'http://127.0.0.1:8000/api/v1/descriptions/export?project_id=default', timeout=600
        ) as response:
            pack = json.loads(response.read().decode())
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(json.dumps(pack, ensure_ascii=False, indent=1), encoding='utf-8')
        log('描述包已从运行中的库导出: %d 条，%.1f MB'
            % (len(pack.get('items') or []), target.stat().st_size / 1024 / 1024))
    except Exception as exc:
        log('后端没开或导出失败（%s），沿用现有描述包' % str(exc)[:80])
    return target


def build_asar() -> Path:
    stage = Path(os.environ.get('TEMP', r'E:\AI音效管理器')) / 'echomind-asar-stage'
    if stage.exists():
        shutil.rmtree(stage)
    stage.mkdir(parents=True)
    for name in ['main.js', 'preload.js', 'index.html', 'splash.html',
                 'tailwindcss.js', 'lucide.min.js', 'package.json']:
        src = REPO / name
        if src.exists():
            shutil.copy2(src, stage / name)
    for folder in ['assets', 'config', 'lib']:
        src = REPO / folder
        if src.exists():
            shutil.copytree(src, stage / folder)
    out = REPO / 'dist-package-app.asar'
    node = os.environ.get('ECHOMIND_NODE') or r'C:\Users\cj\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe'
    run([node, str(REPO / 'node_modules' / '@electron' / 'asar' / 'bin' / 'asar.js'),
         'pack', str(stage), str(out)])
    log('app.asar: %.2f MB' % (out.stat().st_size / 1024 / 1024))
    return out


def verify(version: str, backend_time: float, pack_entries: int) -> list:
    """打包后自检，返回问题列表（空 = 通过）。"""
    problems = []
    asar = UNPACKED / 'resources' / 'app.asar'
    backend_exe = UNPACKED / 'resources' / 'backend' / 'soundbot-backend' / 'soundbot-backend.exe'
    pack = UNPACKED / 'EchoMind-描述包.json'
    docs = [UNPACKED / '安装指南.txt', UNPACKED / '更新说明.txt']

    if not asar.exists():
        problems.append('缺 app.asar')
    if not backend_exe.exists():
        problems.append('缺后端 exe')
    elif backend_exe.stat().st_mtime < newest_source_time() - 5:
        problems.append('后端 exe 比源码旧（需要重建后端）')
    if not pack.exists():
        problems.append('缺描述包')
    elif pack.stat().st_size < 5 * 1024 * 1024:
        problems.append('描述包体积异常')
    for doc in docs:
        if not doc.exists():
            problems.append('缺文档: ' + doc.name)

    # 版本号一致
    pkg = json.loads((REPO / 'package.json').read_text(encoding='utf-8'))
    if pkg.get('version') != version:
        problems.append('package.json 版本是 %s，期望 %s' % (pkg.get('version'), version))
    return problems


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument('--version', required=True)
    parser.add_argument('--skip-backend', action='store_true')
    parser.add_argument('--skip-zip', action='store_true')
    args = parser.parse_args()

    log('=== 打包 %s ===' % args.version)

    if not args.skip_backend:
        if newest_source_time() > (find_backend_dir() / 'soundbot-backend.exe').stat().st_mtime - 5 \
                if (find_backend_dir() / 'soundbot-backend.exe').exists() else True:
            run([sys.executable, str(REPO / 'scripts' / 'build.py'), '--platform', 'windows',
                 '--skip-electron', '--skip-dependency-install'], timeout=3600)
    backend_dir = find_backend_dir()
    backend_exe = backend_dir / 'soundbot-backend.exe'
    log('后端: %.1f MB @ %s' % (backend_exe.stat().st_size / 1024 / 1024,
                              time.strftime('%H:%M:%S', time.localtime(backend_exe.stat().st_mtime))))

    pack = export_description_pack()
    asar = build_asar()

    # 组装
    UNPACKED.mkdir(parents=True, exist_ok=True)
    shutil.copy2(asar, UNPACKED / 'resources' / 'app.asar')
    target_backend = UNPACKED / 'resources' / 'backend' / 'soundbot-backend'
    if target_backend.exists():
        shutil.rmtree(target_backend)
    shutil.copytree(backend_dir, target_backend)
    shutil.copy2(pack, UNPACKED / 'EchoMind-描述包.json')

    for name, target in [('V11安装指南.txt', '安装指南.txt'), ('V11更新说明.txt', '更新说明.txt')]:
        src = RELEASE_DIR / name
        if src.exists():
            shutil.copy2(src, UNPACKED / target)
            shutil.copy2(src, DIST_DIR / name.replace('V11', 'V11-'))

    problems = verify(args.version, 0, 0)
    if problems:
        log('!! 自检未通过:')
        for item in problems:
            log('   - ' + item)
        return 1
    log('自检通过')

    if args.skip_zip:
        return 0

    zip_path = DIST_DIR / ('EchoMind测试版V11.zip' if 'beta.11' in args.version else
                           'EchoMind-%s-win.zip' % args.version)
    if zip_path.exists():
        zip_path.unlink()
    log('压缩中…（%s）' % zip_path.name)
    started = time.time()
    with zipfile.ZipFile(zip_path, 'w', zipfile.ZIP_DEFLATED, compresslevel=6) as archive:
        for path in UNPACKED.rglob('*'):
            if path.is_file():
                archive.write(path, path.relative_to(DIST_DIR))
    log('完成: %.2f GB，用时 %.1f 分钟' % (zip_path.stat().st_size / 1024 ** 3, (time.time() - started) / 60))
    log('路径: ' + str(zip_path))
    return 0


if __name__ == '__main__':
    sys.exit(main())
