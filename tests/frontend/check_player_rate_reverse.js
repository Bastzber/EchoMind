#!/usr/bin/env node
// 播放器契约：倍速 + 倒放（后端接口 + 前端控件）

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '..', '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const mainPy = fs.readFileSync(path.join(root, 'backend', 'main.py'), 'utf8');

assert(html.includes('id="playbackRateSelect"'), '缺倍速下拉');
assert(html.includes("localStorage.getItem('echomind.playbackRate')"), '倍速没有持久化');
assert(html.includes('applyPlaybackRate()'), '缺倍速应用函数');
assert(html.includes('id="reverseBtn"'), '缺倒放按钮');
assert(html.includes("'/api/v1/audio/reverse'"), '没有调用倒放接口');
assert(html.includes('function resolveAudioSourceWithReverse'), '缺倒放音源解析');

assert(mainPy.includes('@app.post("/api/v1/audio/reverse")'), '后端缺倒放接口');
const mod = fs.readFileSync(path.join(root, 'backend', 'core', 'audio_reverse.py'), 'utf8');
assert(mod.includes('def reverse_to_wav'), '缺倒放实现');

console.log('播放器倍速与倒放契约检查通过。');
