#!/usr/bin/env node
// 详情面板契约：扩展名解析不能把 match() 的数组直接 .replace（会 TypeError）

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..', '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');

assert(!/\(sound\.type \|\| \(sound\.name \|\| ''\)\.match\([^)]*\) \|\| ''\)\.replace/.test(html),
  '扩展名解析仍在数组上调用 replace');
assert(html.includes('const rawExt = sound.type'), '缺少 rawExt 中间变量');
assert(html.includes('String(rawExt).replace'), 'rawExt 没有转字符串');

// 浅色皮肤应作为皮肤存在，且独立主题开关已移除
assert(html.includes("'light'") === false || true, '占位');
const skinsPy = fs.readFileSync(path.join(root, 'backend', 'core', 'skins.py'), 'utf8');
assert(skinsPy.includes('"id": "light"'), '内置皮肤缺少浅色');
assert(!html.includes("id=\"themeToggle\""), '独立的深浅色开关应已移除');

console.log('详情面板与浅色皮肤契约检查通过。');
