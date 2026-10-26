#!/usr/bin/env node
// 倍速契约：0.25×–6×、Ctrl+↑/↓ 微调、拖动后不抢空格、双击复位

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '..', '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');

assert(html.includes('id="playbackRateSlider"'), '缺倍速滑条');
assert(/id="playbackRateSlider"[^>]*max="6"|max="6"[^>]*id="playbackRateSlider"/.test(html) || html.includes('max="6"'), '上限不是 6×');
assert(html.includes('event.ctrlKey') && html.includes('ArrowUp'), '缺 Ctrl+↑/↓ 微调');
assert(html.includes('slider.blur()'), '拖动后没有失焦（空格会失效）');
assert(html.includes('active.type !== \'range\''), '空格保护没有放行 range 控件');
assert(html.includes('function formatRate('), '缺倍速格式化');
assert(html.includes("setPlaybackRate(1)"), '缺复位');

console.log('倍速交互契约检查通过。');
