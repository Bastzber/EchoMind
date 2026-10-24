# 交接文档（新会话从这里读）

更新：2026-10-24

## 一、项目位置与运行

```
E:\音效库管理软件\EchoMind\EchoMind-main     ← 代码
E:\音效库管理软件\EchoMind\EchoMind-main\dist-electron-v5\EchoMind测试版V9.zip   ← 最新安装包
```

**开发模式（改完 Ctrl+R 生效，不用打包）**

```powershell
cd E:\音效库管理软件\EchoMind\EchoMind-main
powershell -ExecutionPolicy Bypass -File scripts\dev.ps1
```

**打包发版 —— 只在用户明确说「打包」时才做**

> ⚠ 一整套要 **8~9 分钟**（后端 ≈4 + 安装包 ≈5）。改完代码一律走 dev 模式 + Ctrl+R 验证，
> **不要顺手重打包**。那次「顺手把修复也打进包里」就是典型反面教材：多花 9 分钟，
> 用户还得等。要新版安装包会明说。

```powershell
# 1) 后端，约 4 分钟
.venv\Scripts\python.exe -m PyInstaller backend\main.spec --distpath dist\backend --workpath dist\build --noconfirm --clean

# 2) 安装包，约 5 分钟（产出 dist-electron-v5\EchoMind-<版本>-win.zip）
npx --no-install electron-builder --win --x64 --config.directories.output=dist-electron-v5
```

**本机没有 node/npm**（PATH 里没有，只有 DSH 自带的 node）时，第 2 步改成：

```powershell
$env:PATH = '<npm 垫片目录>;<DSH node 所在 bin>;' + $env:PATH
& '<DSH node>\node.exe' node_modules\electron-builder\out\cli\cli.js --win --x64 --config.directories.output=dist-electron-v5
```

垫片（`npm.cmd`）只需要回一行"空依赖树"的 JSON：本项目零生产依赖，`main.js` 只
`require('electron')` + 内置模块，所以那是真实结果，不是糊弄 electron-builder。
跑完 zip 名是 `EchoMind-<版本>-win.zip`，按习惯改名成 `EchoMind测试版V9.zip` 即可。

## 二、当前版本

- `0.3.0-beta.9`（测试版 V9），health 接口可验证
- 数据库：`%APPDATA%\EchoMind\db\soundmind.db`
- 库内 48,648 条音效，音频/文本/波形索引 100% 就绪

## 三、已完成功能

- 标签双层（场景/属性）+ 右键设标签 + 按标签筛选 + `tag:名称` 搜索
- 中文语义搜索（bge-small-zh 512 维，内置），短词 0.05s、长句 0.3s
- 拟音工坊（五类环境音、四音轨、远近×强弱、历史录音）
- 星标收藏、重复音效检测、排序、来源标记
- 文件夹右键删除（可选删源文件 + 回收站）
- 批量重命名（多选右键 →「批量重命名…」→ 预览 → 执行）
- 拟音工坊：修复林间鸟鸣静音（音轨接口白名单漏了 forest，四条音轨全被 400）
- 「我的文件夹」移出：在「常用」这类自定义文件夹视图里右键，单条或多选都能「从「X」移出」
- 左侧栏：源目录板块改名「音效库目录 · 名称不可改」+ 板块内搜索；新增「全部音效」一键回全库；收藏可再点取消
- 右侧「详情」面板（工具栏「详情」按钮）：看/改文件名（会改磁盘源文件）、标签、一句话描述 + 文件信息；
  三个保存按钮都有就地反馈（保存中… / ✓ 已保存 / 保存失败），描述与标签先改界面再等接口
  （描述接口 `POST /api/v1/files/{uuid}/description`：同步 FTS + 标脏该行文本向量，
  并自动调度 `_schedule_project_reconcile(["text_vector"], reason="description")` 做增量对账，
  只重算 stale 行；实测 processed 1/1、全库 ready 数不变）

## 四、已完成：批量重命名

后端 `POST /api/v1/files/rename`（`dry_run` 默认 true）+ 前端弹窗，已联调。

- 入口：多选后右键「批量重命名… (N)」；单选仍是原来的单文件「重命名」
- 弹窗：原名 / 新名（可编辑）/ 状态 三列 +「全部还原」，回车即预览
- 批量规则栏：前缀 / 后缀 / 查找替换（字面量或正则，只作用在主名，不碰扩展名）/
  大小写（原样 / 全小写 / 全大写 / 首字母大写）/ 自动编号（起始、位数、分隔符）
  - 「应用到全部」一律按**原名**重算，所以连点两次不会叠出两层前缀，
    代价是**手改过的行会被覆盖**；要保留就先应用规则再逐行微调
  - 正则写错不会炸弹窗：错误提示在统计行 + 通知里，名字原样不动
- 另两个入口：标签右键「批量重命名该标签…」、文件夹右键「批量重命名此文件夹…」
  （用户文件夹 = 映射子目录 + 手动加入的成员，导入文件夹 = 按路径前缀分页取，最多 500）
- 预览：调 `dry_run`，逐行标可改 / 失败（带后端原因）；空名、非法字符前端先拦
- 执行：两步确认（按钮变红「确认执行 N 个？」再点一次才动盘），成功后刷新列表与文件夹树
- 改动任意一行都会作废上次预览，必须重新预览才能执行；一次最多 500 行
- 代码：纯逻辑在 `assets/renderer/rename.js`（校验 / 变更计划 / 结果回写），
  弹窗与右键入口在 `index.html`（`showBatchRenameModal` / `showSoundContextMenu`）
- 没做的：改名历史 / 撤销、按「上次修改时间」等元数据生成名字

真后端验证过（不是只有单测）：dry_run 的四条路径（可改 / 非法字符 / 目标重复 / 文件不存在），
外加一条真实文件的「改名 → 改回」往返，磁盘、数据库行、FTS 都正确。

测试（本机没有全局 node，用 electron 当 node 跑）：

```powershell
$env:ELECTRON_RUN_AS_NODE='1'
.\node_modules\electron\dist\electron.exe tests\frontend\check_batch_rename.js
```

## 五、待办

| 优先级 | 项 |
|---|---|
| P1 | 拟音工坊试听面板移到右侧（三栏布局） |
| P2 | 各环境音细节区分度调参 |
| P2 | 描述包导入未匹配 CSV 导出 |
| P3 | `metadata/apply` 后自动重建文本索引 |

## 六、已知坑（踩过的）

- `main.js` 优先找打包后端；开发必须设 `SOUNDBOT_BACKEND_DEV=1`（dev.ps1 已含）
- **dev.ps1 两个坑（2026-10-24 修好）**：
  1. 脚本原是无 BOM 的 UTF-8，Windows PowerShell 5.1 按 GBK 读，中文注释会把**下一行吞进注释**，
     `$env:SOUNDBOT_BACKEND_DEV = '1'` 从来没执行过 → dev 模式悄悄跑 `dist\backend` 里的旧打包后端，
     新接口一律 404。现在存成 UTF-8 带 BOM，且环境变量放在所有中文注释之前。
  2. 脚本只杀 `EchoMind`/`soundbot-backend`，不杀 `electron.exe`：旧 dev 窗口占着单实例锁，
     新的启动直接退出，旧进程（没有 DEV 变量）又把打包后端拉回来。现在会顺带杀掉本仓库的 electron.exe。
  **自查**：`Get-NetTCPConnection -LocalPort 8000`，占端口的必须是 `.venv` 的 python.exe，
  出现 `soundbot-backend.exe` 就说明 dev 后端没生效（新接口会 404）。
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
- **别在请求里同步调度索引对账**：`_schedule_project_reconcile` 会先扫一遍 artifacts 表，
  放进保存接口里实测要 17.9 秒才回响应。统一走 `BackgroundTasks` + `_deferred_reconcile`。
- **标签有两套存储**：老的 `files.tags`（JSON，列表/搜索/向量都读它）和新的
  `tags`/`file_tags`（分层，侧栏与按标签筛选读它）。以前分层接口只写 file_tags，导致改完标签
  列表里看不到；现在分层写入会回写 `files.tags`（`sync_tags_from_layers`）。改标签/改名/删标签
  都会标脏这一行的 text_vector 并触发增量对账。反向（老接口写 files.tags）目前**不会**同步到 file_tags。

## 七、文档

- `docs/EchoMind-V6-更新说明.md/.docx`（面向用户）
- `docs/EchoMind-V6-安装指南.md/.docx`
- `CHANGELOG.md`、`docs/dev-status-2026-10-24.md`
