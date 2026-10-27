# -*- coding: utf-8 -*-
"""把 Coopanion 的 whale 皮肤烘焙成 EchoMind 可用的透明 PNG。

素材来源：本机安装的 Coopanion（Cortico 桌宠）。仅在本机使用其皮肤做吉祥物。
用法：python scripts/bake_coo_mascot.py [--src <whale 目录>] [--out <输出目录>]
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path

from PIL import Image

DEFAULT_SRC = Path(r'F:\大肥鱼\Coopanion\resources\app\node_modules\cortico-world-desktop-pet\web\whale')
DEFAULT_OUT = Path(__file__).resolve().parents[1] / 'assets' / 'mascot' / 'baked'

SCHEMES = ['deepseek', 'harness', 'chatgpt', 'claude', 'gemini', 'kimi', 'minimax', 'qwen']
EXPRESSIONS = ['neutral', 'happy', 'sleep', 'surprised']
SCALE = 2.4


def _dir_for(src: Path, scheme: str) -> Path:
    if scheme == 'deepseek':
        return src
    d = src / 'schemes' / scheme
    return d if d.is_dir() else src


def _feat_path(src: Path, scheme: str, name: str) -> Path | None:
    base = _dir_for(src, scheme) / 'feat' / name
    if base.is_file():
        return base
    alt = src / 'feat' / name
    return alt if alt.is_file() else None


def bake(src: Path, scheme: str, expression: str, out_dir: Path) -> Path:
    model = json.loads((src / 'model.json').read_text(encoding='utf-8'))
    vx, vy, vw, vh = model['view']
    canvas = Image.new('RGBA', (int(vw * SCALE), int(vh * SCALE)), (0, 0, 0, 0))

    def paste(rel: Path, box, center=None):
        if rel is None or not rel.is_file():
            return
        w = max(1, int(round(box[2] * SCALE)))
        h = max(1, int(round(box[3] * SCALE)))
        img = Image.open(rel).convert('RGBA').resize((w, h), Image.LANCZOS)
        if center:
            pos = (int(round((center[0] - vx) * SCALE - w / 2)), int(round((center[1] - vy) * SCALE - h / 2)))
        else:
            pos = (int(round((box[0] - vx) * SCALE)), int(round((box[1] - vy) * SCALE)))
        canvas.alpha_composite(img, pos)

    for part in sorted(model['parts'], key=lambda p: p.get('z', 0)):
        tex = part.get('tex')
        box = part.get('box')
        if not tex or not box:
            continue
        paste(src / 'tex' / f'{tex}.png', box)

    face = next(p for p in model['parts'] if p['id'] == 'face')['box']
    fw, fh = face[2], face[3]

    if expression == 'sleep':
        for side, cx in (('eyeL', face[0] + fw * 0.30), ('eyeR', face[0] + fw * 0.70)):
            paste(_feat_path(src, scheme, f'sleep_{side}.png'),
                  [0, 0, fw * 0.30, fh * 0.11], center=(cx, face[1] + fh * 0.40))
    else:
        ew, eh = fw * 0.30, fh * 0.318
        for side, cx in (('eyeL', face[0] + fw * 0.30), ('eyeR', face[0] + fw * 0.70)):
            for layer in ('ball', 'iris', 'lash'):
                paste(_feat_path(src, scheme, f'{side}_{layer}.png'),
                      [0, 0, ew, eh], center=(cx, face[1] + fh * 0.42))

    mouth_name = 'neutral_mouth.png' if expression in ('neutral', 'sleep') else f'{expression}_mouth.png'
    paste(_feat_path(src, scheme, mouth_name), [0, 0, fw * 0.12, fh * 0.07],
          center=(face[0] + fw * 0.50, face[1] + fh * 0.72))

    bbox = canvas.getbbox()
    if bbox:
        canvas = canvas.crop(bbox)
    out_dir.mkdir(parents=True, exist_ok=True)
    target = out_dir / f'{scheme}-{expression}.png'
    canvas.save(target)

    # 顶栏只有 48×62，全身图脸太小：另出一张头部方形特写
    w, h = canvas.size
    side = int(min(w * 0.94, h * 0.62))
    head = canvas.crop((max(0, (w - side) // 2), 0, max(0, (w - side) // 2) + side, side))
    head.save(out_dir / f'{scheme}-{expression}-head.png')
    return target


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument('--src', default=str(DEFAULT_SRC))
    parser.add_argument('--out', default=str(DEFAULT_OUT))
    args = parser.parse_args()
    src = Path(args.src)
    out = Path(args.out)
    if not (src / 'model.json').is_file():
        print('找不到 Coopanion 皮肤目录:', src)
        return 1
    made = 0
    for scheme in SCHEMES:
        for expression in EXPRESSIONS:
            target = bake(src, scheme, expression, out)
            made += 1
            print('  ', target.name, Image.open(target).size)
    print(f'共烘焙 {made} 张 -> {out}')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())