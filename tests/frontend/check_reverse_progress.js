#!/usr/bin/env node
// 倒放进度契约：进度条与播放头在倒放时反向，seek 也反向映射

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '..', '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');

assert(html.includes('function displayProgressRatio()'), '缺倒放进度映射函数');
assert(html.includes('reverseMode ? (1 - raw) : raw'), '进度没有按倒放反转');
assert(html.includes('function displayCurrentTimeMs()'), '缺倒放时间显示映射');
assert(html.includes('const progress = displayProgressRatio()'), '进度条/播放头没有使用映射值');
assert(html.includes('reverseMode ? (1 - progress) : progress'), '倒放时 seek 没有反向映射');

console.log('倒放进度契约检查通过。');
