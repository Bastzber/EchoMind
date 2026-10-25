# -*- coding: utf-8 -*-
"""生成 5 个图标方案（深色底 + E 元素），输出对比图供挑选。"""
from __future__ import annotations

import math
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

OUT = Path(r'E:\AI音效管理器\icon-variants')
OUT.mkdir(parents=True, exist_ok=True)

S = 1024
R = 232
BG_DARK = (18, 18, 23)
BG_LIGHTER = (28, 29, 36)
WHITE = (237, 237, 242, 255)
VIOLET = (139, 108, 255)
CYAN = (56, 210, 235)


def rounded_bg(size: int, top=(30, 31, 38), bottom=(15, 15, 19)) -> Image.Image:
    base = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    px = Image.new('RGB', (size, size))
    d = px.load()
    for y in range(size):
        for x in range(size):
            t = (x * 0.6 + y) / (1.6 * size)
            d[x, y] = (
                round(top[0] + (bottom[0] - top[0]) * t),
                round(top[1] + (bottom[1] - top[1]) * t),
                round(top[2] + (bottom[2] - top[2]) * t),
            )
    mask = Image.new('L', (size, size), 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, size - 1, size - 1], radius=R, fill=255)
    base.paste(px, (0, 0), mask)
    return base


def gradient_bar(size, box, top, bottom) -> Image.Image:
    w = box[2] - box[0]; h = box[3] - box[1]
    grad = Image.new('RGB', (max(w, 1), max(h, 1)))
    gd = grad.load()
    for y in range(h):
        t = y / max(h - 1, 1)
        color = (
            round(top[0] + (bottom[0] - top[0]) * t),
            round(top[1] + (bottom[1] - top[1]) * t),
            round(top[2] + (bottom[2] - top[2]) * t),
        )
        for x in range(w):
            gd[x, y] = color
    layer = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    mask = Image.new('L', (size, size), 0)
    ImageDraw.Draw(mask).rounded_rectangle(box, radius=46, fill=255)
    layer.paste(grad, (box[0], box[1]), mask.crop(box))
    return layer


def variant_a(size=S) -> Image.Image:
    """A：实心白 E（干净、最稳）"""
    icon = rounded_bg(size)
    layer = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    spine = [292, 268, 388, 756]
    d.rounded_rectangle(spine, radius=48, fill=WHITE)
    for box in ([292, 268, 726, 364], [292, 464, 660, 560], [292, 660, 726, 756]):
        d.rounded_rectangle(box, radius=48, fill=WHITE)
    return Image.alpha_composite(icon, layer)


def variant_b(size=S) -> Image.Image:
    """B：完整 E，中横右侧接回声弧。"""
    icon = rounded_bg(size)
    layer = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    d.rounded_rectangle([262, 268, 358, 756], radius=48, fill=WHITE)
    for box in ([262, 268, 640, 364], [262, 464, 540, 560], [262, 660, 640, 756]):
        d.rounded_rectangle(box, radius=48, fill=WHITE)

    center = (572, 512)
    for radius, width, alpha in [(72, 32, 255), (150, 30, 200), (228, 28, 140)]:
        d.arc([center[0] - radius, center[1] - radius, center[0] + radius, center[1] + radius],
              start=-48, end=48, fill=(255, 255, 255, alpha), width=width)
    return Image.alpha_composite(icon, layer)



def variant_c(size=S) -> Image.Image:
    """C：三层回声环做底，白色 E 压在环上。"""
    icon = rounded_bg(size)
    layer = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    center = (512, 512)
    for radius, width, alpha in [(470, 26, 70), (398, 26, 100), (326, 26, 130)]:
        d.ellipse([center[0] - radius, center[1] - radius, center[0] + radius, center[1] + radius],
                  outline=(255, 255, 255, alpha), width=width)

    e_layer = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    ed = ImageDraw.Draw(e_layer)
    ed.rounded_rectangle([330, 328, 420, 696], radius=44, fill=WHITE)
    for box in ([330, 328, 662, 416], [330, 466, 588, 554], [330, 608, 662, 696]):
        ed.rounded_rectangle(box, radius=44, fill=WHITE)
    layer = Image.alpha_composite(layer, e_layer)
    return Image.alpha_composite(icon, layer)



def variant_d(size=S) -> Image.Image:
    """D：渐变描边的 E（紫→青，和 App 强调色一致）"""
    icon = rounded_bg(size)
    layer = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    for box in ([292, 268, 388, 756], [292, 268, 726, 364], [292, 464, 660, 560], [292, 660, 726, 756]):
        layer = Image.alpha_composite(layer, gradient_bar(size, box, VIOLET, CYAN))
    return Image.alpha_composite(icon, layer)


def variant_e(size=S) -> Image.Image:
    """E：均衡器竖条 + 圆点，暗示音效。"""
    icon = rounded_bg(size)
    layer = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    bars = [(300, 380), (420, 620), (540, 300), (660, 560), (780, 420)]
    for i, (x, h) in enumerate(bars):
        top = 512 - h // 2
        bottom = 512 + h // 2
        alpha = 255 if i == 2 else 210
        d.rounded_rectangle([x, top, x + 74, bottom], radius=37, fill=(255, 255, 255, alpha))
    return Image.alpha_composite(icon, layer)


def variant_f(size=S) -> Image.Image:
    """F：深底 + 白色 E，右侧一道渐变回声弧（紫→青）。"""
    icon = rounded_bg(size)
    layer = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)

    arc_layer = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    ad = ImageDraw.Draw(arc_layer)
    center = (520, 512)
    for radius, width, alpha in [(250, 36, 255), (330, 30, 190), (410, 26, 120)]:
        ad.arc([center[0] - radius, center[1] - radius, center[0] + radius, center[1] + radius],
               start=-40, end=40, fill=(255, 255, 255, alpha), width=width)
    mask = Image.new('L', (size, size), 0)
    md = ImageDraw.Draw(mask)
    md.arc([center[0] - 250, center[1] - 250, center[0] + 250, center[1] + 250], -40, 40, fill=255, width=36)
    md.arc([center[0] - 330, center[1] - 330, center[0] + 330, center[1] + 330], -40, 40, fill=200, width=30)
    md.arc([center[0] - 410, center[1] - 410, center[0] + 410, center[1] + 410], -40, 40, fill=140, width=26)
    gradient = Image.new('RGB', (size, size))
    gp = gradient.load()
    for y in range(size):
        t = y / (size - 1)
        color = (round(VIOLET[0] + (CYAN[0] - VIOLET[0]) * t),
                 round(VIOLET[1] + (CYAN[1] - VIOLET[1]) * t),
                 round(VIOLET[2] + (CYAN[2] - VIOLET[2]) * t))
        for x in range(size):
            gp[x, y] = color
    layer.paste(gradient, (0, 0), mask)

    d.rounded_rectangle([286, 300, 382, 724], radius=46, fill=WHITE)
    for box in ([286, 300, 640, 392], [286, 460, 570, 552], [286, 632, 640, 724]):
        d.rounded_rectangle(box, radius=46, fill=WHITE)
    return Image.alpha_composite(icon, layer)


VARIANTS = {'A': variant_a, 'B': variant_b, 'C': variant_c, 'D': variant_d, 'E': variant_e, 'F': variant_f}


def build_sheet(images, path: Path, cell=256, cols=3) -> None:
    pad = 26
    label_h = 34
    rows = math.ceil(len(images) / cols)
    width = cols * (cell + pad) + pad
    height = rows * (cell + label_h + pad) + pad
    sheet = Image.new('RGB', (width, height), (10, 10, 13))
    draw = ImageDraw.Draw(sheet)
    try:
        font = ImageFont.truetype('C:/Windows/Fonts/segoeui.ttf', 22)
    except Exception:
        font = ImageFont.load_default()
    for index, (key, image) in enumerate(images.items()):
        row, col = divmod(index, cols)
        x = pad + col * (cell + pad)
        y = pad + row * (cell + label_h + pad)
        sheet.paste(image.resize((cell, cell), Image.LANCZOS), (x, y))
        draw.text((x + 4, y + cell + 6), f'{key}', font=font, fill=(220, 220, 228))
    sheet.save(path)


def main() -> int:
    produced = {}
    for key, fn in VARIANTS.items():
        master = fn()
        master.resize((512, 512), Image.LANCZOS).save(OUT / f'{key}-512.png')
        master.resize((256, 256), Image.LANCZOS).save(OUT / f'{key}-256.png')
        master.resize((64, 64), Image.LANCZOS).save(OUT / f'{key}-64.png')
        produced[key] = master

    build_sheet(produced, OUT / 'sheet-256.png')

    # 小尺寸对照（64px），看任务栏里是否还认得出
    small = Image.new('RGB', (len(produced) * (64 + 22) + 22, 64 + 60), (10, 10, 13))
    d = ImageDraw.Draw(small)
    try:
        font = ImageFont.truetype('C:/Windows/Fonts/segoeui.ttf', 18)
    except Exception:
        font = ImageFont.load_default()
    for i, (key, master) in enumerate(produced.items()):
        x = 22 + i * (64 + 22)
        small.paste(master.resize((64, 64), Image.LANCZOS), (x, 22))
        d.text((x + 20, 92), key, font=font, fill=(210, 210, 220))
    small.save(OUT / 'sheet-64.png')
    print('方案已生成:', ', '.join(produced))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
