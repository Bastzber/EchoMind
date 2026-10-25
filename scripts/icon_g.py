# -*- coding: utf-8 -*-
"""方案 G：去掉中横的 E 框 + 框内蓝色回声波。

- E 只保留：左竖 + 上横 + 下横（像一个 [ 框）
- 三条蓝色弧线放在框内，向右张开
- 深色底，四角对称圆角
"""
from __future__ import annotations

import math
from pathlib import Path

from PIL import Image, ImageDraw

OUT = Path(r'E:\AI音效管理器\icon-variants')
OUT.mkdir(parents=True, exist_ok=True)

S = 1024
R = 232
BLUE_TOP = (104, 178, 255)
BLUE_BOTTOM = (36, 96, 220)
WHITE = (238, 238, 243, 255)


def bg(size: int) -> Image.Image:
    top, bottom = (30, 31, 39), (13, 14, 18)
    px = Image.new('RGB', (size, size))
    d = px.load()
    for y in range(size):
        for x in range(size):
            t = (x * 0.5 + y) / (1.5 * (size - 1))
            d[x, y] = tuple(round(top[i] + (bottom[i] - top[i]) * t) for i in range(3))
    mask = Image.new('L', (size, size), 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, size - 1, size - 1], radius=R, fill=255)
    out = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    out.paste(px, (0, 0), mask)
    return out


def blue_gradient(size: int) -> Image.Image:
    grad = Image.new('RGB', (size, size))
    d = grad.load()
    for y in range(size):
        t = y / (size - 1)
        d_row = tuple(round(BLUE_TOP[i] + (BLUE_BOTTOM[i] - BLUE_TOP[i]) * t) for i in range(3))
        for x in range(size):
            d[x, y] = d_row
    return grad


def draw_waves(layer: Image.Image, center, radii, width_scale=1.0, alpha=(255, 205, 155), angles=42) -> None:
    grad = blue_gradient(layer.width)
    mask = Image.new('L', (layer.width, layer.height), 0)
    md = ImageDraw.Draw(mask)
    for radius, width, a in zip(radii, [40, 36, 32], alpha):
        r = int(radius)
        w = int(width * width_scale)
        md.arc([center[0] - r, center[1] - r, center[0] + r, center[1] + r],
               start=-angles, end=angles, fill=a, width=w)
    layer.paste(grad, (0, 0), mask)


def build(with_dot: bool = False, size: int = S, center_x: int = 352,
          radii=(96, 172, 248), angles: float = 42) -> Image.Image:
    icon = bg(size)
    glyph = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(glyph)

    # E 框：左竖 + 上横 + 下横（无中横）
    d.rounded_rectangle([228, 244, 328, 780], radius=48, fill=WHITE)
    d.rounded_rectangle([228, 244, 724, 344], radius=48, fill=WHITE)
    d.rounded_rectangle([228, 680, 724, 780], radius=48, fill=WHITE)

    # 框内的回声波
    waves = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    center = (center_x, 512)
    draw_waves(waves, center, list(radii), angles=angles)
    glyph = Image.alpha_composite(glyph, waves)
    if with_dot:
        d2 = ImageDraw.Draw(glyph)
        d2.ellipse([center[0] - 34, center[1] - 34, center[0] + 34, center[1] + 34],
                   fill=(255, 255, 255, 255))

    return Image.alpha_composite(icon, glyph)


def main() -> int:
    configs = [
        ('G', False, 352, (96, 172, 248), 42),
        ('G3', False, 430, (104, 186, 272), 44),
        ('G4', False, 330, (128, 210, 292), 40),
    ]
    for name, with_dot, cx, radii, angles in configs:
        master = build(with_dot=with_dot, center_x=cx, radii=radii, angles=angles)
        for size in (512, 256, 128, 64, 32):
            master.resize((size, size), Image.LANCZOS).save(OUT / f'{name}-{size}.png')
    print('G / G3 / G4 已生成')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
