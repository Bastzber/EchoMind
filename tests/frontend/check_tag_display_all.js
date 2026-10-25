#!/usr/bin/env node
// 标签展示契约：主列表和卡片视图都不允许截断标签。

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..', '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');

assert(!/sound\.tags[^\n]*\.slice\(0,\s*\d+\)/.test(html), '还有地方把标签截断');
assert(html.includes('sound.tags.map(tag =>'), '列表没有遍历全部标签');
assert(html.includes('(sound.tags || []).map((tag)'), '卡片没有遍历全部标签');
assert(!html.includes('sound.tags.length - 3'), '还有折叠提示');

console.log('标签全量展示契约检查通过。');
