#!/usr/bin/env node
// 微动画契约

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '..', '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');

assert(html.includes('@keyframes emPopIn'), '缺弹窗动画');
assert(html.includes('@keyframes emFadeIn'), '缺淡入动画');
assert(html.includes('prefers-reduced-motion'), '没有尊重减少动态效果设置');
assert(html.includes('#soundList > div:hover'), '缺列表行 hover 反馈');
assert(html.includes('button:active:not(:disabled)'), '缺按钮按压反馈');

console.log('微动画契约检查通过。');
