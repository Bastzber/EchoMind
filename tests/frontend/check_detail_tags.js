#!/usr/bin/env node
// 详情面板保存标签后，左侧标签树必须跟着刷新（否则用户以为"没保存"）。

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..', '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');

const block = html.slice(
  html.indexOf("const nextTags = parseTagsInput(tagsInput.value);"),
  html.indexOf("// ---- 一句话描述 ----")
);

assert(block.includes('setSoundTags(sound, nextTags'), '详情面板没有写标签');
assert(block.includes('await loadTagStats()'), '保存标签后没有刷新左侧标签树');
assert(block.indexOf('await loadTagStats()') > block.indexOf('setSoundTags(sound, nextTags'),
  '刷新必须在保存成功之后');
assert(block.includes('sound.tags = previous'), '保存失败要回滚界面');

// 标签树刷新函数本身要会重画侧栏
const statsFn = html.slice(
  html.indexOf('async function loadTagStats()'),
  html.indexOf('// 标签右键：切换场景/属性层、删除')
);
assert(statsFn.includes('renderCategoryTree()'), 'loadTagStats 没有重画侧栏');
assert(statsFn.includes("'/api/v1/tags'"), 'loadTagStats 没有拉分层标签');

console.log('详情面板标签同步的契约检查通过。');
