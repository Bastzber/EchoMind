#!/usr/bin/env node
// 标签展示契约：①主列表全部展示 ②侧边栏只放常用的十几个。

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..', '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');

assert(!/sound\.tags[^\n]*\.slice\(0,\s*\d+\)/.test(html), '主列表还在截断标签');
assert(html.includes('sound.tags.map(tag =>'), '主列表没有遍历全部标签');
assert(html.includes('(sound.tags || []).map((tag)'), '卡片没有遍历全部标签');
assert(html.includes('TAG_SIDEBAR_LIMIT'), '侧边栏没有限制标签数量');
assert(html.includes('查看全部 '), '侧边栏缺少「查看全部」入口');
assert(html.includes('visibleTagNames.forEach'), '侧边栏没有用受限列表渲染');

console.log('标签展示契约检查通过。');
