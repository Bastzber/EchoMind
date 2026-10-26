#!/usr/bin/env node
// 转码契约：逐条结果、输出目录提示、无选中时提示

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '..', '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');

assert(html.includes('id="tcResults"'), '缺结果列表');
assert(html.includes('id="tcOutHint"'), '缺输出目录提示');
assert(html.includes('function addRow') || html.includes('const addRow ='), '缺逐条渲染');
assert(html.includes('救回（部分数据损坏）'), '缺救回提示');
assert(html.includes('没有选中任何文件'), '缺空选择提示');
assert(html.includes("'输出位置：每个源文件同级的「_转码」子文件夹'"), '缺默认输出位置说明');

console.log('转码体验契约检查通过。');
