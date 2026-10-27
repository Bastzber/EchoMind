#!/usr/bin/env node
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '..', '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const mainPy = fs.readFileSync(path.join(root, 'backend', 'main.py'), 'utf8');
const assist = fs.readFileSync(path.join(root, 'backend', 'core', 'assistant.py'), 'utf8');

['tag', 'move', 'transcode', 'remember'].forEach((t) => assert(assist.includes('"' + t + '"'), '缺工具 ' + t));
assert(assist.includes('assistant_memory'), '缺记忆表');
assert(mainPy.includes('/api/v1/assistant/speak'), '缺语音接口');
assert(mainPy.includes('/api/v1/assistant/events'), '缺事件接口');
assert(html.includes('fishSpeak'), '前端没接语音');
assert(html.includes('fishPollEvents'), '前端没接主动提醒');
assert(html.includes('fishBubble'), '缺气泡提示');

console.log('助理写操作/语音/主动提醒契约检查通过。');
