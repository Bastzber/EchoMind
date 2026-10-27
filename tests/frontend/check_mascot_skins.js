#!/usr/bin/env node
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '..', '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
assert(html.includes('MASCOT_SCHEMES'), '缺配色列表');
assert(html.includes('assets/mascot/baked/'), '没有引用烘焙图');
assert(html.includes('fishSchemeSelect') && html.includes('fishExprSelect'), '缺切换下拉');
const baked = path.join(root, 'assets', 'mascot', 'baked');
const files = fs.readdirSync(baked);
assert(files.length >= 32, '烘焙图不足 32 张，实际 ' + files.length);
console.log('吉祥物皮肤契约检查通过（烘焙图 ' + files.length + ' 张）。');
