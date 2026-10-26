#!/usr/bin/env node
// 索引文案契约：不再显示 processed/total，处理中数字变绿

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '..', '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');

assert(html.includes("const pendingLabel = busy ? '处理中' : '待索引';"), '标签不是纯文字');
assert(!html.includes("' + jobProgress"), '仍在拼接进度数字');
assert(html.includes("el.style.color = busy ? '#22c55e' : ''"), '处理中数字没有变绿');
assert(html.includes('任务进度 '), '悬停里没有保留任务进度信息');

console.log('索引文案契约检查通过。');
