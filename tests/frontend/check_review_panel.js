#!/usr/bin/env node
// 待归类审阅契约：面板、接口、移动逻辑

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '..', '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const mainPy = fs.readFileSync(path.join(root, 'backend', 'main.py'), 'utf8');

assert(html.includes("id: 'review'"), '常用条缺「待归类审阅」入口');
assert(html.includes('async function showReviewPanel'), '缺审阅面板实现');
assert(html.includes('/api/v1/db/review/unclassified'), '面板没有请求待归类列表');
assert(html.includes('/api/v1/db/review/move'), '面板没有调用归类接口');
assert(html.includes('reviewPlay') && html.includes('reviewApply'), '缺播放/归类按钮');

assert(mainPy.includes('@app.get("/api/v1/db/review/unclassified")'), '后端缺待归类列表接口');
assert(mainPy.includes('@app.post("/api/v1/db/review/move")'), '后端缺归类接口');
assert(mainPy.includes('shutil.move(str(source), str(target))'), '归类没有真正移动文件');
assert(mainPy.includes('UPDATE files SET path=?, canonical_path=?'), '归类后没有同步库内路径');

console.log('待归类审阅契约检查通过。');
