#!/usr/bin/env node
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '..', '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const preload = fs.readFileSync(path.join(root, 'preload.js'), 'utf8');

assert(!/electronAPI\??\.dialog\b/.test(html), '仍在使用不存在的 electronAPI.dialog');
assert(html.includes('dialogs?.showOpenDialog'), '声音克隆没有用正确的对话框接口');
assert(preload.includes('showOpenDialog'), 'preload 缺 showOpenDialog');
console.log('声音克隆选文件契约检查通过。');
