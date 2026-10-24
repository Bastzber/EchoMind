#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""音效库清点 + 查重。

分三段，代价从低到高：
  1. inventory  只 stat：目录/格式/大小分布（秒级）
  2. exact      精确重复：先按大小分组，同大小的再比"头 64KB + 尾 64KB"，
                完全一致的才算候选，最后才做整文件 SHA-256 确认。
                这样 195 GB 通常只需要读几个 GB。
  3. near       疑似重复（不同编码/码率）：按时长 + 文件名相似度分组。

用法：
  python scripts/audit_sfx.py --root "D:\资源库" --root "F:\大羽音效库集合包及安装说明" --out "E:\audit"
"""
from __future__ import annotations

import argparse
import csv
import hashlib
import json
import os
import sys
import time
from collections import Counter, defaultdict

AUDIO_EXTS = {'.wav', '.mp3', '.aac', '.m4a', '.wma', '.ogg', '.aiff', '.aif', '.flac', '.opus', '.ape', '.mp4'}
CHUNK = 1 << 16


def log(message: str) -> None:
    stamp = time.strftime('%H:%M:%S')
    print(f'[{stamp}] {message}', flush=True)


def iter_audio(roots):
    for root in roots:
        if not os.path.isdir(root):
            log(f'跳过（不存在）: {root}')
            continue
        for dirpath, _dirnames, filenames in os.walk(root):
            for name in filenames:
                if os.path.splitext(name)[1].lower() in AUDIO_EXTS:
                    yield os.path.join(dirpath, name)


def collect(roots):
    items = []
    for index, path in enumerate(iter_audio(roots), 1):
        try:
            stat = os.stat(path)
        except OSError:
            continue
        items.append({'path': path, 'size': stat.st_size, 'mtime': int(stat.st_mtime)})
        if index % 5000 == 0:
            log(f'  已扫描 {index} 个文件')
    return items


def quick_signature(path: str, size: int) -> str | None:
    """大小 + 头尾各 64KB 的哈希；同内容的文件几乎不可能撞这个。"""
    digest = hashlib.blake2b(digest_size=16)
    digest.update(str(size).encode('ascii'))
    try:
        with open(path, 'rb') as handle:
            digest.update(handle.read(CHUNK))
            if size > CHUNK * 2:
                handle.seek(-CHUNK, os.SEEK_END)
                digest.update(handle.read(CHUNK))
    except OSError:
        return None
    return digest.hexdigest()


def full_sha256(path: str) -> str | None:
    digest = hashlib.sha256()
    try:
        with open(path, 'rb') as handle:
            for block in iter(lambda: handle.read(1 << 20), b''):
                digest.update(block)
    except OSError:
        return None
    return digest.hexdigest()


def stage_inventory(items, out_dir):
    by_top = Counter()
    by_ext = Counter()
    by_top_size = Counter()
    total = 0
    for item in items:
        parts = item['path'].split(os.sep)
        top = os.sep.join(parts[:3]) if len(parts) > 3 else item['path']
        by_top[top] += 1
        by_top_size[top] += item['size']
        by_ext[os.path.splitext(item['path'])[1].lower() or '(无)'] += 1
        total += item['size']

    rows = []
    for top, count in by_top.most_common():
        rows.append({'目录': top, '文件数': count, '大小GB': round(by_top_size[top] / 1024 ** 3, 2)})
    write_csv(os.path.join(out_dir, 'inventory_dirs.csv'), rows)

    ext_rows = [{'格式': k, '文件数': v, '大小GB': round(sum(i["size"] for i in items if os.path.splitext(i["path"])[1].lower() == (k if k != "(无)" else "")) / 1024 ** 3, 2)}
                for k, v in by_ext.most_common()]
    write_csv(os.path.join(out_dir, 'inventory_formats.csv'), ext_rows)
    log(f'inventory: {len(items)} 个文件，{total / 1024 ** 3:.2f} GB')
    return {'files': len(items), 'bytes': total, 'dirs': rows, 'formats': ext_rows}


def stage_exact(items, out_dir):
    by_size = defaultdict(list)
    for item in items:
        by_size[item['size']].append(item)

    candidates = {size: group for size, group in by_size.items() if len(group) > 1}
    log(f'exact: {len(candidates)} 个大小分组有重复嫌疑，开始算头尾指纹')

    by_quick = defaultdict(list)
    done = 0
    for size, group in candidates.items():
        for item in group:
            signature = quick_signature(item['path'], size)
            if signature:
                by_quick[(size, signature)].append(item)
            done += 1
            if done % 2000 == 0:
                log(f'  指纹 {done} / {sum(len(g) for g in candidates.values())}')

    suspects = {key: group for key, group in by_quick.items() if len(group) > 1}
    log(f'exact: {len(suspects)} 组头尾一致，开始整文件 SHA-256 确认')

    groups = []
    for key, group in suspects.items():
        by_hash = defaultdict(list)
        for item in group:
            digest = full_sha256(item['path'])
            if digest:
                by_hash[digest].append(item)
        for digest, same in by_hash.items():
            if len(same) > 1:
                groups.append({
                    'sha256': digest,
                    'size': same[0]['size'],
                    'count': len(same),
                    'wasted_bytes': same[0]['size'] * (len(same) - 1),
                    'paths': [i['path'] for i in same],
                })

    groups.sort(key=lambda g: g['wasted_bytes'], reverse=True)
    with open(os.path.join(out_dir, 'exact_duplicates.json'), 'w', encoding='utf-8') as handle:
        json.dump(groups, handle, ensure_ascii=False, indent=1)

    rows = []
    for index, group in enumerate(groups, 1):
        for path in group['paths']:
            rows.append({'组号': index, '大小MB': round(group['size'] / 1024 ** 2, 2), '路径': path})
    write_csv(os.path.join(out_dir, 'exact_duplicates.csv'), rows)

    wasted = sum(g['wasted_bytes'] for g in groups)
    files_in_dups = sum(g['count'] for g in groups)
    log(f'exact: {len(groups)} 组完全重复，涉及 {files_in_dups} 个文件，可省 {wasted / 1024 ** 3:.2f} GB')
    return {'groups': len(groups), 'files': files_in_dups, 'wasted_bytes': wasted}



def read_audio_meta(path: str):
    """读时长/声道/采样率；只读文件头，很快。读不出来返回 None。"""
    ext = os.path.splitext(path)[1].lower()
    try:
        if ext == '.wav':
            import wave
            with wave.open(path, 'rb') as handle:
                rate = handle.getframerate() or 1
                return handle.getnframes() / rate, handle.getnchannels(), rate
        from mutagen import File as MutagenFile
        audio = MutagenFile(path)
        info = getattr(audio, 'info', None)
        if info is not None:
            return float(info.length), int(getattr(info, 'channels', 0) or 0), int(getattr(info, 'sample_rate', 0) or 0)
    except Exception:
        return None
    return None


def normalize_name(name: str) -> str:
    """去掉扩展名、复制痕迹和分隔符；保留数字（数字常是编号，不能删）。"""
    import re
    base = os.path.splitext(name)[0].lower()
    base = re.sub(r'\(\s*\d+\s*\)$', '', base)
    base = re.sub(r'(副本|copy)$', '', base)
    base = re.sub(r'[\s_\-\.,，。]+', '', base)
    return base

def stage_near(items, out_dir):
    """疑似重复：时长几乎一样，但大小/格式不同（不同码率、不同编码的同一条音效）。"""
    import difflib

    log('near: 读时长（只读文件头）…')
    metas = {}
    for index, item in enumerate(items, 1):
        meta = read_audio_meta(item['path'])
        if meta and meta[0] > 0:
            metas[item['path']] = meta
        if index % 10000 == 0:
            log(f'  时长 {index} / {len(items)}')
    log(f'near: {len(metas)} / {len(items)} 个读到了时长')

    buckets = defaultdict(list)
    for path, (duration, channels, rate) in metas.items():
        buckets[round(duration * 20)].append((path, duration, channels, rate))

    groups = []
    for _key, bucket in buckets.items():
        # 一个"时长桶"里几十上百个文件，几乎都是碰巧等长，不是重复
        if len(bucket) < 2 or len(bucket) > 25:
            continue
        by_size = defaultdict(list)
        for path, duration, channels, rate in bucket:
            try:
                by_size[os.path.getsize(path)].append((path, duration, channels, rate))
            except OSError:
                continue
        # 时长一致但大小不一致 → 可能是同一段声音的不同编码/码率
        if len(by_size) < 2:
            continue
        names = [normalize_name(os.path.basename(p)) for p, *_ in bucket]
        if min(len(n) for n in names) < 4:
            continue
        similarity = 0.0
        for i in range(len(names)):
            for j in range(i + 1, len(names)):
                similarity = max(similarity, difflib.SequenceMatcher(None, names[i], names[j]).ratio())
        # 名字不像的，本质上只是"时长撞车"，不进疑似重复
        if similarity < 0.72:
            continue
        groups.append({
            'duration': round(bucket[0][1], 3),
            'count': len(bucket),
            'distinct_sizes': len(by_size),
            'formats': sorted({os.path.splitext(p)[1].lower() for p, *_ in bucket}),
            'name_similarity': round(similarity, 2),
            'total_mb': round(sum(os.path.getsize(p) for p, *_ in bucket if os.path.exists(p)) / 1024 ** 2, 2),
            'paths': [p for p, *_ in bucket],
        })

    groups.sort(key=lambda g: (g['name_similarity'], g['total_mb']), reverse=True)
    with open(os.path.join(out_dir, 'near_duplicates.json'), 'w', encoding='utf-8') as handle:
        json.dump(groups, handle, ensure_ascii=False, indent=1)

    rows = []
    for index, group in enumerate(groups, 1):
        for path in group['paths']:
            rows.append({
                '组号': index,
                '时长秒': group['duration'],
                '同组数': group['count'],
                '名字相似度': group['name_similarity'],
                '路径': path,
            })
    write_csv(os.path.join(out_dir, 'near_duplicates.csv'), rows)
    log(f'near: {len(groups)} 组疑似重复（时长相同、大小不同）')
    return {'groups': len(groups), 'rows': len(rows)}


def write_csv(path, rows):
    if not rows:
        with open(path, 'w', encoding='utf-8-sig', newline='') as handle:
            handle.write('')
        return
    with open(path, 'w', encoding='utf-8-sig', newline='') as handle:
        writer = csv.DictWriter(handle, fieldnames=list(rows[0].keys()))
        writer.writeheader()
        writer.writerows(rows)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--root', action='append', required=True)
    parser.add_argument('--out', required=True)
    parser.add_argument('--stage', default='inventory,exact', help='inventory / exact / near / all，可逗号组合')
    args = parser.parse_args()

    known = {'inventory', 'exact', 'near'}
    stages = set(known) if args.stage == 'all' else {s.strip() for s in args.stage.split(',') if s.strip()}
    unknown = stages - known
    if unknown:
        parser.error('未知阶段: ' + ', '.join(sorted(unknown)))

    os.makedirs(args.out, exist_ok=True)

    log('收集文件列表…')
    items = collect(args.root)
    log(f'共 {len(items)} 个音频文件')

    summary = {'files': len(items), 'bytes': sum(i['size'] for i in items)}
    if 'inventory' in stages:
        summary['inventory'] = stage_inventory(items, args.out)
    if 'exact' in stages:
        summary['exact'] = stage_exact(items, args.out)
    if 'near' in stages:
        summary['near'] = stage_near(items, args.out)

    with open(os.path.join(args.out, 'summary.json'), 'w', encoding='utf-8') as handle:
        json.dump(summary, handle, ensure_ascii=False, indent=2)
    log('完成')


if __name__ == '__main__':
    main()
