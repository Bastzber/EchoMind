#!/usr/bin/env node
// 声音克隆契约：导航入口、三步弹窗、后端接口、音色档案

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '..', '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const mainPy = fs.readFileSync(path.join(root, 'backend', 'main.py'), 'utf8');

assert(html.includes('id="voiceCloneBtn"'), '导航缺声音克隆按钮');
const navOrder = html.indexOf('拟音工坊') < html.indexOf('id="voiceCloneBtn"');
assert(navOrder, '声音克隆应排在拟音工坊之后');
assert(html.includes('function showVoiceCloneModal('), '缺弹窗实现');
assert(html.includes("'/api/v1/voice/clone'"), '没有调用克隆接口');
assert(html.includes("'/api/v1/voice/speak'"), '没有调用合成接口');
assert(html.includes("'/api/v1/voice/profiles'"), '没有读取音色档案');

assert(mainPy.includes('@app.post("/api/v1/voice/clone")'), '后端缺克隆接口');
assert(mainPy.includes('@app.post("/api/v1/voice/speak")'), '后端缺合成接口');
assert(mainPy.includes('@app.get("/api/v1/voice/profiles")'), '后端缺档案接口');
const mod = fs.readFileSync(path.join(root, 'backend', 'core', 'voice_clone.py'), 'utf8');
assert(mod.includes('def clone_voice') && mod.includes('def speak'), '缺复刻实现');
assert(mod.includes('MIN_SECONDS'), '缺时长校验');

console.log('声音克隆契约检查通过。');
