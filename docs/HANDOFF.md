# 交接文档（新会话从这里读）

更新：2026-10-24

## 一、项目位置与运行

```
E:\音效库管理软件\EchoMind\EchoMind-main     ← 代码
E:\音效库管理软件\EchoMind\EchoMind-main\dist-electron-v5\EchoMind测试版V10.zip  ← 最新安装包
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

## 一·三、导入性能与标签清理（2026-10-25 晚）

- 标签全部清空：3,994 个标签 / 236,155 条关联已删除，备份在
  `%APPDATA%\EchoMind\backups\tags-backup-20261025-201204.json`（28.5 MB）
- FTS 用 `ensure_fts` 整表重建（5.7 秒），比逐行 update_fts_row 快两个数量级
- SQLite 改 WAL：`PRAGMA journal_mode=WAL`，小事务提交从 6ms 降到 0.03ms
- 导入进度：候选阶段每 0.5 秒上报 processed/total；前端显示「正在登记文件 X/Y（Z%）」
- 导入提速：文件数 > `IMPORT_INLINE_INDEX_LIMIT`(500) 时跳过内联向量计算，
  标记 pending 后交给后台对账，实测 3.7 → 15.8 个/秒
- 注意：WAL 模式下备份数据库要先 `PRAGMA wal_checkpoint(TRUNCATE)`，否则 -wal 里的数据不在 .db 里

## 一·四、0.3.0-beta.11 新增（常用条 / 分轨）

- 顶栏：文件、导入、导入描述包、创造音效、拟音工坊、模型状态、索引状态（音频/文本两行）、设置
- 常用工具条（常驻、可＋/－自定义，存 localStorage）：重复检测、标签管理、转码、去人声、批量重命名、修复路径、修复索引
- 去人声：中置声道消除（`backend/core/vocals.py`），快但会削低频
- AI 分轨：Demucs（`backend/core/separation.py`），四轨 + 伴奏，PyAV 解码/写 WAV，不依赖外部 ffmpeg
- 全局帮助：任意元素挂 `data-help` + `help-dot` 即可显示说明气泡

## 一·五、库目录（2026-10-25 迁移后）

- 整合目标：`F:\CJ音效库整合包V1`（14 个一级 / 88 个二级，见 `docs/分类方案.md`）
- 已迁入：70,509 个文件 / 188.5 GB（大羽包 34,190 + 老库 36,318）
- 数据库 36,318 条记录的 path 已改到新库，标签/描述/哈希/向量保留（指纹只依赖 size+mtime）
- 迁移工具：`scripts/migrate_library.py`（--dry-run / --apply / --workers / --update-db）
- 完成通知：`scripts/notify-when-import-done.ps1`（等索引进度归零 → 写大羽标注 → 置顶弹窗）
- 大羽标注：`scripts/apply_dayu_annotations.py`（34,187 条描述 + 6 标签，按 sha256 匹配）

## 二、当前版本

- `0.3.0-beta.11`（测试版 V10），health 接口可验证
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
- 拟音工坊改成三栏：配方列表 / 触控板+配方 / 试听与录制（历史录音在右栏常驻）
- 应用内检查更新：⚙ 菜单 + 设置「关于与更新」，更新源在 Gitee（`main.js` 的 `UPDATE_FEED_URLS`）
- 新图标（E + 回声弧）：`build/icon.ico|icns|png` + `assets/audio-icon.png`
- 音效库目录支持 Shift/Ctrl 多选 + 右键批量删除（逐目录回报结果）
- 删目录时同时清「我的文件夹」映射，树立刻摘节点（不再残留空目录）
- 详情面板保存标签后左侧标签树立刻刷新
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

> 2026-10-26 更新：加「皮肤/MOD」需求；待归类进度同步。

### 功能

| 优先级 | 项 | 说明 |
|---|---|---|
| **P2** | **皮肤 / 主题包（MOD 式）** | 用户可自定义界面皮肤，像游戏打 MOD。见下方规格 |
| P2 | 标签预设模板 UI | 21 个受控标签（类型 / 场景 / 特性各 7），防止标签膨胀；后端数据已有，缺前端选择器 |
| P2 | 各环境音细节区分度调参 | 氛围混音（4 轨）主观听感调优 |
| P3 | 聚类审阅内置到应用里 | 目前是外部 HTML 试听页，理想是在应用内「待归类审阅」面板里试听+归类 |
| **P3** | **导航栏拓展位（暂定「广告位」）** | 顶栏右侧留白较多。候选方案见下方，待讨论后再定做哪个 |
| **P2** | **标签补全（缺失的补齐到 6 个）** | 现状：30,886 个文件 0 标签、872 个不足 6 个。见下方规格 |

### 皮肤 / 主题包（P2，未开工）

目标：像游戏 MOD 一样换皮，不改代码。

**包格式**（`skin/<皮肤名>/`）
```
theme.json      # 名称、作者、版本、适配的应用版本、颜色变量、可选自定义 CSS
preview.png     # 缩略图
assets/         # 背景图、图标替换（可选）
```

**theme.json 关键字段**
- `id` / `name` / `author` / `version` / `minAppVersion`
- `colors`: 覆盖现有的 CSS 变量（`--bg-primary`、`--bg-secondary`、`--bg-tertiary`、`--border-color`、`--text-*`、强调色）
- `css`: 可选，附加样式（**限制**：不允许 `@import` 外链、不允许 `url(http…)`，防远程资源）
- `assets`: 背景图 / 应用图标 / 波形配色

**交互**
- 设置 → 外观 → 皮肤列表（内置 + 用户导入），点选即预览，确认后应用
- 导入方式：拖入 zip 或选文件夹；解压到 `%APPDATA%\EchoMind\skins\<id>\`
- 应用失败（JSON 错、版本不符、缺资源）→ 自动回退默认皮肤并提示
- 「恢复默认」一键还原

**安全**
- 皮肤只允许改 CSS 变量 + 静态资源，**不执行任何脚本**
- 导入时校验路径穿越（`..`）、大小上限（如 50 MB）、文件类型白名单

### 标签补全（P2，未开工）

**现状（2026-10-26 统计）**

| 标签数 | 文件数 |
|---|---|
| 0 个 | 30,886 |
| 1–5 个 | 872（其中 5 个的 692） |
| 6 个（完整） | 33,288 |

来源：大羽描述包只覆盖了 39,356 个文件（每个 6 维标签），其余约 2.6 万是后导入的（.caf、补录、迁移修复出来的）。

**目标**：让每个文件都有 6 个标签，且标签必须来自受控词表（防膨胀）。

**三条可选路径**

| 方案 | 做法 | 优点 | 风险 |
|---|---|---|---|
| A 语义近邻继承 | 用已有文本向量找最相似的 20 个已标注文件，标签投票取前 6 | 零额外成本、十几分钟能跑完 | 会放大既有偏差；相似文件可能都错 |
| B 词表匹配 | 文件名 + 描述 → 匹配 21 个预设标签 + 88 分类词 | 可控、可解释 | 大量文件名无意义（一半以上会补不上） |
| C LLM 生成 | 用现有描述生成链路，**限制只能输出词表内标签** | 覆盖率最高 | 有成本、有幻觉风险、需要限流 |

**推荐顺序**：先 A（快、免费）看覆盖率 → 剩下的走 B → 还剩下的再考虑 C。

**必须有的约束**
- 只写受控词表内的标签；不在词表的一律丢弃
- 标签来源标记为 `auto`，界面上能和手动标签区分（建议淡色显示 + 悬停提示）
- 支持「一键撤销自动标签」，不影响原有手写标签
- 批量执行要有进度（已处理/总数/失败），失败写清单
- 不覆盖已有的 6 个标签

### 导航栏拓展位（P3，待讨论）

现状：顶栏 `回声 | 文件 导入 导入描述包 创造音效 拟音工坊 | … | 模型状态 · 索引状态 · 设置`
中间到右侧有一段空白，视觉上偏空。

候选方案（**未定**，等讨论）：

| 方案 | 内容 | 优点 | 风险 |
|---|---|---|---|
| A 广告位 | 轮播自家/合作素材商的 banner（如音效包、教程） | 可放推广、可变现 | 桌面软件里容易显得廉价；需联网；要能一键关闭 |
| B 公告位 | 新版本、活动、教程更新提醒 | 对用户有实用价值 | 需要内容运营 |
| C 快捷入口 | 把「重复检测 / 转码 / 分轨」等高频功能做成图标条 | 提升效率 | 与第二行「常用」条重复，需二选一 |
| D 状态小工具 | 显示索引进度条 + 磁盘剩余 + 当前库大小 | 有用信息 | 信息密度已高，易挤 |
| E 空着但加分隔 | 只加视觉分隔线 / 渐变，不塞内容 | 零风险 | 不解决"空"的观感 |

**若选广告位，约束先定好**：
- 必须可关闭（设置里一个开关，关掉后不留空位）
- 不允许弹窗式/遮挡式
- 离线不报错（网络失败静默隐藏）
- 不做第三方追踪；最多自家 CDN 计数

### 待归类进度（2026-10-26）

| 项 | 数量 |
|---|---|
| 库内总文件 | 65,046 |
| 已归类 | 54,625 |
| 仍待归类 | 10,421 |
| 其中：关键词已自动归类 | 4,298 |
| 其中：「提示音」组待试听定簇 | 1,817（10 簇，见下） |
| 其中：无任何文字线索 | 约 4,300 |

### 聚类结论（2026-10-26 凌晨，已试听验证）

试过两条路，都不足以批量执行：

1. **k-means 聚 10 簇**：簇不纯。实测簇 0 混了大象和猫，簇 7 混了转场扫频和 Windows 提示音，
   簇 6 是鸟叫+森林环境声。按簇搬会大面积出错。
2. **种子相似度扩展**（用已确认的代表音去圈相似文件）：
   - 阈值 0.90 只圈到 97 个（多数是同名副本）
   - 阈值 0.75 出现明显串类：「机械震翅」组里混进鞭打声/DJ 音效，
     「飞行后爆炸」组里混进拳法/掌法音效

**结论**：这两批文件（1,817「提示音」+ 约 8,600 无文字线索）不适合继续自动归类。
已保留在原地，靠标签 + 语义搜索使用即可。已自动归的 4,298 个保留（抽查准确率约九成）。

**如果以后还要做**：方向是「应用内置试听 + 单条一键归类」面板（已记为 P3），
不做批量猜测。脚本保留：`cluster_group.py`（聚类）、`seed_similarity.py`（种子相似）、
`build_review_page.py`（生成 http 可听的试听页）

### 已完成（曾经列在这里）

| 项 | 实现位置 |
|---|---|
| 目录树跟随磁盘同步 | `GET /api/v1/db/library/folder-health` + 左侧「同步」按钮 |
| 标签批量操作 | `/api/v1/tags/rename|delete|merge` |
| 音频格式转码 / 去人声 / AI 分轨 | 常用条三个按钮 |
| 损坏文件扫描 | `/api/v1/transcode/scan-broken` |
| 描述包未匹配 CSV | 描述包预览里的「导出未匹配清单」 |
| metadata/apply 后重建文本索引 | apply 后调度 reconcile |
| 关键词自动归类（方案 A） | `scripts/keyword_classify.py`，88 分类 686 关键词 |
| 分组批准（方案 B） | `scripts/group_approval.py` + `apply_groups.py` |

## 六、已知坑（踩过的）

- **「损坏文件」的判定**：file_artifacts 里 kind='waveform' 且 state='failed' 的文件，
  错误码 waveform_decode_failed（后端解码音频画波形失败）。常见原因是文件本身截断/损坏、
  编码不被 PyAV 支持、或被其他程序独占。清理只删库记录，不动磁盘文件。

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
  都会标脏这一行的 text_vector 并触发增量对账。反向也补上了：老接口写完 files.tags 会调
  `sync_layers_from_files_tags` 同步到 tags/file_tags（单文件 / 批量 / 标签改名 / 标签删除四条路径）。

## 八、发版与检查更新

发一版只需要四步：

1. 改版本号（`package.json` + `backend/config.py` 的 `APP_VERSION`，两处必须一致）
2. 打包（见「打包发版」）→ 上传 zip 到百度网盘 → 拿到分享链接
3. 改 Gitee 仓库里的 `update.json`（模板在本仓库根目录）：

   ```json
   { "version": "0.3.0-beta.11", "released_at": "2026-10-25",
     "notes": "第一行\n第二行", "url": "https://pan.baidu.com/s/…?pwd=73ca", "code": "73ca" }
   ```

4. 软件里「设置 → 关于与更新 → 检查更新」立刻能看到；启动时也会静默查一次（24 小时节流）

细节：

- 更新源在 `main.js` 的 `UPDATE_FEED_URLS`，第一项是 Gitee（**要把占位符换成你的真实仓库路径**），
  第二项是 jsDelivr 的 GitHub 镜像（兜底）。两个都失败就静默跳过，不弹错误。
- 用户全程不需要 GitHub、不需要代理。
- 目前只做「检查 + 引导下载」（打开网盘链接 / 复制提取码），不做全自动安装：
  包 3.3 GB，自动更新需要对象存储直链 + 分段续传，等包瘦身（把 2.8 GB 的 CUDA 运行时拆出去）再说。
- 版本比较与 feed 解析在 `lib/update-feed.js`，测试是 `node tests/frontend/check_update_feed.js`。


## 七、文档

- `docs/EchoMind-V6-更新说明.md/.docx`（面向用户）
- `docs/EchoMind-V6-安装指南.md/.docx`
- `CHANGELOG.md`、`docs/dev-status-2026-10-24.md`
