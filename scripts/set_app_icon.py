# -*- coding: utf-8 -*-
"""把 EchoMind.exe 的图标换成 build/icon.ico（老板自己的图标）。

为什么需要这个脚本：
    electron-builder 打包时会用 build/icon.ico 给 Electron 主程序注入图标。
    这台机器上没有 npm，Electron 升级后是手动把 electron.exe 改名成
    EchoMind.exe 丢进 win-unpacked 的 —— 那一步不带图标，结果 exe 显示的是
    Electron 默认的原子图标（2026-11-11 实测：16/32/48/256 四种尺寸，全是默认图）。

做法：
    用 electron-builder 缓存里自带的 rcedit-x64.exe 重写 PE 的图标资源，
    写完再读回来核对尺寸数量，确保真的换上了。

用法：
    python scripts/set_app_icon.py                 # 换运行目录里的 EchoMind.exe
    python scripts/set_app_icon.py --exe 路径.exe
    python scripts/set_app_icon.py --icon build/icon.ico --exe <任意 EchoMind.exe>
"""

from __future__ import annotations

import argparse
import os
import shutil
import struct
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DEFAULT_EXE = ROOT / "dist-v11-build" / "win-unpacked" / "EchoMind.exe"
DEFAULT_ICON = ROOT / "build" / "icon.ico"

# electron-builder 打包时会按 package.json 写这些；手动换 exe 时补上，
# 否则文件属性里显示的是 "Electron / GitHub, Inc."（一眼就是改名的 electron.exe）。
# 只写身份字符串，不动文件版本号——版本号归老板管，要改先问。
VERSION_INFO = {
    "ProductName": "EchoMind",
    "FileDescription": "回声 EchoMind",
    "CompanyName": "Nagisa_Huckrick (胡杨)",
    "LegalCopyright": "Copyright © 2026 回声 EchoMind",
    "OriginalFilename": "EchoMind.exe",
}


def find_rcedit() -> Path:
    """electron-builder 缓存里的 rcedit，找不到就报错（本机没有 npm，别指望装）。"""
    local = os.environ.get("LOCALAPPDATA") or str(Path.home() / "AppData" / "Local")
    cache = Path(local) / "electron-builder" / "Cache" / "winCodeSign"
    if cache.exists():
        for path in sorted(cache.rglob("rcedit-x64.exe"), reverse=True):
            return path
        for path in sorted(cache.rglob("rcedit.exe"), reverse=True):
            return path
    for name in ("rcedit-x64.exe", "rcedit.exe"):
        found = subprocess.run(["where", name], capture_output=True, text=True).stdout.strip()
        if found:
            return Path(found.splitlines()[0])
    raise SystemExit(
        "找不到 rcedit。electron-builder 的缓存里应该有：\n"
        "  %LOCALAPPDATA%\\electron-builder\\Cache\\winCodeSign\\*\rcedit-x64.exe\n"
        "实在没有就下 winCodeSign 那个包，或者在有 npm 的机器上重打 Electron 部分。"
    )


def read_ico_sizes(ico: Path) -> list[tuple[int, int, int]]:
    raw = ico.read_bytes()
    count = struct.unpack_from("<H", raw, 4)[0]
    sizes = []
    for i in range(count):
        width, height, _colors, _res, _planes, bpp, size, _off = struct.unpack_from(
            "<BBBBHHII", raw, 6 + i * 16
        )
        sizes.append((width or 256, height or 256, bpp))
    return sizes


def read_exe_icon_sizes(exe: Path) -> list[tuple[int, int]]:
    """读 PE 里 RT_GROUP_ICON 的尺寸表；不用 pefile 也能读（省一个依赖）。"""
    import pefile  # noqa: PLC0415  venv 里有，读资源比手写省事

    pe = pefile.PE(str(exe), fast_load=True)
    pe.parse_data_directories(
        directories=[pefile.DIRECTORY_ENTRY["IMAGE_DIRECTORY_ENTRY_RESOURCE"]]
    )
    sizes: list[tuple[int, int]] = []
    resource_root = getattr(pe, "DIRECTORY_ENTRY_RESOURCE", None)
    entries = list(getattr(resource_root, "entries", []) or [])
    for entry in entries:
        if getattr(entry, "id", None) != 14:  # RT_GROUP_ICON
            continue
        for level in entry.directory.entries:
            for leaf in level.directory.entries:
                data = pe.get_data(leaf.data.struct.OffsetToData, leaf.data.struct.Size)
                count = struct.unpack_from("<H", data, 4)[0]
                for i in range(count):
                    width, height = struct.unpack_from("<BB", data, 6 + i * 14)
                    sizes.append((width or 256, height or 256))
    return sizes


def process_holding(exe: Path) -> list[str]:
    """看看是不是还有进程占着这个 exe（占着就改不了）。"""
    try:
        out = subprocess.run(
            [
                "powershell", "-NoProfile", "-Command",
                "Get-Process -Name EchoMind -ErrorAction SilentlyContinue | "
                "Select-Object -ExpandProperty Path",
            ],
            capture_output=True, text=True, timeout=20,
        ).stdout
    except Exception:
        return []
    return [line.strip() for line in out.splitlines() if line.strip() and
            os.path.normcase(line.strip()) == os.path.normcase(str(exe))]


def main() -> int:
    parser = argparse.ArgumentParser(description="给 EchoMind.exe 换图标")
    parser.add_argument("--exe", default=str(DEFAULT_EXE))
    parser.add_argument("--icon", default=str(DEFAULT_ICON))
    parser.add_argument(
        "--no-version-info", action="store_true",
        help="只换图标，不改文件属性里的产品名/公司名",
    )
    args = parser.parse_args()

    exe = Path(args.exe)
    icon = Path(args.icon)
    if not exe.exists():
        print(f"[失败] 找不到 exe: {exe}")
        return 2
    if not icon.exists():
        print(f"[失败] 找不到图标: {icon}")
        return 2

    want = read_ico_sizes(icon)
    print(f"目标 exe : {exe}")
    print(f"图标文件 : {icon}（{len(want)} 个尺寸）")
    before = read_exe_icon_sizes(exe)
    print(f"换之前   : {len(before)} 个尺寸 {before}")

    running = process_holding(exe)
    if running:
        print("[失败] 程序还在跑，先退出：", *running, sep="\n  ")
        return 3

    rcedit = find_rcedit()
    print(f"rcedit   : {rcedit}")

    # 就地改会报 "Fatal error: Unable to commit changes"（Win11 上 250 MB 的
    # Electron 主程序，rcedit 的原子替换经常被拦）。所以在同目录的临时副本上改，
    # 校验通过再备份原件、换上去。
    work_dir = exe.parent / ".icon-work"
    work_dir.mkdir(parents=True, exist_ok=True)
    working = work_dir / exe.name
    print(f"工作副本 : {working}")
    shutil.copy2(exe, working)

    cmd = [str(rcedit), str(working), "--set-icon", str(icon)]
    if not args.no_version_info:
        for key, value in VERSION_INFO.items():
            cmd += ["--set-version-string", key, value]
    result = subprocess.run(cmd, capture_output=True, text=True)
    if result.returncode != 0:
        print("[失败] rcedit 返回", result.returncode)
        print(result.stdout[-1500:])
        print(result.stderr[-1500:])
        shutil.rmtree(work_dir, ignore_errors=True)
        return 4

    after = read_exe_icon_sizes(working)
    expected = [(w, h) for w, h, _bpp in want]
    if sorted(after) != sorted(expected):
        print("[失败] 副本里的图标尺寸不对：", sorted(after), "!=", sorted(expected))
        shutil.rmtree(work_dir, ignore_errors=True)
        return 5

    backup = exe.with_suffix(exe.suffix + ".bak-before-icon")
    if not backup.exists():
        shutil.copy2(exe, backup)
        print(f"原文件备份: {backup}")

    # 刚杀掉进程时 Windows 还抱着内存映射，直接覆盖会报
    # "WinError 1224 请求的操作无法在使用用户映射区域打开的文件上执行"。
    # 等一会重试，几次都不行就明确告诉用户该关什么。
    last_error = None
    for attempt in range(12):
        try:
            shutil.copy2(working, exe)
            last_error = None
            break
        except OSError as exc:
            last_error = exc
            time.sleep(1.0)
    if last_error is not None:
        print("[失败] exe 被占用，覆盖不了：", last_error)
        print("       把 EchoMind、任务栏里的图标、资源管理器窗口都关掉再跑一次")
        print(f"       （已经改好的副本留在 {working}）")
        return 7
    shutil.rmtree(work_dir, ignore_errors=True)

    final = read_exe_icon_sizes(exe)
    print(f"换之后   : {len(final)} 个尺寸 {final}")
    if sorted(final) != sorted(expected):
        print("[失败] 落盘后复核不一致")
        return 6
    print("[成功] 图标已换成 build/icon.ico 里的全部尺寸")
    print("       桌面快捷方式如果还显示旧图标：任务栏/资源管理器里右键刷新，或重新固定一次")
    return 0


if __name__ == "__main__":
    sys.exit(main())
