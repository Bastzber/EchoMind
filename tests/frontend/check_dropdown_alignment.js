#!/usr/bin/env node
// 顶栏下拉契约：靠右的菜单必须右对齐，且高度受限可滚动。

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..', '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');

const line = html.split('\n').find((l) => l.includes('id="settingsDropdown"'));
assert(line, '找不到设置下拉');
assert(line.includes('right-0'), '设置下拉没有右对齐，会跑出窗口');
assert(!line.includes('left-0'), '设置下拉还在用 left-0');
assert(line.includes('max-h-'), '设置下拉没有限高');
assert(line.includes('overflow-y-auto'), '设置下拉不能滚动');

console.log('顶栏下拉定位契约检查通过。');
