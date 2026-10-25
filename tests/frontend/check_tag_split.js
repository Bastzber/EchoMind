#!/usr/bin/env node
// 标签分工契约：左侧只列用户自建标签，主列表展示每条音效自带的标签。

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..', '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');

// 1) 左侧不再聚合 files.tags
assert(html.includes('左侧标签面板只列'), '缺侧边栏标签来源说明');
assert(!html.includes('soundData.forEach(s => (s.tags || []).forEach(t => {'), '侧边栏还在从列表数据回填标签');
assert(html.includes('const layeredNow = window.__tagLayers'), '侧边栏没有改用标签表');

// 2) 主列表仍展示每条音效的标签
assert(html.includes('sound.tags.map(tag =>'), '主列表没有展示标签');

// 3) 详情面板启动默认收起
assert(html.includes('setDetailPanelOpen(true);'), '启动时没有展开详情面板');
assert(html.includes('id="detailAside" class="flex'), '详情面板初始不是展开');

console.log('标签分工与详情面板契约检查通过。');
