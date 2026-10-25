#!/usr/bin/env node
// 顶栏契约：状态胶囊/按钮不换行、每个状态有问号说明、磁盘显示已移除、设置在最右。

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..', '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');

// 1) 不再显示磁盘
assert(html.includes('<div id="diskSpaceDisplay" class="hidden">'), '磁盘显示没有隐藏');
assert(!html.includes('xl:flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs border opacity-80'), '旧的磁盘显示还在');

// 2) 状态胶囊与按钮不换行
assert(html.includes('id="indexStatusDisplay" class="grid grid-cols-[auto_auto_auto_auto]'), '索引状态不是两行四列网格');
assert((html.match(/whitespace-nowrap/g) || []).length >= 4, '状态行缺 nowrap');
assert(html.includes("label: '修复索引'"), '修復索引不在注册表里');
assert(html.includes("label: '重建索引'"), '重建索引不在注册表里');

// 3) 每个状态都有问号说明
const helps = [
  '模型状态&#10;',
  '索引状态&#10;',
  '索引状态&#10;&#10;上排音频',
];
// 修复/重建的说明现在在常用条注册表里
assert(html.includes("id: 'reindex'"), '注册表缺修复索引');
assert(html.includes("id: 'rebuild'"), '注册表缺重建索引');
for (const key of helps) assert(html.includes(key), '缺少说明: ' + key);

// 4) 设置在最右（在描述包按钮之后）
const descPos = html.indexOf('id="descPackMenuBtn"');
const setPos = html.indexOf('id="settingsBtn"');
assert(descPos > 0 && setPos > descPos, '设置按钮没有移到右侧');

// 5) 问号系统完整
assert(html.includes('id="helpTip"'), '缺 helpTip 节点');
assert(html.includes('function initHelpTips'), '缺问号逻辑');
assert((html.match(/data-help=/g) || []).length >= 8, '问号数量偏少');
assert(html.includes('.help-dot'), '缺问号样式');

console.log('顶栏与帮助契约检查通过。');
