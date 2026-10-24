#!/usr/bin/env node
// 标签管理的契约：批量合并/删除/预设模板，且必须走后端接口而不是本地改内存。

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..', '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const mainPy = fs.readFileSync(path.join(root, 'backend', 'main.py'), 'utf8');

const start = html.indexOf('const TAG_PRESETS');
const end = html.indexOf('// ==================== SOUND LIST ====================');
assert(start > 0 && end > start, '找不到标签管理代码');
const block = html.slice(start, end);

assert(block.includes("'/api/v1/tags/usage"), '没有读权威标签用量');
assert(block.includes("'/api/v1/tags/merge"), '没有合并接口');
assert(block.includes("'/api/v1/tags/delete"), '没有删除接口');
assert(block.includes('TAG_PRESETS'), '没有预设标签模板');
assert(block.includes('套用预设标签'), '没有套用预设的按钮');
assert(block.includes('loadTagStats()'), '操作后没有刷新标签树');
assert(!block.includes('soundData.forEach'), '还在用本地 soundData 统计（分页数据不全）');

// 预设标签：三组、共 21 个
const presetBlock = block.slice(block.indexOf('const TAG_PRESETS'), block.indexOf('async function showTagManagerModal'));
for (const group of ['类型', '场景', '特性']) {
  assert(presetBlock.includes("'" + group + "'"), '预设缺分组 ' + group);
}
const presetCount = (presetBlock.match(/'[^']+'/g) || []).length - 3;  // 减去三个分组名
assert(presetCount === 21, '预设标签应为 21 个，实际 ' + presetCount);

// 后端接口存在
for (const route of ['/api/v1/tags/usage', '/api/v1/tags/rename', '/api/v1/tags/delete', '/api/v1/tags/merge']) {
  assert(mainPy.includes(route), '后端缺接口 ' + route);
}

console.log('标签管理契约检查通过。');
