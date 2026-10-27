#!/usr/bin/env node
// AI 助理契约

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '..', '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const mainPy = fs.readFileSync(path.join(root, 'backend', 'main.py'), 'utf8');

assert(html.includes('function showFishChat'), '缺聊天面板');
assert(html.includes('/api/v1/assistant/chat'), '前端没调用助理接口');
assert(html.includes('echomind.fishChat'), '缺对话记忆');
assert(mainPy.includes('@app.post("/api/v1/assistant/chat")'), '后端缺助理接口');
const modulePath = path.join(root, 'backend', 'core', 'assistant.py');
assert(fs.existsSync(modulePath), '缺 assistant 模块');
const mod = fs.readFileSync(modulePath, 'utf8');
['search', 'stats', 'unclassified', 'status', 'reply'].forEach((t) => {
  assert(mod.includes(t), '缺工具: ' + t);
});

console.log('AI 助理契约检查通过。');
