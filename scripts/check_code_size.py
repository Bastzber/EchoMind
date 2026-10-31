# -*- coding: utf-8 -*-
"""检查代码体积红线（见 AGENTS.md）。

用法：
    python scripts/check_code_size.py          # 只报告
    python scripts/check_code_size.py --strict # 超标时返回非 0，可用于提交前检查
"""
from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

# 文件 -> (提醒线, 硬上限)
# 提醒线：超过就该开始往外拆，但小改小补仍然允许
# 硬上限：超过直接判定失败，必须先拆再提交
LIMITS = {
    "index.html": (7000, 7500),
    "backend/main.py": (9600, 10200),
}
# 单文件上限（除上面两个）
SINGLE_FILE_LIMIT = 1500
# 第三方/生成产物，不做拆分要求
EXEMPT = {
    "assets/renderer/mesh-avatar.runtime.js": "第三方 avatar 运行时，不手改",
}
# 已知债务：这些文件已经超限，但允许维持现状——只禁止继续变长
KNOWN_DEBT = {
    "backend/core/database.py": 4258,
    "backend/core/search_engine.py": 1800,
}
# 这些目录下的文件参与单文件检查
SCAN_DIRS = ["assets/renderer", "backend/core", "scripts"]
# 低于这个行数不参与统计（避免噪音）
MIN_LINES = 20


def count_lines(path: Path) -> int:
    try:
        with open(path, "r", encoding="utf-8", errors="ignore") as fh:
            return sum(1 for _ in fh)
    except OSError:
        return 0


def main() -> int:
    strict = "--strict" in sys.argv
    failures: list[str] = []
    warnings: list[str] = []

    print("=== 体积红线（提醒线 / 硬上限）===")
    for rel, (warn, limit) in LIMITS.items():
        path = ROOT / rel
        if not path.exists():
            print(f"  ?  {rel} 不存在")
            continue
        lines = count_lines(path)
        pct = lines / limit * 100
        if lines > limit:
            mark = "超标"
            failures.append(f"{rel} 超过硬上限：{lines} > {limit}，必须先拆再提交")
        elif lines > warn:
            mark = "提醒"
            warnings.append(f"{rel} 已过提醒线（{lines} > {warn}），新功能请写到独立模块")
        else:
            mark = "OK "
        print(f"  {mark} {rel:<24} {lines:>6}  {warn:>6} / {limit:<6} ({pct:5.1f}% of hard)")

    print("=== 单文件上限（%d 行）===" % SINGLE_FILE_LIMIT)
    big: list[tuple[int, str]] = []
    for d in SCAN_DIRS:
        base = ROOT / d
        if not base.exists():
            continue
        for path in base.rglob("*"):
            if not path.is_file() or path.suffix not in (".py", ".js"):
                continue
            lines = count_lines(path)
            if lines >= MIN_LINES:
                big.append((lines, path.relative_to(ROOT).as_posix()))
    big.sort(reverse=True)
    over = []
    debt = []
    for n, p in big:
        if p in EXEMPT:
            continue
        if p in KNOWN_DEBT:
            if n > KNOWN_DEBT[p]:
                failures.append(f"{p} 已知债务又变长了：{n} > {KNOWN_DEBT[p]}")
                debt.append((n, p))
            continue
        if n > SINGLE_FILE_LIMIT:
            over.append((n, p))
            failures.append(f"{p} 超过单文件上限：{n} > {SINGLE_FILE_LIMIT}")

    for n, p in big[:5]:
        if p in EXEMPT:
            mark = "豁免"
        elif p in KNOWN_DEBT:
            mark = "债务"
        elif n > SINGLE_FILE_LIMIT:
            mark = "超标"
        else:
            mark = "OK "
        print(f"  {mark} {p:<46} {n:>6}")

    print("=== 汇总 ===")
    print(f"  统计文件 {len(big)} 个，其中超过单文件上限 {len(over)} 个")
    for w in warnings:
        print("  ! " + w)
    if failures:
        print("\n发现问题：")
        for f in failures:
            print("  - " + f)
        if strict:
            return 1
    else:
        print("  全部在红线内")
    return 0


if __name__ == "__main__":
    sys.exit(main())
