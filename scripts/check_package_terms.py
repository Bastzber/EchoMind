#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""打包前禁词扫描：更新包里不允许出现指定字眼（默认「大羽」）。

用法：
    python scripts/check_package_terms.py dist-v11-build/win-unpacked
    python scripts/check_package_terms.py --pack dist-v11-build/EchoMind-描述包.json

命中时退出码为 1，并打印文件、次数与前后的上下文，方便定位。
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
CONFIG = REPO_ROOT / "config" / "forbidden-terms.json"
MAX_BYTES = 300 * 1024 * 1024


def load_terms() -> tuple[list[str], list[str]]:
    if not CONFIG.is_file():
        return ["大羽"], []
    data = json.loads(CONFIG.read_text(encoding="utf-8"))
    return list(data.get("terms") or []), list(data.get("allowPaths") or [])


def should_skip(path: Path, root: Path, allow: list[str]) -> bool:
    try:
        rel = path.relative_to(root).as_posix()
    except ValueError:
        rel = path.as_posix()
    return any(token and token in rel for token in allow)


def scan_file(path: Path, needles: list[bytes], terms: list[str]) -> list[str]:
    try:
        if path.stat().st_size > MAX_BYTES:
            return []
        data = path.read_bytes()
    except Exception:
        return []
    hits: list[str] = []
    for term, needle in zip(terms, needles):
        count = data.count(needle)
        if not count:
            continue
        index = data.find(needle)
        try:
            context = data[max(0, index - 80): index + 80].decode("utf-8", "ignore").replace("\n", " ")
        except Exception:
            context = ""
        hits.append(f"{path}  出现 {count} 次  …{context}…")
    return hits


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("target", nargs="?", default="dist-v11-build/win-unpacked", help="目录或文件")
    parser.add_argument("--pack", action="append", default=[], help="额外检查的文件（可多次）")
    args = parser.parse_args()

    terms, allow = load_terms()
    if not terms:
        print("禁词表为空，跳过")
        return 0
    needles = [term.encode("utf-8") for term in terms]

    target = Path(args.target)
    if not target.is_absolute():
        target = (REPO_ROOT / target).resolve()
    targets = [target] + [(REPO_ROOT / item).resolve() for item in args.pack]

    problems: list[str] = []
    checked = 0
    for item in targets:
        if item.is_file():
            problems.extend(scan_file(item, needles, terms))
            checked += 1
        elif item.is_dir():
            for path in item.rglob("*"):
                if not path.is_file() or should_skip(path, item, allow):
                    continue
                checked += 1
                problems.extend(scan_file(path, needles, terms))
        else:
            print(f"目标不存在: {item}")
            return 2

    if problems:
        print(f"发现 {len(problems)} 处禁词（{ '、'.join(terms) }），打包中止：")
        for line in problems[:40]:
            print("  " + line)
        if len(problems) > 40:
            print(f"  … 其余 {len(problems) - 40} 处省略")
        return 1

    print(f"禁词检查通过（扫描 {checked} 个文件，禁词：{'、'.join(terms)}）")
    return 0


if __name__ == "__main__":
    sys.exit(main())
