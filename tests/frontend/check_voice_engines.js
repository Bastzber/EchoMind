#!/usr/bin/env node
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '..', '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const mainPy = fs.readFileSync(path.join(root, 'backend', 'main.py'), 'utf8');
const vc = fs.readFileSync(path.join(root, 'backend', 'core', 'voice_clone.py'), 'utf8');

assert(html.includes('voiceEngineSelect'), '缺引擎选择下拉');
assert(html.includes('voiceRefTextInput'), '缺样音文稿输入');
assert(html.includes("provider: engine"), '克隆请求没带 provider');
assert(mainPy.includes('profile.get("provider")'), '后端没按 provider 分流');
assert(vc.includes('provider="breeze"'), 'voice_clone 没存 breeze 档案');
console.log('声音克隆双引擎契约检查通过。');
