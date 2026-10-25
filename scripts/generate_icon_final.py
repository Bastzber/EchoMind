# -*- coding: utf-8 -*-
"""最终图标：E 框（左竖 + 上下两横，无中横）+ 框内蓝色回声波。"""
from __future__ import annotations

from pathlib import Path

from PIL import Image, ImageDraw

from icon_g import build

ROOT = Path(r'E:\音效库管理软件\EchoMind\EchoMind-main')
BUILD = ROOT / 'build'

SIZES = [1024, 512, 256, 128, 96, 64, 48, 32, 24, 16]


def main() -> int:
    master = build(with_dot=False, size=1024)   # G 版本
    BUILD.mkdir(parents=True, exist_ok=True)

    for size in SIZES:
        master.resize((size, size), Image.LANCZOS).save(BUILD / f'icon_{size}x{size}.png')
    master.save(BUILD / 'icon.png')

    ico_sizes = [(s, s) for s in (16, 24, 32, 48, 64, 96, 128, 256)]
    master.resize((256, 256), Image.LANCZOS).save(BUILD / 'icon.ico', sizes=ico_sizes)
    try:
        master.resize((512, 512), Image.LANCZOS).save(BUILD / 'icon.icns')
    except Exception as exc:
        print('icns 跳过:', exc)

    (ROOT / 'assets').mkdir(parents=True, exist_ok=True)
    master.resize((512, 512), Image.LANCZOS).save(ROOT / 'assets' / 'audio-icon.png')
    master.resize((256, 256), Image.LANCZOS).save(Path(r'E:\AI音效管理器') / 'icon-final-256.png')
    master.resize((64, 64), Image.LANCZOS).save(Path(r'E:\AI音效管理器') / 'icon-final-64.png')
    print('全部尺寸已生成')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
