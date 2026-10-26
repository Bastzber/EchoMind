#!/usr/bin/env node
// 索引状态不闪烁契约：例行轮询不写占位文案

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '..', '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');

assert(html.includes('async function refreshProjectIndexStatus(options = {})'), '缺少 options 参数');
assert(html.includes('options.showPlaceholder && label && !label.textContent'), '占位文案没有条件控制');
assert(!/if \(label && !label\.textContent\) paintIndexStatusLabel\('读取中…'\);/.test(html), '仍在无条件写「读取中…」');
assert(html.includes('if (options.showPlaceholder) paintIndexStatusLabel'), '失败分支仍在写占位');

console.log('索引状态不闪烁契约检查通过。');
