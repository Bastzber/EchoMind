#!/usr/bin/env node
// 效果器契约：折叠面板、预设接口、试听与导出

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '..', '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const mainPy = fs.readFileSync(path.join(root, 'backend', 'main.py'), 'utf8');

assert(html.includes("id = 'effectPanel'") || html.includes("id='effectPanel'") || html.includes("effectSection.id = 'effectPanel'"), '缺效果器面板');
assert(html.includes("'/api/v1/audio/effect-presets'"), '没有加载预设');
assert(html.includes("'/api/v1/audio/apply-effect'"), '没有应用效果');
assert(html.includes("'/api/v1/audio/export-effect'"), '没有导出效果');
assert(html.includes('effectState.active'), '缺效果器开关状态');

assert(mainPy.includes('@app.get("/api/v1/audio/effect-presets")'), '后端缺预设接口');
assert(mainPy.includes('@app.post("/api/v1/audio/apply-effect")'), '后端缺应用接口');
assert(mainPy.includes('@app.post("/api/v1/audio/export-effect")'), '后端缺导出接口');
const mod = fs.readFileSync(path.join(root, 'backend', 'core', 'effects.py'), 'utf8');
assert(mod.includes('PRESETS') && mod.includes('def apply_effect'), '缺效果器实现');
assert(mod.includes('hall') && mod.includes('church') && mod.includes('tunnel'), '预设不足');

console.log('效果器契约检查通过。');
