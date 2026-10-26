#!/usr/bin/env node
// 多声道契约：声道条、逐声道波形、Solo/Mute、后端接口

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '..', '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const mainPy = fs.readFileSync(path.join(root, 'backend', 'main.py'), 'utf8');

assert(html.includes('id="channelBar"'), '缺声道条容器');
assert(html.includes('function renderChannelStrips()'), '缺声道条渲染');
assert(html.includes('/api/v1/audio/channels'), '没有请求逐声道波形');
assert(html.includes('/api/v1/audio/channel-mix'), '没有请求声道混音');
assert(html.includes("mkToggle('S'") && html.includes("mkToggle('M'"), '缺 Solo/Mute 按钮');
assert(html.includes('channelResetBtn'), '缺全部可听按钮');

assert(mainPy.includes('@app.get("/api/v1/audio/channels")'), '后端缺声道波形接口');
assert(mainPy.includes('@app.post("/api/v1/audio/channel-mix")'), '后端缺声道混音接口');
const mod = fs.readFileSync(path.join(root, 'backend', 'core', 'channel_tools.py'), 'utf8');
assert(mod.includes('def channel_peaks') && mod.includes('def render_channel_mix'), '缺声道工具实现');

console.log('多声道契约检查通过。');
