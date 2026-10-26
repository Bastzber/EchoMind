#!/usr/bin/env node
// 索引文案契约：「待处理」改为动态「处理中/待索引」，并有积压自动补

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '..', '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const mainPy = fs.readFileSync(path.join(root, 'backend', 'main.py'), 'utf8');

assert(html.includes('id="audioPendingLabel"'), '音频缺动态标签');
assert(html.includes('id="textPendingLabel"'), '文本缺动态标签');
assert(!html.includes('待处理 <span id="audioPendingStatus"'), '仍写死「待处理」');
assert(html.includes("busy ? '处理中' : '待索引'"), '缺处理中/待索引切换');
assert(html.includes('后台正在排队处理，无需操作'), '缺悬停说明');

assert(mainPy.includes('pending_backlog'), '后端缺积压检测');
assert(mainPy.includes('跳过 24 小时节流直接补'), '有积压时没有跳过节流');

console.log('索引文案契约检查通过。');
