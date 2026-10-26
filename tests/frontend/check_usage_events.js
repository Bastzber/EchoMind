#!/usr/bin/env node
// 使用历史事件契约

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '..', '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');

['重命名', '收藏', '取消收藏', '转码'].forEach((label) => {
  assert(html.includes("rememberEvent('usage'") && html.includes("'" + label + "'"), '缺事件：' + label);
});
assert(html.includes('改标签') && html.includes('改描述'), '原有事件丢失');

console.log('使用历史事件契约检查通过。');
