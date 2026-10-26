#!/usr/bin/env node
// 设置与效果器契约：设置不再引用未声明函数；常用条有「效果器」入口

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '..', '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');

assert(!/\bloadWindowPrefs\?\.\(\)/.test(html), 'openSettingsModal 仍直接调用作用域外的 loadWindowPrefs');
assert(html.includes('window.__loadWindowPrefs?.()'), '设置没有通过全局钩子读取窗口设置');
assert(html.includes('window.__loadWindowPrefs = loadWindowPrefs'), '没有把 loadWindowPrefs 挂到 window');

assert(html.includes("id: 'fx'") && html.includes("label: '效果器'"), '常用条缺效果器入口');
assert(html.includes('function openEffectPanel()'), '缺 openEffectPanel 实现');
assert(html.includes("section.scrollIntoView"), '打开效果器没有滚动定位');

console.log('设置与效果器入口契约检查通过。');
