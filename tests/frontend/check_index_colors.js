#!/usr/bin/env node
// 索引状态颜色契约：失败>0 标红，处理中>0 标绿

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '..', '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');

assert(html.includes("['audioFailedStatus', 'textFailedStatus']"), '没有处理失败数字');
assert(html.includes("failed > 0 ? '#ef4444' : ''"), '失败数字没有标红');
assert(html.includes("el.style.color = busy ? '#22c55e' : ''"), '处理中仍应标绿');

console.log('索引状态颜色契约检查通过。');
