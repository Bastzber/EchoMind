#!/usr/bin/env node
// 批量重命名：页面接线 + 纯逻辑行为。
// 单独成文件，避免被 check_renderer_contract.js 里既有的音频断言失败掩盖。

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.resolve(__dirname, '..', '..');
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');

async function main() {
  const indexHtml = read('index.html');
  const renameSource = read('assets/renderer/rename.js');

  // ---------- 模块行为 ----------
  const context = { console };
  context.window = context;
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(renameSource, context, { filename: 'rename.js' });
  const rename = context.SoundBotRenderer.rename;
  assert(rename, 'rename 模块没有注册到 SoundBotRenderer');

  assert.strictEqual(rename.validateName('   '), '新文件名不能为空', '空文件名没有被拒绝');
  assert.strictEqual(rename.validateName('雨声 01.wav'), '', '合法文件名被误拒');
  for (const bad of ['a/b.wav', 'a\\b.wav', 'a:b.wav', 'a*b.wav', 'a?b.wav', 'a"b.wav', 'a<b.wav', 'a>b.wav', 'a|b.wav']) {
    assert.strictEqual(
      rename.validateName(bad),
      '文件名不能包含 \\ / : * ? " < > |',
      `非法字符没有被拒绝: ${bad}`
    );
  }

  assert.strictEqual(rename.basename('C:\\Audio\\雨声\\a.wav'), 'a.wav', 'Windows 取文件名错误');
  assert.strictEqual(rename.basename('/tmp/a.wav'), 'a.wav', 'POSIX 取文件名错误');
  assert.strictEqual(rename.basename('C:\\Audio\\trailing\\'), '', '目录路径应该没有文件名');

  // ---- 批量规则：前缀 / 后缀 / 查找替换 / 自动编号 ----
  assert.deepStrictEqual(
    JSON.parse(JSON.stringify(rename.splitExtension('林间鸟鸣_01.wav'))),
    { stem: '林间鸟鸣_01', ext: '.wav' },
    '扩展名没拆出来'
  );
  assert.deepStrictEqual(
    JSON.parse(JSON.stringify(rename.splitExtension('no_ext'))),
    { stem: 'no_ext', ext: '' },
    '没有扩展名的文件名被拆错了'
  );
  assert.deepStrictEqual(
    JSON.parse(JSON.stringify(rename.splitExtension('a.b.c.WAV'))),
    { stem: 'a.b.c', ext: '.WAV' },
    '多点文件名只该按最后一段拆'
  );

  assert.strictEqual(rename.applyRules('林中鸟.wav', {}), '林中鸟.wav', '空规则不应该改名');
  assert.strictEqual(rename.applyRules('林中鸟.wav', { prefix: 'SFX_', suffix: '_v2' }), 'SFX_林中鸟_v2.wav', '前后缀位置不对');
  assert.strictEqual(rename.applyRules('city_street_02.wav', { find: '_', replace: ' ' }), 'city street 02.wav', '查找替换没生效');
  assert.strictEqual(
    rename.applyRules('a.wav', { find: 'wav', replace: 'mp3' }),
    'a.wav',
    '查找替换改到了扩展名'
  );
  const numbering = { enabled: true, start: 5, digits: 2, separator: '_' };
  assert.strictEqual(rename.applyRules('x.wav', { numbering }, 0), '05_x.wav', '编号起始值不对');
  assert.strictEqual(rename.applyRules('x.wav', { numbering }, 2), '07_x.wav', '编号没有跟着行号走');
  assert.strictEqual(
    rename.applyRules('x.wav', { numbering: { enabled: false, start: 5, digits: 2 } }, 0),
    'x.wav',
    '关闭编号后仍在编号'
  );
  assert.strictEqual(
    rename.applyRules('x.wav', { prefix: 'SFX_', numbering }, 0),
    'SFX_05_x.wav',
    '前缀应该在编号之前'
  );
  assert.strictEqual(
    rename.applyRules('x.wav', { numbering: { enabled: true, start: 1, digits: 0, separator: '' } }, 0),
    '1x.wav',
    '位数写 0 时应该退化成不补零'
  );
  assert.strictEqual(rename.applyRules('x.wav', { prefix: '好声音', find: 'x', replace: '雨' }), '好声音雨.wav', '规则组合顺序不对');

  const planSounds = [
    { id: 'u1', fileId: 'u1', name: 'a.wav', filePath: 'C:\\x\\a.wav' },
    { id: 'u2', fileId: 'u2', name: 'b.wav', filePath: 'C:\\x\\b.wav' },
    { id: 'u3', name: 'c.wav', filePath: 'C:\\x\\c.wav' }
  ];
  const plan = rename.planItems(planSounds, { u1: 'a.wav', u2: '  风 02  ', u3: '   ' });
  assert.deepStrictEqual(
    JSON.parse(JSON.stringify(plan)),
    [{ file_uuid: 'u2', new_name: '风 02', old_name: 'b.wav' }],
    '未改动或空白的行混进了变更计划'
  );
  assert.strictEqual(
    rename.planItems([{ id: 'u3', name: 'c.wav' }], { u3: 'd.wav' })[0].file_uuid,
    'u3',
    '变更计划没有回退到 sound.id 取 file_uuid'
  );

  const applied = rename.applyResults(
    [
      { id: 'u2', fileId: 'u2', name: 'b.wav', filePath: 'C:\\x\\b.wav' },
      { id: 'u9', fileId: 'u9', name: 'z.wav', filePath: 'C:\\x\\z.wav' }
    ],
    [
      { file_uuid: 'u2', ok: true, new_name: '风 02', new_path: 'C:\\x\\风 02.wav' },
      { file_uuid: 'u9', ok: false, message: '目标文件已存在' }
    ]
  );
  assert.strictEqual(applied.updated.length, 1, '改名成功的文件没有回写');
  assert.strictEqual(applied.updated[0].name, '风 02.wav', '丢掉了后端补上的扩展名');
  assert.strictEqual(applied.updated[0].filePath, 'C:\\x\\风 02.wav', '新路径没有回写');
  assert.strictEqual(applied.failed.length, 1, '改名失败被当成了成功');
  assert.strictEqual(applied.failed[0].message, '目标文件已存在', '失败原因丢失');

  assert.deepStrictEqual(
    JSON.parse(JSON.stringify(rename.summarize([{ ok: true }, { ok: true }, { ok: false }]))),
    { total: 3, ok: 2, failed: 1 },
    '汇总计数错误'
  );

  // ---------- 页面接线 ----------
  assert(
    indexHtml.includes('<script src="./assets/renderer/rename.js"></script>'),
    '批量重命名模块未加载'
  );
  assert(indexHtml.includes('rendererModules.rename'), '批量重命名模块未被页面引用');
  assert(indexHtml.includes("'/api/v1/files/rename'"), '批量重命名接口未接线');
  assert(/dry_run:\s*true/.test(indexHtml), '预览没有走 dry_run');
  assert(/dry_run:\s*false/.test(indexHtml), '执行仍然停在 dry_run');
  assert(indexHtml.includes('showBatchRenameModal('), '批量重命名弹窗入口缺失');
  assert(indexHtml.includes('应用到全部'), '弹窗里没有「应用到全部」');
  assert(/rendererRename\.applyRules\(/.test(indexHtml), '批量规则没有接到弹窗上');
  assert(indexHtml.includes('批量重命名'), '右键菜单没有批量重命名文案');

  // ---------- 内联脚本语法 ----------
  const inlineScripts = [...indexHtml.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)];
  assert(inlineScripts.length > 0, '没有找到内联脚本');
  for (const [index, match] of inlineScripts.entries()) {
    new vm.Script(match[1], { filename: `index.inline.${index}.js` });
  }

  console.log('批量重命名契约检查通过。');
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
