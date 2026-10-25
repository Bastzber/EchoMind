# -*- coding: utf-8 -*-
"""生成 EchoMind 应用图标：圆角方 + 渐变底 + 居中同心回声弧。

设计要点：
- 四边留白完全对称（居中），不再出现"只有右边是圆的"观感
- 主体是「回声」的意象：中心圆点 + 三层弧线，弧线透明度递减
- 1024 画布绘制后 LANCZOS 缩小，小尺寸也清晰
"""
from __future__ import annotations

import math
import os
from pathlib import Path

from PIL import Image, ImageDraw

ROOT = Path(r'E:\音效库管理软件\EchoMind\EchoMind-main')
BUILD = ROOT / 'build'
SIZES = [1024, 512, 256, 128, 64, 32, 16]

CANVAS = 1024
RADIUS = 232
GRAD_TOP = (126, 94, 252)      # 紫
GRAD_BOTTOM = (34, 200, 235)   # 青


def gradient_background(size: int) -> Image.Image:
    """对角渐变底。"""
    base = Image.new('RGB', (size, size))
    pixels = base.load()
    for y in range(size):
        for x in range(size):
            t = (x + y) / (2 * (size - 1))
            r = round(GRAD_TOP[0] + (GRAD_BOTTOM[0] - GRAD_TOP[0]) * t)
            g = round(GRAD_TOP[1] + (GRAD_BOTTOM[1] - GRAD_TOP[1]) * t)
            b = round(GRAD_TOP[2] + (GRAD_BOTTOM[2] - GRAD_TOP[2]) * t)
            pixels[x, y] = (r, g, b)
    return base


def arc_with_round_caps(draw: ImageDraw.ImageDraw, center, radius: float, width: int,
                        start_deg: float, end_deg: float, fill) -> None:
    box = [center[0] - radius, center[1] - radius, center[0] + radius, center[1] + radius]
    draw.arc(box, start=start_deg, end=end_deg, fill=fill, width=width)
    for angle in (start_deg, end_deg):
        rad = math.radians(angle)
        cx = center[0] + radius * math.cos(rad)
        cy = center[1] + radius * math.sin(rad)
        draw.ellipse([cx - width / 2, cy - width / 2, cx + width / 2, cy + width / 2], fill=fill)


def render_glyph(scale: int = 4) -> Image.Image:
    """单独画字形（4 倍超采样），返回裁到包围盒的 RGBA。"""
    size = CANVAS * scale
    layer = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(layer)

    dot_center = (size * 0.30, size / 2)
    dot_radius = 74 * scale
    draw.ellipse(
        [dot_center[0] - dot_radius, dot_center[1] - dot_radius,
         dot_center[0] + dot_radius, dot_center[1] + dot_radius],
        fill=(255, 255, 255, 255),
    )

    arcs = [
        (186, 58, 255, (-50, 50)),
        (300, 54, 216, (-44, 44)),
        (414, 50, 172, (-38, 38)),
    ]
    for radius, width, alpha, (start, end) in arcs:
        r = radius * scale
        w = width * scale
        box = [dot_center[0] - r, dot_center[1] - r, dot_center[0] + r, dot_center[1] + r]
        draw.arc(box, start=start, end=end, fill=(255, 255, 255, alpha), width=w)

    bbox = layer.getbbox()
    if bbox:
        layer = layer.crop(bbox)
    return layer


def render_master() -> Image.Image:
    size = CANVAS
    background = gradient_background(size)

    # 圆角遮罩
    mask = Image.new('L', (size, size), 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, size - 1, size - 1], radius=RADIUS, fill=255)
    icon = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    icon.paste(background, (0, 0), mask)

    glyph = render_glyph(4)
    glyph = glyph.resize((int(glyph.width / 4), int(glyph.height / 4)), Image.LANCZOS)

    # 严格居中：把字形放到画布正中（左右上下留白相同）
    x = (size - glyph.width) // 2 - int(size * 0.025)
    y = (size - glyph.height) // 2
    icon.alpha_composite(glyph, (x, y))
    return icon


def main() -> int:
    master = render_master()
    BUILD.mkdir(parents=True, exist_ok=True)

    for size in SIZES:
        resized = master.resize((size, size), Image.LANCZOS)
        resized.save(BUILD / f'icon_{size}x{size}.png')
    master.resize((1024, 1024), Image.LANCZOS).save(BUILD / 'icon.png')

    ico_sizes = [(s, s) for s in (16, 24, 32, 48, 64, 128, 256)]
    master.resize((256, 256), Image.LANCZOS).save(BUILD / 'icon.ico', sizes=ico_sizes)
    try:
        master.resize((512, 512), Image.LANCZOS).save(BUILD / 'icon.icns')
    except Exception as exc:
        print('icns 生成失败（可忽略）:', exc)

    (ROOT / 'assets').mkdir(parents=True, exist_ok=True)
    master.resize((512, 512), Image.LANCZOS).save(ROOT / 'assets' / 'audio-icon.png')

    preview = master.resize((128, 128), Image.LANCZOS)
    preview.save(Path(r'E:\AI音效管理器') / 'icon-preview-128.png')
    master.resize((256, 256), Image.LANCZOS).save(Path(r'E:\AI音效管理器') / 'icon-preview-256.png')
    print('图标已生成：', ', '.join(f'{s}' for s in SIZES))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
