# 交接文档（新会话从这里读）

更新：2026-10-24

## 一、项目位置与运行

```
E:\音效库管理软件\EchoMind\EchoMind-main     ← 代码
E:\音效库管理软件\EchoMind\EchoMind-main\dist-electron-v5\EchoMind测试版V8.zip   ← 最新安装包
```

**开发模式（改完 Ctrl+R 生效，不用打包）**

```powershell
cd E:\音效库管理软件\EchoMind\EchoMind-main
powershell -ExecutionPolicy Bypass -File scripts\dev.ps1
```

**打包发版**

```powershell
.venv\Scripts\python.exe -m PyInstaller backend\main.spec --distpath dist\backend --workpath dist\build --noconfirm --clean
npx --no-install electron-builder --win --x64 --config.directories.output=dist-electron-v5
```

## 二、当前版本

- `0.3.0-beta.8`（测试版 V8），health 接口可验证
- 数据库：`%APPDATA%\EchoMind\db\soundmind.db`
- 库内 48,648 条音效，音频/文本/波形索引 100% 就绪

## 三、已完成功能

- 标签双层（场景/属性）+ 右键设标签 + 按标签筛选 + `tag:名称` 搜索
- 中文语义搜索（bge-small-zh 512 维，内置），短词 0.05s、长句 0.3s
- 拟音工坊（五类环境音、四音轨、远近×强弱、历史录音）
- 星标收藏、重复音效检测、排序、来源标记
- 文件夹右键删除（可选删源文件 + 回收站）
- 批量重命名（多选右键 →「批量重命名…」→ 预览 → 执行）

## 四、已完成：批量重命名

后端 `POST /api/v1/files/rename`（`dry_run` 默认 true）+ 前端弹窗，已联调。

- 入口：多选后右键「批量重命名… (N)」；单选仍是原来的单文件「重命名」
- 弹窗：原名 / 新名（可编辑）/ 状态 三列 +「全部还原」，回车即预览
- 预览：调 `dry_run`，逐行标可改 / 失败（带后端原因）；空名、非法字符前端先拦
- 执行：两步确认（按钮变红「确认执行 N 个？」再点一次才动盘），成功后刷新列表与文件夹树
- 改动任意一行都会作废上次预览，必须重新预览才能执行；一次最多 500 行
- 代码：纯逻辑在 `assets/renderer/rename.js`（校验 / 变更计划 / 结果回写），
  弹窗与右键入口在 `index.html`（`showBatchRenameModal` / `showSoundContextMenu`）
- 没做的：前缀 / 查找替换 / 自动编号这类「批量规则生成」，目前是逐行手改

测试（本机没有全局 node，用 electron 当 node 跑）：

```powershell
$env:ELECTRON_RUN_AS_NODE='1'
.\node_modules\electron\dist\electron.exe tests\frontend\check_batch_rename.js
```

## 五、待办

| 优先级 | 项 |
|---|---|
| P0 | 林间鸟鸣无声（音频有内容，播放链路待查） |
| P1 | 拟音工坊试听面板移到右侧（三栏布局） |
| P2 | 各环境音细节区分度调参 |
| P2 | 描述包导入未匹配 CSV 导出 |
| P3 | `metadata/apply` 后自动重建文本索引 |

## 六、已知坑（踩过的）

- `main.js` 优先找打包后端；开发必须设 `SOUNDBOT_BACKEND_DEV=1`（dev.ps1 已含）
- 端口 8000 被旧 `soundbot-backend.exe` 占用会导致新接口 404，先杀进程
- 编辑 `package.json` 时不能带 BOM，否则 electron-builder 报 JSON 解析失败
- 后端 `tags` 列是 JSON 字符串，前端必须 `normalizeTags` 转数组
- git 需要显式代理：`git config http.proxy http://127.0.0.1:7890`
- `tests/frontend/check_renderer_contract.js` 在 HEAD 上就是红的：第 87 行断言
  `TRANSCODE_EXTENSIONS` 不含 `wav`，但 `assets/renderer/audio.js` 从首次提交起就含 `wav`。
  它一红就中止，后面所有断言都不跑——新功能请单独开 `tests/frontend/check_*.js`，
  别往这个文件里加（不然等于没加）。这行要不要改，取决于 `wav` 走转码是不是故意的
  （可能和 P0「林间鸟鸣无声」有关），别顺手删断言。
- 本机常驻 `ELECTRON_RUN_AS_NODE=1`：跑需要真 Electron 的检查（如
  `check_electron_preload.js`）前要先 `Remove-Item Env:ELECTRON_RUN_AS_NODE`
- 本机没有全局 `node`，跑 js 脚本用 `node_modules\electron\dist\electron.exe`

## 七、文档

- `docs/EchoMind-V6-更新说明.md/.docx`（面向用户）
- `docs/EchoMind-V6-安装指南.md/.docx`
- `CHANGELOG.md`、`docs/dev-status-2026-10-24.md`
