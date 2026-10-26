#!/usr/bin/env node
// 索引进度实时更新契约

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '..', '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');

assert(html.includes('function scheduleIndexPoll') || html.includes('const scheduleIndexPoll ='), '缺自适应轮询');
assert(html.includes('busy ? 2000 : 15000'), '没有按活跃状态调整刷新频率');
assert(!/if \(!indexJobRunning && backendReady\) refreshProjectIndexStatus\(\)/.test(html), '手动任务期间仍停止刷新');
assert(html.includes("el.style.color = '#22c55e'"), '数字变化没有视觉反馈');

console.log('索引进度实时更新契约检查通过。');
