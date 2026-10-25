# -*- coding: utf-8 -*-
"""生成增量更新包：只打包相对上一版变化的文件，并附 manifest.json。

用法：
    # 1) 给当前版本建基线（下次发版用来做差集）
    python scripts/build_update_package.py baseline --target dist-v11-build/win-unpacked --version 0.3.0-beta.11

    # 2) 出增量包
    python scripts/build_update_package.py delta --target <新版目录> --base <旧版目录> \
        --version 0.3.0-beta.12 --base-version 0.3.0-beta.11 --out update-V12.zip
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import sys
import zipfile
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MANIFEST_DIR = ROOT / 'manifests'

# 这些属于用户数据或临时产物，永远不进增量包
EXCLUDE_DIRS = {'userdata', 'data', 'logs', 'cache', '.git'}
EXCLUDE_SUFFIXES = {'.log', '.tmp', '.updating'}


def sha256_file(path: Path, chunk: int = 1 << 20) -> str:
    digest = hashlib.sha256()
    with path.open('rb') as handle:
        while True:
            block = handle.read(chunk)
            if not block:
                break
            digest.update(block)
    return digest.hexdigest()


def walk_files(root: Path) -> dict:
    """返回 {相对路径(正斜杠): (绝对路径, 大小)}。"""
    result = {}
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if d.lower() not in EXCLUDE_DIRS]
        for name in filenames:
            if Path(name).suffix.lower() in EXCLUDE_SUFFIXES:
                continue
            full = Path(dirpath) / name
            rel = full.relative_to(root).as_posix()
            try:
                result[rel] = (full, full.stat().st_size)
            except OSError:
                continue
    return result


def build_manifest(target: Path, version: str, base_version: str, include_all: bool) -> dict:
    files = walk_files(target)
    entries = []
    for rel, (full, size) in sorted(files.items()):
        entries.append({'path': rel, 'sha256': sha256_file(full), 'size': size})
    return {
        'version': version,
        'baseVersion': base_version,
        'createdAt': datetime.now().isoformat(timespec='seconds'),
        'files': entries,
        'remove': [],
        'totalBytes': sum(item['size'] for item in entries),
        'complete': bool(include_all),
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    sub = parser.add_subparsers(dest='command', required=True)

    p_base = sub.add_parser('baseline', help='给某个版本建立全量基线清单')
    p_base.add_argument('--target', required=True)
    p_base.add_argument('--version', required=True)

    p_delta = sub.add_parser('delta', help='生成增量包')
    p_delta.add_argument('--target', required=True)
    p_delta.add_argument('--base', help='旧版安装目录（和 --base-manifest 二选一）')
    p_delta.add_argument('--base-manifest', help='旧版的 manifest.json（不用保留旧目录）')
    p_delta.add_argument('--version', required=True)
    p_delta.add_argument('--base-version', required=True)
    p_delta.add_argument('--out', required=True)
    p_delta.add_argument('--dry-run', action='store_true')

    args = parser.parse_args()
    target = Path(args.target).resolve()

    if args.command == 'baseline':
        manifest = build_manifest(target, args.version, '', include_all=True)
        MANIFEST_DIR.mkdir(parents=True, exist_ok=True)
        out = MANIFEST_DIR / f'{args.version}.manifest.json'
        out.write_text(json.dumps(manifest, ensure_ascii=False, indent=1), encoding='utf-8')
        print(f'基线清单: {out}（{len(manifest["files"])} 个文件，'
              f'{manifest["totalBytes"] / 1024 / 1024:.1f} MB）')
        return 0

    target_files = walk_files(target)
    if args.base_manifest:
        manifest_data = json.loads(Path(args.base_manifest).read_text(encoding='utf-8'))
        base_files = {item['path']: (None, item['size'], item['sha256']) for item in manifest_data['files']}
    else:
        if not args.base:
            raise SystemExit('要么给 --base 目录，要么给 --base-manifest')
        base_dir = Path(args.base).resolve()
        base_files = {
            rel: (full, size, None)
            for rel, (full, size) in walk_files(base_dir).items()
        }

    changed = []
    for rel, (full, size) in target_files.items():
        entry = base_files.get(rel)
        if entry is None:
            changed.append((rel, full, size))
            continue
        _base_full, base_size, base_hash = entry
        if base_size != size or sha256_file(full) != (base_hash or sha256_file(_base_full)):
            changed.append((rel, full, size))

    removed = [rel for rel in base_files if rel not in target_files]

    manifest = {
        'version': args.version,
        'baseVersion': args.base_version,
        'createdAt': datetime.now().isoformat(timespec='seconds'),
        'files': [{'path': rel, 'sha256': sha256_file(full), 'size': size} for rel, full, size in changed],
        'remove': removed,
        'totalBytes': sum(size for _rel, _full, size in changed),
    }

    total = sum(size for _rel, _full, size in changed)
    print(f'变化文件: {len(changed)} 个（{total / 1024 / 1024:.1f} MB）')
    print(f'需要删除: {len(removed)} 个')
    for rel, _full, size in sorted(changed, key=lambda item: -item[2])[:12]:
        print(f'  {size / 1024 / 1024:8.1f} MB  {rel}')

    if args.dry_run:
        print('[DRY RUN] 未写 zip')
        return 0

    out_path = Path(args.out).resolve()
    out_path.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(out_path, 'w', zipfile.ZIP_DEFLATED, compresslevel=6) as archive:
        archive.writestr('manifest.json', json.dumps(manifest, ensure_ascii=False, indent=1))
        for rel, full, _size in changed:
            archive.write(full, rel)
    size_mb = out_path.stat().st_size / 1024 / 1024
    print(f'\n增量包: {out_path}（{size_mb:.1f} MB）')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
