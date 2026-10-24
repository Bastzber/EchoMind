#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""把多个音效来源按统一分类（14 一级 / 88 二级）整合到目标目录。

用法：
    python scripts/migrate_library.py --dry-run          # 只生成 CSV 预览，不动文件
    python scripts/migrate_library.py --apply            # 真正移动（写回滚清单）

规则来源：
    config/library-taxonomy.json   14 一级 / 88 二级
    config/library-mapping.json    老目录 → 目标分类
"""
from __future__ import annotations

import argparse
import csv
import json
import os
import shutil
import sys
import time
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
AUDIO_EXTS = {'.wav', '.mp3', '.aac', '.m4a', '.wma', '.ogg', '.aiff', '.aif', '.flac', '.opus', '.ape'}

SOURCES = [
    (r'D:\资源库', 'old'),
    (r'F:\大羽音效库集合包及安装说明\大羽音效库集合包V1.0', 'dayu'),
]
DEFAULT_TARGET = r'F:\CJ音效库整合包V1'
REVIEW_BUCKET = '_待人工判断'
UNSORTED_BUCKET = '_待归类'


def load_config():
    taxonomy = json.loads((REPO_ROOT / 'config' / 'library-taxonomy.json').read_text(encoding='utf-8'))
    mapping = json.loads((REPO_ROOT / 'config' / 'library-mapping.json').read_text(encoding='utf-8'))
    aliases_path = REPO_ROOT / 'config' / 'library-aliases.json'
    keywords_path = REPO_ROOT / 'config' / 'library-keywords.json'
    aliases = json.loads(aliases_path.read_text(encoding='utf-8'))['aliases'] if aliases_path.exists() else {}
    keyword_rules = []
    if keywords_path.exists():
        keyword_rules = sorted(
            json.loads(keywords_path.read_text(encoding='utf-8'))['rules'],
            key=lambda r: max(len(k) for k in r['k']),
            reverse=True,
        )
    rules = sorted(mapping['rules'], key=lambda r: len(r['left']), reverse=True)
    return taxonomy['categories'], aliases, keyword_rules, rules


def match_rule(rel_parts, rules):
    """按最长前缀匹配老目录映射规则。rel_parts 例如 ['CJ音效库','1 机械类','32 枪声']。"""
    rel = '\\'.join(rel_parts)
    for rule in rules:
        left = rule['left'].replace('/', '\\')
        if rel == left or rel.startswith(left + '\\'):
            return rule
    return None


def normalize_second(top: str, second: str, categories, aliases) -> str:
    """把源包的二级名归一到标准名（含别名 + 大小写/空格容错）。"""
    if not second:
        return ''
    options = categories.get(top, [])
    if second in options:
        return second
    mapped = aliases.get(second)
    if mapped and mapped in options:
        return mapped
    cleaned = second.replace(' ', '').replace('-', '')
    for option in options:
        if option.replace(' ', '') == cleaned:
            return option
    for option in options:
        if option in second or second in option:
            return option
    return ''


def guess_second(top: str, rel_text: str, categories, keyword_rules) -> str:
    """按路径关键词猜一个二级分类；猜不到返回空。"""
    options = categories.get(top, [])
    lowered = rel_text.lower()
    for rule in keyword_rules:
        target_top, target_second = rule['t']
        if target_top != top or target_second not in options:
            continue
        if any(word.lower() in lowered for word in rule['k']):
            return target_second
    return ''


def plan_target(source_kind, path: Path, source_root: Path, categories, aliases, keyword_rules, rules):
    """返回 (一级, 二级, 状态)。状态: ok / review / unsorted。"""
    rel = path.relative_to(source_root)
    parts = list(rel.parts)

    if source_kind == 'dayu':
        # 大羽包已经是 <一级>\<二级>\... 结构
        if len(parts) >= 3 and parts[0] in categories:
            top = parts[0]
            second = normalize_second(top, parts[1], categories, aliases)
            if second:
                return top, second, 'ok'
            guessed = guess_second(top, '\\'.join(parts), categories, keyword_rules)
            if guessed:
                return top, guessed, 'ok'
            return top, UNSORTED_BUCKET, 'unsorted'
        return REVIEW_BUCKET, '', 'review'

    rule = match_rule(parts[:-1], rules)
    if rule:
        top, second = rule['target']
        if top == 'REVIEW':
            return REVIEW_BUCKET, '', 'review'
        second = normalize_second(top, second, categories, aliases)
        if not second:
            second = guess_second(top, '\\'.join(parts), categories, keyword_rules)
        if second:
            return top, second, 'ok'
        return top, UNSORTED_BUCKET, 'unsorted'

    return REVIEW_BUCKET, '', 'review'


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument('--target', default=DEFAULT_TARGET)
    parser.add_argument('--dry-run', action='store_true', default=True)
    parser.add_argument('--apply', action='store_true')
    parser.add_argument('--out', default=str(REPO_ROOT / 'migrate-plan.csv'))
    parser.add_argument('--limit', type=int, default=0, help='只处理前 N 个文件（调试）')
    args = parser.parse_args()
    apply_changes = bool(args.apply)

    categories, aliases, keyword_rules, rules = load_config()

    # 启动自检：映射表里的 (一级, 二级) 必须在分类标准里，否则会静默归错
    invalid = []
    for rule in rules:
        top, second = rule['target']
        if top == 'REVIEW':
            continue
        if top not in categories:
            invalid.append((rule['left'], top, second, '一级不存在'))
            continue
        if second and second not in categories[top]:
            invalid.append((rule['left'], top, second, '二级不属于该一级'))
    if invalid:
        print('!! 映射表有 %d 条无效规则：' % len(invalid))
        for item in invalid[:10]:
            print('   ', item)
        print()
    target_root = Path(args.target)
    print('目标目录:', target_root, '(存在)' if target_root.exists() else '(不存在，将创建)')
    print('模式:', 'APPLY（真正移动）' if apply_changes else 'DRY-RUN（只出清单）')

    rows = []
    stats = {'ok': 0, 'review': 0, 'unsorted': 0}
    bytes_total = 0
    seen_targets = {}
    started = time.time()

    for source_root_str, kind in SOURCES:
        source_root = Path(source_root_str)
        if not source_root.is_dir():
            print('跳过（不存在）:', source_root)
            continue
        print('扫描:', source_root)
        for entry in source_root.rglob('*'):
            if not entry.is_file() or entry.suffix.lower() not in AUDIO_EXTS:
                continue
            top, second, state = plan_target(kind, entry, source_root, categories, aliases, keyword_rules, rules)
            stats[state] += 1
            try:
                size = entry.stat().st_size
            except OSError:
                size = 0
            bytes_total += size

            # 目标路径：<一级>\<二级>\<文件名>，重名自动加序号
            folder = target_root / top / second if second else target_root / top
            name = entry.name
            dest = folder / name
            key = str(dest).lower()
            if key in seen_targets or dest.exists():
                stem, suffix = os.path.splitext(name)
                index = 2
                while True:
                    candidate = folder / f'{stem} ({index}){suffix}'
                    if str(candidate).lower() not in seen_targets and not candidate.exists():
                        dest = candidate
                        break
                    index += 1
            seen_targets[str(dest).lower()] = True

            rows.append({
                '状态': state,
                '一级': top,
                '二级': second,
                '原路径': str(entry),
                '新路径': str(dest),
                '大小MB': round(size / 1024 / 1024, 2),
            })
            if args.limit and len(rows) >= args.limit:
                break
        if args.limit and len(rows) >= args.limit:
            break

    out_path = Path(args.out)
    with out_path.open('w', encoding='utf-8-sig', newline='') as handle:
        writer = csv.DictWriter(handle, fieldnames=['状态', '一级', '二级', '原路径', '新路径', '大小MB'])
        writer.writeheader()
        writer.writerows(rows)

    print('\n扫描完成，用时 %.0fs' % (time.time() - started))
    print('文件数: %d   合计: %.1f GB' % (len(rows), bytes_total / 1024 ** 3))
    print('  可直接归位(ok)     : %d' % stats['ok'])
    print('  归入一级待细分      : %d' % stats['unsorted'])
    print('  需人工判断(review) : %d' % stats['review'])
    print('清单已写入:', out_path)
    if not apply_changes:
        print('\n这是 DRY-RUN，没有移动任何文件。确认清单后加 --apply 才会真正搬。')
        return 0

    # ---- 真正移动 ----
    manifest_path = Path(args.target) / ('migrate-manifest-%s.json' % time.strftime('%Y%m%d-%H%M%S'))
    moved = 0
    failed = 0
    manifest = []
    for index, row in enumerate(rows, 1):
        src = Path(row['原路径'])
        dst = Path(row['新路径'])
        try:
            dst.parent.mkdir(parents=True, exist_ok=True)
            shutil.move(str(src), str(dst))
            manifest.append({'from': str(src), 'to': str(dst)})
            moved += 1
        except Exception as exc:
            failed += 1
            print('  失败:', src, exc)
        if index % 500 == 0:
            manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=1), encoding='utf-8')
            print('  已移动 %d / %d（失败 %d）' % (index, len(rows), failed), flush=True)
    manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=1), encoding='utf-8')
    print('\n移动完成: %d 个，失败 %d 个' % (moved, failed))
    print('回滚清单:', manifest_path)
    return 0


if __name__ == '__main__':
    sys.exit(main())
