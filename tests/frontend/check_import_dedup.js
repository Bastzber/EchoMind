#!/usr/bin/env node
// 导入去重契约：三选一弹窗、skip_existing 贯通到后端

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '..', '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const mainJs = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
const preload = fs.readFileSync(path.join(root, 'preload.js'), 'utf8');
const mainPy = fs.readFileSync(path.join(root, 'backend', 'main.py'), 'utf8');
const schema = fs.readFileSync(path.join(root, 'backend', 'models', 'schemas.py'), 'utf8');

assert(html.includes('function showImportDuplicateChoice'), '缺三选一弹窗');
assert(html.includes("choice === 'new'"), '没有区分只导入新文件');
assert(html.includes('skipExistingOnImport'), '没有把选择传给导入调用');
assert(!/if \(!confirm\(message\)\)/.test(html), '仍在用原生 confirm');

assert(preload.includes('skipExisting'), 'preload 没有透传 skipExisting');
assert(mainJs.includes('skip_existing: Boolean(data.skipExisting)'), 'main.js 没有透传 skip_existing');
assert(schema.includes('skip_existing: bool'), 'schema 缺 skip_existing 字段');
assert(mainPy.includes('skip_existing'), '后端没有接收 skip_existing');
assert(mainPy.includes('duplicate_pairs'), '后端缺重复判定集合');
assert(mainPy.includes('duplicate_skipped'), '后端缺跳过计数');

console.log('导入去重契约检查通过。');
