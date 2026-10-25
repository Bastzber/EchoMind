#!/usr/bin/env node
// 去人声契约：注册表有入口、调后端接口、后端有实现。

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..', '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const mainPy = fs.readFileSync(path.join(root, 'backend', 'main.py'), 'utf8');

assert(html.includes("id: 'devocal'"), '常用条没有去人声');
assert(html.includes("'/api/v1/audio/remove-vocals'"), '没有调去人声接口');
assert(html.includes('_去人声'), '没有说明输出目录');
assert(mainPy.includes('@app.post("/api/v1/audio/remove-vocals")'), '后端缺去人声接口');

const vocals = fs.readFileSync(path.join(root, 'backend', 'core', 'vocals.py'), 'utf8');
assert(vocals.includes('def remove_vocals'), '缺 remove_vocals 实现');
assert(vocals.includes('left - right'), '缺中置消除算法');

console.log('去人声契约检查通过。');
