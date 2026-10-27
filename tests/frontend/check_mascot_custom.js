#!/usr/bin/env node
// 自定义吉祥物契约

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '..', '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const mainJs = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
const preload = fs.readFileSync(path.join(root, 'preload.js'), 'utf8');

assert(html.includes('fishApplyCustomImage'), '缺自定义图片加载');
assert(html.includes('换成我的图'), '面板缺换图按钮');
assert(mainJs.includes("case 'mascot-pick'"), 'main 缺选图 IPC');
assert(mainJs.includes("case 'mascot-load'"), 'main 缺读图 IPC');
assert(preload.includes('pickMascot') && preload.includes('loadMascot'), 'preload 缺绑定');

console.log('自定义吉祥物契约检查通过。');
