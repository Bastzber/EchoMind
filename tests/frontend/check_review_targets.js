#!/usr/bin/env node
// 审阅面板交互契约：目标目录用 datalist 候选

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '..', '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const mainPy = fs.readFileSync(path.join(root, 'backend', 'main.py'), 'utf8');

assert(html.includes('id="reviewTargetList"'), '缺目标目录 datalist');
assert(html.includes('list="reviewTargetList"'), '输入框没有绑定候选');
assert(html.includes('/api/v1/db/review/targets'), '没有请求候选目录');
assert(mainPy.includes('@app.get("/api/v1/db/review/targets")'), '后端缺候选目录接口');

console.log('审阅目标目录契约检查通过。');
