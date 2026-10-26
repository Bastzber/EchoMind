#!/usr/bin/env node
// 导入体验契约：进度框非阻塞（右下角）、可隐藏后台继续、索引延后到后台

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '..', '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const mainPy = fs.readFileSync(path.join(root, 'backend', 'main.py'), 'utf8');

assert(html.includes('bottom: 84px'), '进度框没有移到右下角');
assert(html.includes('hide-btn'), '缺隐藏按钮');
assert(html.includes('scanMiniBadge'), '缺后台迷你入口');
assert(!html.includes("top: 50%;\n                left: 50%;\n                transform: translate(-50%, -50%);\n                background: var(--bg-secondary);\n                border: 1px solid var(--border-color);\n                border-radius: 8px;\n                padding: 16px 20px;"), '仍在用居中模态');

assert(mainPy.includes('defer_vectors = True if total >= 1 else False'), '导入仍在同步算向量');
assert(mainPy.includes('post_import_index'), '没有排后台索引任务');
assert(mainPy.includes('_repair_index_task('), '没有复用后台索引任务');

console.log('导入体验契约检查通过。');
