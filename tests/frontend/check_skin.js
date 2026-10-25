#!/usr/bin/env node
// 皮肤契约：设置入口、列表/导入/删除接口、应用与恢复默认、安全过滤。

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..', '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const mainPy = fs.readFileSync(path.join(root, 'backend', 'main.py'), 'utf8');
const skins = fs.readFileSync(path.join(root, 'backend', 'core', 'skins.py'), 'utf8');

assert(html.includes("id=\"openSkinBtn\""), '设置里没有皮肤入口');
assert(html.includes('async function showSkinModal()'), '缺皮肤面板');
assert(html.includes("'/api/v1/skins'"), '没有调用皮肤列表接口');
assert(html.includes("'/api/v1/skins/import'"), '没有导入接口调用');
assert(html.includes('function applySkin(') && html.includes('function clearSkin('), '缺应用/恢复逻辑');
assert(html.includes('applySavedSkin();'), '启动时没有恢复上次皮肤');

assert(mainPy.includes('@app.get("/api/v1/skins")'), '后端缺皮肤列表');
assert(mainPy.includes('@app.post("/api/v1/skins/import")'), '后端缺导入');
assert(mainPy.includes('@app.delete("/api/v1/skins/{skin_id}")'), '后端缺删除');

assert(skins.includes('ALLOWED_VARS'), '缺 CSS 变量白名单');
assert(skins.includes('FORBIDDEN_PATTERNS'), '缺危险样式过滤');
assert(skins.includes('MAX_SKIN_BYTES'), '缺体积上限');

console.log('皮肤契约检查通过。');
