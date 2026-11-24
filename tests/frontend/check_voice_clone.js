#!/usr/bin/env node
// 声音克隆契约：导航入口、三步弹窗、后端接口、音色档案

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '..', '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const mainPy = fs.readFileSync(path.join(root, 'backend', 'main.py'), 'utf8');
// 弹窗实现已经从 index.html 搬进 assets/renderer/voice-clone.js，测试跟着搬
const cloneJs = fs.readFileSync(path.join(root, 'assets', 'renderer', 'voice-clone.js'), 'utf8');

assert(html.includes('id="voiceCloneBtn"'), '导航缺声音克隆按钮');
const navOrder = html.indexOf('拟音工坊') < html.indexOf('id="voiceCloneBtn"');
assert(navOrder, '声音克隆应排在拟音工坊之后');
assert(html.includes('assets/renderer/voice-clone.js'), 'index.html 没加载 voice-clone.js');
assert(cloneJs.includes('function showVoiceCloneModal('), '缺弹窗实现');
assert(cloneJs.includes("'/api/v1/voice/clone'"), '没有调用克隆接口');
assert(cloneJs.includes("'/api/v1/voice/speak'"), '没有调用合成接口');
assert(cloneJs.includes("'/api/v1/voice/profiles'"), '没有读取音色档案');

// 11-25：长音频面板删除（短音频本身能念 4 分半），下面的断言盯着「别又冒出来」
assert(!cloneJs.includes('voiceTabLong'), '长音频标签页已删除，不该再出现');
assert(!cloneJs.includes('renderLongTtsPanel'), '长音频面板已删除，不该再挂渲染函数');
assert(!html.includes('assets/renderer/tts-long.js'), 'index.html 不该再加载 tts-long.js');
assert(!fs.existsSync(path.join(root, 'assets', 'renderer', 'tts-long.js')), 'tts-long.js 已删除');
// 内置 OmniVoice 引擎必须可选，VoiceStudio 应用这个外部依赖已从下拉框移除
// 弹窗 HTML 是拼进 JS 字符串的，属性里的引号在源码里是转义过的
assert(cloneJs.includes('value=\\"omnivoice\\"'), '引擎下拉缺内置 OmniVoice');
assert(!cloneJs.includes('value=\\"voicestudio\\"'), '引擎下拉不该再有 VoiceStudio 应用');

assert(mainPy.includes('@app.post("/api/v1/voice/clone")'), '后端缺克隆接口');
assert(mainPy.includes('@app.post("/api/v1/voice/speak")'), '后端缺合成接口');
assert(mainPy.includes('@app.get("/api/v1/voice/profiles")'), '后端缺档案接口');
const mod = fs.readFileSync(path.join(root, 'backend', 'core', 'voice_clone.py'), 'utf8');
assert(mod.includes('def clone_voice') && mod.includes('def speak'), '缺复刻实现');
assert(mod.includes('MIN_SECONDS'), '缺时长校验');

console.log('声音克隆契约检查通过。');
