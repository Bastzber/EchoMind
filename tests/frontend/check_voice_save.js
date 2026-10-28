#!/usr/bin/env node
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '..', '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const mainPy = fs.readFileSync(path.join(root, 'backend', 'main.py'), 'utf8');
assert(html.includes('voicePlayBtn') && html.includes('voiceSaveBtn'), '缺试听/保存按钮');
assert(html.includes('/api/v1/files/copy'), '前端没调用另存接口');
assert(mainPy.includes('@app.post("/api/v1/files/copy")'), '后端缺另存接口');
console.log('语音试听与保存契约检查通过。');
