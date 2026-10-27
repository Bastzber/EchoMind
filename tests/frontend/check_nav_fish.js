#!/usr/bin/env node
// 大肥鱼契约

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '..', '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');

assert(html.includes('id="navFishWrap"'), '顶栏没有大肥鱼');
assert(html.includes('@keyframes fishTailWag'), '缺摆尾动画');
assert(html.includes('@keyframes fishBlink'), '缺眨眼动画');
assert(html.includes('fishSetPlaying'), '播放没有联动');
assert(html.includes('showFishPopover'), '缺点击面板');
assert(html.includes('echomind.fishHidden'), '缺隐藏记忆');
assert(html.includes('fishToggleBtn'), '设置里缺显示开关');

console.log('大肥鱼契约检查通过。');
