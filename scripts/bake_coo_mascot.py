# -*- coding: utf-8 -*-
"""从 Coopanion 的 whale 皮肤图层烘焙一张透明立绘（顶栏吉祥物用）。

用法：python scripts/bake_coo_mascot.py
输出：E:\\AI音效管理器\\coo-figure-final.png（全身，716×944）
依赖：Pillow；素材来自 Coopanion 安装目录，仅本机个人使用。
"""
import json
from pathlib import Path
from PIL import Image

W = Path(r'F:\大肥鱼\Coopanion\resources\app\node_modules\cortico-world-desktop-pet\web\whale')
m = json.loads((W/'model.json').read_text(encoding='utf-8'))
vx, vy, vw, vh = m['view']
SCALE = 4.0
canvas = Image.new('RGBA', (int(vw*SCALE), int(vh*SCALE)), (0,0,0,0))
def put(rel, box, anchor_center=None):
    img = Image.open(W/rel).convert('RGBA')
    w = max(1,int(round(box[2]*SCALE))); h = max(1,int(round(box[3]*SCALE)))
    img = img.resize((w,h), Image.LANCZOS)
    if anchor_center:
        cx, cy = anchor_center
        pos = (int(round((cx-vx)*SCALE - w/2)), int(round((cy-vy)*SCALE - h/2)))
    else:
        pos = (int(round((box[0]-vx)*SCALE)), int(round((box[1]-vy)*SCALE)))
    canvas.alpha_composite(img, pos)

for p in sorted(m['parts'], key=lambda x: x.get('z',0)):
    tex, box = p.get('tex'), p.get('box')
    if not tex or not box: continue
    f = W/'tex'/(tex+'.png')
    if f.is_file(): put(Path('tex')/(tex+'.png'), box)

# 眼睛（睡眠姿态，闭眼）与嘴：按 eye_creases 区域手工定位
put(Path('feat')/'sleep_eyeL.png', [0,0,15.5,5.5], anchor_center=(136.5, 111.0))
put(Path('feat')/'sleep_eyeR.png', [0,0,15.5,5.5], anchor_center=(162.0, 111.0))
put(Path('feat')/'neutral_mouth.png', [0,0,5.0,3.8], anchor_center=(149.0, 127.0))

bbox = canvas.getbbox()
if bbox: canvas = canvas.crop(bbox)
canvas.save(r'E:\AI音效管理器\coo-figure-final.png')
print('尺寸:', canvas.size)