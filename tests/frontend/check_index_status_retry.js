#!/usr/bin/env node
// 索引状态契约：失败不再写死「状态不可用」，自动重试 + 可点击重试

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '..', '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');

assert(!html.includes("status.textContent = '状态不可用'"), '仍在写死「状态不可用」');
assert(html.includes('function scheduleIndexStatusRetry'), '缺自动重试');
assert(html.includes('读取失败 · 点击重试'), '缺可点击重试文案');
assert(html.includes('读取中…'), '缺读取中文案');
assert(html.includes('indexStatusFailures < 3'), '重试次数阈值缺失');
assert(html.includes('paintIndexStatusLabel'), '缺统一的状态文案渲染');

console.log('索引状态契约检查通过。');
