# Changelog / 更新日志

All notable changes to SoundBot are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses [Semantic Versioning](https://semver.org/). / 本文件记录 SoundBot 的重要变更，格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循[语义化版本](https://semver.org/lang/zh-CN/)。

## [0.3.0-beta.10] - 2026-10-24

> 测试版 V10。这一版把所有 UI 修复和「应用内检查更新」都打进来了。

### Added / 新增

- **「我的文件夹」移出**：在「常用」这类自定义文件夹视图里，右键单条或多选都会出现
  「从「文件夹名」移出」，只取消归类、不动磁盘文件；删完列表和左侧计数即时刷新。
  成员如果来自目录映射（不是手动加入的），会提示需要先在文件夹右键里解除映射。
- **左侧「全部音效」**：进了某个自定义文件夹之后，也能一键回到整个库（不再只能在两个源目录之间二选一）；
  它排在源目录板块最上面并显示总数
- **源目录板块**：原来的「未分类」改名为「音效库目录 · 名称不可改」，明确提示这些目录来自磁盘、名字不能改；
  板块标题右侧新增搜索按钮，点开即可只在这个板块里筛文件夹（顶部「搜索文件夹」照旧可用）
- **收藏可以取消**：再点一次「★ 收藏」回到全部音效；切到文件夹 / 标签 / 搜索 / 全部音效时，
  收藏的高亮和它的列表会自动退出
- **右侧「详情」面板**：工具栏视图切换后面新增「详情」按钮，点开在右侧显示选中音效的
  标签（可直接改，逗号分隔保存）、一句话描述（可直接改）和格式 / 时长 / 采样率 / 声道 / 大小 / 来源；
  再点一次收起，选中别的音效时面板内容跟着换。改描述会写库、同步 FTS 并把这行文本向量标脏，
  然后自动调度一次**增量**向量对账（只重算 stale 的那几条，不是全库 48648 条重建）
- **详情面板可直接改文件名**：两步确认后调用重命名接口，磁盘上的源文件同步改名，
  列表与详情立即刷新（文件名变了也会重算这一条文本向量）
- **保存反馈就地显示**：描述 / 标签 / 文件名三个保存按钮点下去立刻变「保存中…」，
  成功后变绿色「✓ 已保存」（2 秒复原），失败变红「保存失败，再点重试」并回滚界面；
  描述和标签都是先更新界面再等接口，不再等几秒才看到变化
- **修好了保存卡 10 秒**：保存接口原来在请求里同步调度索引对账（要扫 4.8 万行），
  实测响应 17.9 秒；现在改成 `BackgroundTasks` 在响应发出后再调度，接口 <300ms 返回；
  连打三次实测 317ms / 318ms / 1804ms（对账会合并成一次，不再互相顶住）
- **详情面板保存标签后，左侧标签树立刻刷新**：标签只有一套（`tags`/`file_tags`），
  侧栏和详情面板读写的是同一张表，但保存后原来不会重新拉取，看起来像"没生效"。
- **删文件夹后树里还留着旧目录修好了**：以前只有拿到非空目录列表才重画树，删完刚好变空（或请求失败）
  时旧节点会一直留着。现在删成功先本地摘掉节点（含子目录，立刻可见），再拉取刷新；
  目录统计返回空列表时也会清空树，不再提前 return。
- **导入进度弹窗的「取消」修好了**：以前只有任务 ID 和 WebSocket 都就绪时才发取消消息，
  而弹窗是在拿到任务 ID 之前就弹出来的，所以经常点了没反应。现在点下去立刻变「正在取消…」，
  能发就发取消、发不了就等任务 ID 回来补发，弹窗一定收起。
- **音效库目录支持多选批量删除**：按住 Shift 连选、Ctrl 点选多个文件夹，右键出现
  「批量删除这 N 个文件夹…」，一次选「只删记录」或「连源文件删（回收站）」，删完统一刷新。
- **标签双向同步**：老的标签入口（右键「添加/编辑标签」、批量打标签、标签改名/删除）写入
  `files.tags` 之后，会同步到 `tags`/`file_tags`——以前用老入口打的标签在左侧标签树里看不到。
  加上之前做过的反方向同步，现在两套存储不会各看各的（`sync_layers_from_files_tags`，带单测）。
- **拟音工坊改成三栏**：左「配方列表」/ 中「触控板 + 声音配方 + 声音变化」/ 右「试听与录制」。
  录制、试听、保存、历史录音都挪到右栏常驻（没录音时显示「还没有录音」，不再整块消失）；
  录音条目改成两行排版（名字在上、试听/保存/复制路径三个按钮在下），288px 宽也不挤。
  触控板宽度改成自适应，窄窗口不会撑破中栏。
- **改标签 / 标签改名 / 删标签同样会更新语义索引**：分层标签（tags/file_tags）写入后会
  回写到 `files.tags`（以前只写 file_tags，列表和搜索都看不到），并标脏文本向量、触发增量重建
- **左侧两个搜索框分家**：顶部「搜索文件夹」只筛「我的文件夹」，源目录板块标题旁的搜索只筛
  「音效库目录」；板块搜索框修好了中文输入（输入法合成期间不重建 DOM），并加了 200ms 防抖

## [Unreleased] / 未发布

### Added / 新增

- **哈希补算可按需触发**：以前 sha256 只在启动时补算一次就跑完退出，导入的新文件（或从回收站还原后重新导入的）
  永远拿不到哈希，重复检测自然查不到它们。现在导入完成会自动触发补算，重复检测弹窗也会提示
  「还有 N 个文件没算哈希」并支持一键计算（带进度，算完自动重新检测）。
- **重复音效检测：备份改成"复制"+ 可撤回**：备份不再剪切原文件，而是复制到指定目录并写一份清单
  （`%APPDATA%\EchoMind\duplicate-backups\manifests\*.json`）；听完确认后可以「删除这些副本」，
  或者「撤回备份」按清单把文件还原回**原来的目录**。
- **重复音效检测支持三种处理方式**：每组可「只删库记录」「删源文件（回收站）」「移到备份文件夹」，
  底部还能对全部组一键执行。判定重复用 sha256（字节级一致），删哪一份都不丢内容。
- **目录树按根分组建层级**：以前只给"文件最多的那个根"建层级，其他根（比如 F 盘大羽包）被压成
  根级平铺，只显示最后一级目录名 —— 于是「单次」「短尾」「连续」这种同名目录看起来一模一样，
  删掉其中一个、别的同名目录还在，就像"删了没生效"。现在每个根各自建树，同名目录挂在不同父目录下。
- **匿名使用统计**（默认开启，设置里可关）：每次启动只上报「启动次数 / 当天启动 / 版本 / 平台 / 首次安装」
  几个计数，不含安装 ID、路径、文件名、标签、描述等任何个人信息。
  数据用第三方免费计数器，挂了就静默跳过，不影响使用。

## [0.3.0-beta.9] - 2026-10-24 (Prerelease / 预发布)

测试版 V9。批量重命名全链路（预览 / 批量规则 / 多入口），顺带修掉开发模式的隐藏坑。

### Added / 新增

- **批量重命名（前端界面）**：多选音效后右键「批量重命名… (N)」
  - 弹窗三列：原名 / 新名（可编辑）/ 状态，附「全部还原」
  - 「预览」走后端 `dry_run`，逐行标出可改 / 失败及原因（如目标文件已存在）
  - 「执行」两步确认（按钮变红「确认执行 N 个？」再点一次才动磁盘），完成后刷新列表与文件夹树
  - 规则栏：前缀 / 后缀 / 查找替换（可切正则、支持 $1 分组）/ 大小写（小写、大写、首字母大写）/
    自动编号（起始、位数、分隔符），「应用到全部」按原名重算（重复应用不会叠加），
    查找替换与大小写只动主名不动扩展名；正则写错只提示不改名
  - 空文件名、非法字符前端先拦；改动任意一行会自动作废上一次预览
  - 一次最多 500 行，超出部分不会进入本次批处理
- **批量重命名入口**：除多选右键外，标签右键「批量重命名该标签…」、
  文件夹右键「批量重命名此文件夹…」也能整批打开弹窗

### Fixed / 修复

- **dev.ps1 静默跑旧后端**：脚本是无 BOM 的 UTF-8，Windows PowerShell 5.1 按 GBK 读取，
  中文注释把下一行的 `$env:SOUNDBOT_BACKEND_DEV = '1'` 吞进注释，开发模式一直在用
  `dist\backend` 里的旧打包后端，新接口全部 404。已改为 UTF-8 带 BOM 且环境变量前置。
- **dev.ps1 留下旧实例**：只杀 `EchoMind`/`soundbot-backend` 不杀 `electron.exe`，
  旧窗口占着单实例锁，新启动瞬间退出、旧进程又把打包后端拉回来。现会一并清掉本仓库的 electron.exe。
- **林间鸟鸣整条链路静音**：`/api/v1/temp-audio/stems/{name}` 的白名单写死成
  `wind|rain|sea|fire`，漏了 `forest`。四条音轨正常合成、也正常落盘，请求却被 400 拒掉；
  前端 `new Audio(url).play().catch(() => {})` 把 rejection 吞了，于是「音频有内容但完全没声音」。
  现在白名单以 `STEM_MIX` 为准（新增环境音种类不会再漏），`forest` 也进了启动预热。

## [0.3.0-beta.8] - 2026-10-24 (Prerelease / 预发布)

测试版 V8。补两条音效库的日常管理能力。

### Added / 新增

- **排序**：列表顶部下拉，可按文件名 / 时长 / 体积 / 导入时间正反排序
- **来源标记**：区分 AI 生成与用户导入，并可按住来源筛选

## [0.3.0-beta.7] - 2026-10-24 (Prerelease / 预发布)

测试版 V7。借用大羽音效库的两个高频功能。

### Added / 新增

- **收藏（星标）**：列表行和卡片上都有 ★，点击即收藏
  - 左侧新增「收藏」入口并显示数量，点开即筛选
- **重复音效检测**：设置 → 工具 → 重复音效检测
  - 按 sha256 内容哈希分组，显示组数 / 文件数 / 浪费空间
  - 每组可「只保留第一个，删除其余库记录」（不动磁盘文件）

### Changed / 变更

- 文件列表接口返回 `is_favorite` 字段

## [0.3.0-beta.6] - 2026-10-24 (Prerelease / 预发布)

测试版 V6。本版本完成标签双层与中文语义检索改造。

### Added / 新增

- **标签双层（M4）**：场景（scene，互斥）/ 属性（attr，多选）两套体系
  - 新表 `tags` / `file_tags`，启动时自动迁移旧 `files.tags`
  - 5 个接口：分组查询 / 新建 / 改名改层 / 删除 / 设置文件标签
  - 侧栏按场景、属性分组显示；标签右键可改层、可删除
  - 音效右键「设置标签…」：场景单选 + 属性多选，支持批量
  - 点击标签按后端过滤；搜索框支持 `tag:标签名`
- **中文语义检索（P3）**：本地 BGE 文本向量（bge-small-zh，512 维）
  - 重建 48,648 条文本向量（GPU，1.6 分钟）
  - 长句走语义检索，短关键词走 FTS5 快通道
  - 安装包内置模型（约 92MB），离线可用
  - 可选更强模型：`ECHOMIND_EMBED_MODEL=bge-m3`
- 拟音工坊：环境音改为四音轨常驻播放，拖动只改音量（消除断层）
- 右键「添加到文件夹」、文件夹右键删除（可选是否删除源文件）

### Changed / 变更

- 搜索框移到主列表顶部，回车触发；新增列表 / 卡片视图切换
- 长句搜索：**14.8s → 0.29s**；短关键词：**13s → 0.05s**
- 顶部「创造音效 / 拟音工坊」改为毛玻璃科技风按钮

### Fixed / 修复

- Chroma 客户端冲突导致语义检索静默回退 CLAP
- 搜索接口因 metadata 缺 `file_id` 报 500
- FTS 快通道 limit 误传，短词查询永远走慢路径
- 设置菜单被导航栏裁切打不开
- 用户文件夹计数不含手动加入的音效

## [0.3.0-beta.5] - 2026-10-22 (Prerelease / 预发布)

测试版 V5。本版本集中修复索引稳定性、检索排序与启动体验。

### Added / 新增

- Added portable description packs (export/import) that match by path relative to the library root, so one machine's AI descriptions can be reused after moving the library to another drive or machine; importing triggers a text-index rebuild automatically. / 新增可移植的一句话描述包（导出/导入），按「相对音效库根目录的路径」匹配，换盘换机后可复用已生成的描述；导入后自动重建文本索引。
- Added drag-and-drop import for folders and audio files, with a path-classification IPC in the main process. / 新增拖拽文件夹/音频文件导入，主进程提供路径类型识别。
- Added infinite scrolling for folder listings backed by a new `folder` filter on `GET /api/v1/files`. / 新增文件夹列表滚动分页，后端 `GET /api/v1/files` 支持 `folder` 前缀过滤。

### Fixed / 修复

- Fixed the packaged mel worker being started as a second HTTP server, which made every audio embedding fail (15,226 false failures). / 修复打包后 mel worker 被当成第二个 HTTP 服务启动、导致音频向量全部编码失败（15,226 条假失败）。
- Fixed the poison-file blacklist living in the session directory and permanently skipping healthy files; it now lives in user data, requires two strikes, expires after 3 days and is capped. / 修复毒文件黑名单写在会话目录并永久跳过正常文件的问题：改为用户数据目录、连续失败 2 次才拉黑、3 天过期并限制条目数。
- Fixed the searcher being rebuilt on every request (7–13 s each) by caching per project and collection, and by serializing the startup warm-up. / 修复每次搜索重建检索器（每次 7~13 秒）的问题：按工程与集合缓存，并让启动预热串行化。
- Fixed expanded dictionary synonyms being scored as high as the original query, which ranked unrelated files (e.g. DRIP.wav) above real matches. / 修复词典扩展词拿到与原查询同等高分、把无关文件排到首位的问题。
- Fixed the query cache never hitting (per-instance cache keyed by text revision) and the keyword layer re-parsing every file. / 修复查询缓存永不命中、关键词层逐文件重复解析的问题。
- Fixed folders whose listing was empty because it filtered only the paginated in-memory subset. / 修复点击大目录列表为空（只过滤本地分页数据）的问题。
- Fixed the user-configured LLM provider being overwritten by the bundled Ark configuration on every backend start. / 修复每次后端启动都会用内置方舟配置覆盖用户 LLM 设置的问题。
- Fixed reasoning-model output being stored as descriptions when `content` was empty. / 修复推理模型 content 为空时把思考过程写入描述的问题。

### Changed / 变更

- Split search into a fast keyword channel (60–300 ms) and a background semantic supplement that appends instead of replacing results. / 搜索拆为快速关键词通道（60~300 毫秒）与后台语义补充，语义结果只追加不替换。
- Added a local Chinese→English lexicon for CLAP text queries, and warmed Chroma with a real query at startup. / 新增中文→英文本地词典供 CLAP 文本检索使用，并在启动时用真实查询预热 Chroma。

## [0.2.1-beta.3] - 2026-08-14 (Prerelease / 预发布)

### Added / 新增

- Added a product-styled local startup window that waits for the production preload handshake and required backend audio capability before showing the main UI, preserves an actionable failure state, and avoids a mismatched system-console experience. / 新增与产品风格一致的本地启动窗口，仅在生产 preload 握手与必需的后端音频能力通过后显示主界面；启动失败会保留可操作的错误状态，避免出现风格割裂的系统控制台体验。
- Added persistent, size-rotated Electron main-process diagnostics for startup, preload, IPC, and frozen-backend output, with common credential forms redacted and a minimal IPC action for opening the actual log directory. / 新增 Electron 主进程持久诊断日志，覆盖启动、preload、IPC 与冻结后端输出，支持按大小轮换、常见凭据遮盖，并提供最小权限 IPC 操作打开实际日志目录。
- Added `GET /api/v1/runtime/capabilities` and extended health responses so a missing PyAV/FFmpeg runtime reports a path-free degraded capability instead of presenting an incomplete frozen backend as healthy. / 新增 `GET /api/v1/runtime/capabilities` 并扩展健康响应，使 PyAV/FFmpeg 运行时缺失时返回不含本地路径的降级能力，而不是把不完整的冻结后端误报为健康。

### Changed / 变更

- Windows and macOS v0.2.1-beta.3 installers embed the single configured CLAP model revision, its per-file SHA-256 manifest, and full Apache-2.0 source/license notice. Ordinary users no longer download `models.zip`; that exact-version archive remains a repair/build/development asset, and an explicit `SOUNDBOT_MODELS_PATH` is authoritative without silent fallback. / Windows 与 macOS v0.2.1-beta.3 安装包会内置唯一配置中固定 revision 的 CLAP 模型、逐文件 SHA-256 manifest 与完整 Apache-2.0 来源/许可说明。普通用户无需另行下载 `models.zip`；该精确版本压缩包仅作为修复、构建与开发资源，显式 `SOUNDBOT_MODELS_PATH` 为权威配置且不会静默回退。
- Release packaging now regenerates and verifies the pinned model before Electron packaging, repeats model identity, notice, and every manifest hash check inside the final application, loads the packaged macOS model offline, rejects any of the five release assets at or above 2 GiB, and performs a real silent NSIS installation under a path containing spaces and Chinese characters. / 发布打包现在会在 Electron 打包前重新生成并校验固定模型，在最终应用内再次核对模型身份、许可说明与 manifest 中每个文件哈希，以离线模式加载 macOS 应用内模型，拒绝五个 Release 资产中任何达到或超过 2 GiB 的文件，并在包含空格与中文的路径执行真实 NSIS 静默安装。
- Expanded the mirrored Chinese and English acknowledgments to distinguish AI development collaborators—including OpenAI Codex, Kimi, and Anthropic Claude—from the verified runtime, indexing, audio, UI, and release technology stack. / 扩充中英文镜像致谢，明确区分 OpenAI Codex、Kimi、Anthropic Claude 等 AI 开发协作工具与经仓库核实的运行时、索引、音频、界面及发布技术栈。
- Replaced the incomplete custom license summary with the official GNU GPLv3 text, aligned package metadata to `GPL-3.0-or-later`, and tightened the bilingual project presentation without changing the established README layout. / 使用 GNU GPLv3 官方全文替换不完整的自定义许可证摘要，将软件包元数据统一为 `GPL-3.0-or-later`，并在保持既有 README 排版的前提下完善双语项目介绍。
- Documented SoundBot as a public source and release mirror that does not accept external issues, pull requests, discussions, projects, support requests, private reports, code, or data submissions; removed the public support email from repository and release guidance. / 明确 SoundBot 是不接收外部 Issue、Pull Request、Discussion、Project、支持请求、私密报告、代码或数据提交的公开源码与发布镜像，并从仓库及发布说明中移除公开支持邮箱。

### Fixed / 修复

- Fixed Windows release helpers failing during Python interpreter shutdown: both the canonical build script and its imported model-download verifier now reconfigure existing `sys.stdout` and `sys.stderr` streams in place and never wrap their shared buffers, preventing `ValueError: write to closed file` after successful verification. / 修复 Windows 发布辅助程序在 Python 解释器退出阶段失败的问题：统一构建脚本及其导入的模型下载验证器现在都只原地重新配置现有 `sys.stdout` 与 `sys.stderr`，不再包装其共享 buffer，避免校验成功后触发 `ValueError: write to closed file`。
- Fixed cross-platform model-notice verification by pinning the controlled Apache-2.0 notice to LF in Git, preventing Windows checkout conversion from changing the byte-for-byte manifest input while retaining strict SHA-256 validation. / 通过在 Git 中将受控 Apache-2.0 说明固定为 LF，修复跨平台模型说明校验；避免 Windows 检出时转换换行导致逐字节 manifest 输入变化，同时继续保留严格 SHA-256 校验。
- Fixed the packaged Electron bridge disappearing on Windows because sandboxed preload code attempted a top-level local JSON `require`, which Electron does not expose in a sandbox preload. The preload now imports only Electron's supported API, obtains the shared audio capability table through IPC, signals a ready handshake, and causes startup to fail visibly on `preload-error` instead of opening a partly functional renderer. / 修复 Windows 打包版 Electron bridge 整体消失的问题：根因是沙箱化 preload 在顶层 `require` 本地 JSON，而 Electron 沙箱 preload 不提供该能力。preload 现在只导入 Electron 支持的 API，通过 IPC 获取共享音频能力表并发送就绪握手；发生 `preload-error` 时启动会明确失败，不再打开功能残缺的渲染界面。
- Fixed installed file import falling back to a browser picker without absolute paths, folder import returning before a native dialog could open, and import progress depending on a live WebSocket. Both native pickers now run through the production bridge with an immutable explicit project ID, while durable job polling remains available if the socket is unavailable. / 修复安装版文件导入回退到无法提供绝对路径的浏览器选择器、文件夹导入在原生窗口打开前直接返回，以及导入进度依赖实时 WebSocket 的问题。两个原生选择器现在都通过生产 bridge 运行并携带不可变的显式工程 ID；socket 不可用时仍可轮询持久化作业。
- Fixed the same preload failure being misreported as “waveform unavailable.” Waveform requests now use the verified production bridge, reject empty/non-finite data, and surface loading, retryable failure, and cancellation states instead of masking IPC errors. / 修复同一 preload 故障被误报为“波形不可用”的问题。波形请求现在使用经过验证的生产 bridge，拒绝空数组与非有限数据，并明确呈现加载、可重试失败与取消状态，不再掩盖 IPC 错误。
- Made frozen-backend child-process creation explicitly hidden on Windows while retaining the authoritative `BOUND_PORT` startup handshake and persistent diagnostic capture. / 将 Windows 上的冻结后端子进程显式设为隐藏创建，同时保留权威的 `BOUND_PORT` 启动握手与持久诊断捕获。
- Expanded the Windows installed-state release gate beyond archive inspection: CI now launches the NSIS-installed Electron application, proves both real native pickers appear, imports WAV and WMA through production IPC, checks SQLite plus three exact 2,000-point waveforms and WMA playback transcoding, then requires bundled CLAP preload, both indexes, and semantic search. / 将 Windows 安装态发布门禁从压缩包检查扩展为真实功能验证：CI 现在启动由 NSIS 安装的 Electron 应用，证明两个真实原生选择器均会弹出，经生产 IPC 导入 WAV 与 WMA，检查 SQLite、三份精确 2,000 点波形及 WMA 播放转码，并要求内置 CLAP 预加载、双索引与语义搜索全部通过。

### Removed / 移除

- Removed tracked macOS metadata, an empty user-specific runtime configuration, an obsolete one-off copyright script, and an unused audio-import test stub from the public source tree. Local user files remain ignored and are not deleted. / 从公开源码树移除已跟踪的 macOS 元数据、空的用户运行时配置、过时的一次性版权脚本与无用音频导入测试说明；本地用户文件仅被忽略，不会被删除。

### Security / 安全

- Added repository-hygiene CI gates that reject ignored runtime files, databases, temporary audio, user configuration, and non-empty default API keys; expanded ignore rules to prevent these artifacts from being committed again without hiding `backend/models` source files. / 新增仓库卫生 CI 门禁，拒绝被忽略的运行时文件、数据库、临时音频、用户配置与非空默认 API 密钥；同时扩充忽略规则以防止这些内容再次提交，并避免误隐藏 `backend/models` 源码。
- Added a reusable current-tree privacy scanner for credentials, private keys, credential-bearing URLs, personal absolute paths, sensitive JSON fields, and runtime artifacts, and made both main validation and tag releases run it before testing or packaging. / 新增可复用的当前源码树隐私扫描器，检查凭据、私钥、带认证信息的 URL、个人绝对路径、敏感 JSON 字段与运行时产物，并要求 main 验证及标签发布都在测试或打包前执行。

## [0.2.1-beta.2] - 2026-08-14 (Unpublished build tag / 未发布构建标签)

### Build status / 构建状态

- No GitHub Release was published from this immutable tag. The LF-pinned model-notice fix worked and the Windows build passed that gate, but the canonical build helper and its imported download verifier both replaced process-owned console streams with wrappers over shared buffers. During Python interpreter shutdown a duplicate wrapper attempted to flush an already closed stream and raised `ValueError: write to closed file`. The Windows job therefore failed and release creation was skipped; both helpers use in-place stream reconfiguration in v0.2.1-beta.3. / 该不可变标签未发布 GitHub Release。模型说明固定 LF 的修复已经生效，Windows 构建也通过了该门禁，但统一构建辅助程序及其导入的下载验证器都用共享 buffer 包装器替换了进程拥有的控制台流；Python 解释器退出时重复包装器尝试刷新已经关闭的流，触发 `ValueError: write to closed file`。因此 Windows 作业失败且未创建 Release；v0.2.1-beta.3 已让两个辅助程序都改用原地流配置。

## [0.2.1-beta.1] - 2026-08-14 (Unpublished build tag / 未发布构建标签)

### Build status / 构建状态

- No GitHub Release was published from this immutable tag. Its strict Windows model-notice gate exposed a checkout-only LF-to-CRLF conversion before packaging; release creation was skipped, and the cross-platform fix is included in v0.2.1-beta.2. / 该不可变标签未发布 GitHub Release。严格的 Windows 模型说明门禁在打包前发现仅发生于检出阶段的 LF 到 CRLF 转换，因此发布创建被跳过；跨平台修复已纳入 v0.2.1-beta.2。

## [0.2.0] - 2026-08-12 (Prerelease / 预发布)

### Added / 新增

- Added versioned SQLite schema v3 migration with one immutable pre-migration snapshot, transactional rollback, integrity checking, incremental v2 artifact preservation, and safe merging of POSIX physical-path aliases. / 新增版本化 SQLite v3 迁移，包含一次性不可变迁移前快照、事务回滚、完整性检查、v2 artifact 增量保留，以及 POSIX 物理路径别名的安全合并。
- Added project-scoped file UUIDs, Windows-aware canonical path keys, source fingerprints, and safe legacy project-ID mapping. / 新增工程内文件 UUID、Windows 感知的规范化路径键、源文件指纹与安全的旧工程 ID 映射。
- Added durable `file_artifacts`, `index_manifests`, and `jobs` tables to track waveform, audio-vector, and text-vector state as `pending`, `processing`, `ready`, `failed`, or `stale`, including engine fingerprints and last errors. / 新增持久化 `file_artifacts`、`index_manifests` 与 `jobs` 表，分别以 `pending`、`processing`、`ready`、`failed`、`stale` 跟踪波形、音频向量和文本向量，并记录引擎指纹与最后错误。
- Added a unified audio capability table for WAV, MP3, FLAC, AIFF, AIF, OGG, M4A, AAC, and WMA across the picker, scanner, decoder, waveform service, indexer, and documentation. / 新增统一音频能力表，在选择器、扫描器、解码器、波形服务、索引器与文档中共同支持 WAV、MP3、FLAC、AIFF、AIF、OGG、M4A、AAC 和 WMA。
- Added a pinned PyAV decoder with wheel-bundled FFmpeg libraries and explicit PyInstaller collection of native libraries and third-party license notices. / 新增固定版本 PyAV 解码器及 wheel 内置 FFmpeg 动态库，并由 PyInstaller 显式收集原生库与第三方许可证说明。
- Added deterministic, bounded-memory waveform generation that always returns exactly 2,000 finite non-negative peaks in `[0,1]`, invalidated by size, `mtime_ns`, and waveform version. / 新增确定性、有界内存的波形生成，固定返回 2,000 个位于 `[0,1]` 的有限非负峰值，并按文件大小、`mtime_ns` 与波形版本自动失效。
- Added explicit waveform loading, cancellation, failure-reason, and retry states, plus DPR-aware Canvas sizing, `ResizeObserver`, and offscreen static waveform layers. / 新增明确的波形加载、取消、失败原因与重试状态，以及高 DPI Canvas、`ResizeObserver` 和离屏静态波形图层。
- Added fingerprinted, size-limited LRU playback-WAV generation for containers Chromium cannot reliably play directly. / 新增带源文件指纹、容量限制和 LRU 清理的播放 WAV，为 Chromium 无法可靠直放的容器提供回退。
- Added separate cosine Chroma collections for CLAP audio embeddings and text-metadata embeddings generated from filenames, logical folders, tags, UCS categories, and descriptions. / 新增相互独立的 cosine Chroma collection，分别存放 CLAP 音频向量与由文件名、逻辑目录、标签、UCS 分类和描述生成的文本元数据向量。
- Added CLAP text embeddings by default and LM Studio, Ollama, or OpenAI-compatible alternatives for the text-metadata branch only. / 文本元数据分支新增默认 CLAP 文本编码器，并支持 LM Studio、Ollama 或 OpenAI-compatible 替代方案。
- Added project-level index status, non-destructive reconciliation, and verified shadow-collection rebuild APIs and UI controls. / 新增工程级索引状态、非破坏性修复以及经过验证的影子 collection 重建 API 与界面控制。
- Added atomic activation of verified shadow manifests so failed or cancelled rebuilds retain the previous searchable collections. / 新增已验证影子 manifest 的原子激活，重建失败或取消时继续保留原有可搜索 collection。
- Added cursor-paginated metadata-only file listing, per-file and batch waveform endpoints, project-explicit import jobs, persistent job status, and cancellation APIs. / 新增游标分页的纯元数据文件列表、单文件与批量波形接口、显式工程导入作业、持久化作业状态及取消 API。
- Added per-result `audio_score`, `text_score`, `keyword_score`, and effective branch weights for explainable hybrid ranking. / 新增每条结果的 `audio_score`、`text_score`、`keyword_score` 与实际分支权重，使混合排序可诊断。
- Added asynchronous LLM support for LM Studio, Ollama, OpenAI, Kimi, DeepSeek, SiliconFlow, and custom OpenAI-compatible endpoints, including streaming, cancellation, timeouts, and bounded retries. / 新增 LM Studio、Ollama、OpenAI、Kimi、DeepSeek、SiliconFlow 与自定义 OpenAI-compatible 端点的异步 LLM 支持，包含流式响应、取消、超时和有限重试。
- Added OS-backed Electron `safeStorage` credential persistence with explicit `keep`, `set`, and `clear` intent and in-memory-only backend hydration. / 新增基于操作系统的 Electron `safeStorage` 凭据持久化，通过明确的 `keep`、`set`、`clear` 意图操作，并仅在后端内存中注入密钥。
- Added atomic migration of legacy plaintext AI keys into secure storage, with secure-store precedence, rollback, and original-file preservation on failure. / 新增旧版明文 AI 密钥到安全存储的原子迁移，遵循安全存储值优先，并在失败时回滚且保留原文件。
- Added committed audio fixtures for every supported extension and Windows path cases containing spaces, Chinese characters, `%`, `_`, `#`, `+`, and parentheses. / 新增覆盖全部支持扩展名的音频样本，以及包含空格、中文、`%`、`_`、`#`、`+` 和括号的 Windows 路径样例。
- Added migration, artifact-state, path, waveform, cosine ranking, cache invalidation, project isolation, LLM/Embedding mock, secret-storage, renderer-contract, and frozen-runtime tests. / 新增迁移、artifact 状态、路径、波形、cosine 排序、缓存失效、工程隔离、LLM/Embedding 模拟、密钥存储、渲染层契约和冻结运行时测试。
- Added complete Chinese and English README mirrors and synchronized bilingual release notes. / 新增完整的中英文 README 镜像与同步的双语发布说明。

### Changed / 变更

- Hardened GitHub release automation by allowing only pushed annotated `v*` tags to trigger it, binding every job to that tag commit, pinning official Actions to immutable SHAs, building both platforms through the same native-host script, separating model-free and CLAP-ready smoke gates, publishing only after draft asset verification, and adding checksums plus provenance attestations. / 加固 GitHub 发布自动化：仅允许推送 annotated `v*` tag 触发，所有作业绑定该 tag 的同一提交，官方 Actions 固定到不可变 SHA，双平台统一使用原生宿主构建脚本，拆分无模型与 CLAP 就绪冒烟门禁，仅在草稿资产核验后发布，并新增全资产校验和与 provenance 证明。
- Added an atomic version-bump command, strict release-channel/tag validation, exact-version model downloads, complete model-manifest verification, and official npm registry locks to keep future version updates and uploads reproducible. / 新增原子版本升级命令、严格发布渠道/tag 校验、精确版本模型下载、完整模型 manifest 验证与官方 npm registry 锁定，使后续版本更新和上传可复现。
- SQLite is now the single source of truth; files are persisted before waveform or vector work begins, and a failed artifact remains retryable instead of being counted as indexed. / SQLite 现在是唯一真相源；文件先持久化再生成波形或向量，失败 artifact 保持可重试而不再计为已索引。
- Import, repair, rebuild, search, AI chat, and cache state now carry an explicit immutable `project_id` and index revision to prevent cross-project leakage during project switches. / 导入、修复、重建、搜索、AI 对话和缓存状态现在携带显式且不可变的 `project_id` 与索引 revision，防止切换工程期间串库。
- CLAP audio embedding now uses deterministic processor-sized windows, aggregation, and normalization instead of random truncation. / CLAP 音频向量改为按处理器窗口确定性分窗、聚合与归一化，不再随机截断。
- New indexes use cosine distance and `similarity = 1 - distance`; legacy squared-L2 collections are rebuilt instead of being interpreted with an incorrect formula. / 新索引使用 cosine 距离与 `similarity = 1 - distance`；旧平方 L2 collection 会重建，不再套用错误公式。
- Hybrid search now defaults to audio CLAP 0.55, text metadata 0.30, and keyword/UCS 0.15, proportionally renormalizing only the available branches. / 混合搜索默认权重调整为音频 CLAP 0.55、文本元数据 0.30、关键词/UCS 0.15，并只对可用分支按比例重新归一化。
- Search filters now use legal `$and` combinations, and cache identity includes project, query, filters, index revision, model fingerprint, and pagination. / 搜索过滤改为合法 `$and` 组合，缓存标识包含工程、查询、过滤、索引 revision、模型指纹和分页参数。
- Changing an Embedding provider, model, or dimension now invalidates only the text-metadata index and preserves the CLAP audio index. / 切换 Embedding provider、模型或维度时仅使文本元数据索引失效，并保留 CLAP 音频索引。
- Heavy audio decoding and scanning now run in a bounded worker pool, while CLAP inference is serialized through a single model worker so FastAPI's event loop remains responsive. / 重型音频解码和扫描改在有界 worker 池运行，CLAP 推理由单一模型 worker 串行调度，使 FastAPI 事件循环保持响应。
- The renderer is split into plain-JavaScript API, state, audio, waveform, search, project, and settings modules without introducing a new frontend framework. / 渲染层拆分为原生 JavaScript 的 API、状态、音频、波形、搜索、工程和设置模块，未引入新前端框架。
- Individual imports now send paths to backend jobs instead of converting complete audio files into renderer-side `number[]` payloads. / 单文件导入改为向后端作业提交路径，不再把完整音频转换为渲染层 `number[]` 载荷。
- Model absence is now a degraded capability rather than a reason to clear data; base file management, playback, waveform, and keyword search remain available while vectors stay pending. / 模型缺失现在只表示能力降级而不是清理数据；基础文件管理、播放、波形和关键词搜索继续可用，相关向量保持 pending。
- A newly installed or replaced local CLAP package is now detected without restarting the backend; preload retries only after the package changes, then durable reconcile jobs automatically backfill recoverable vector artifacts for every project. / 现在无需重启后端即可检测新安装或替换的本地 CLAP 包；只有模型包发生变化才会重试预加载，成功后会为每个工程自动创建持久化 reconcile 作业并补算可恢复的向量 artifact。
- Model releases now use an immutable CLAP commit revision, per-file SHA-256 manifest, deterministic archive metadata, archive SHA-256, staged validation, and atomic replacement. / 模型发布改用不可变 CLAP commit revision、逐文件 SHA-256 manifest、确定性压缩包元数据、压缩包 SHA-256、暂存校验和原子替换。
- The official packaging matrix is limited to native Windows x64 and macOS arm64; cross-OS builds, Linux, and Intel macOS fail before mutation. / 正式打包矩阵收敛为原生 Windows x64 与 macOS arm64；跨系统构建、Linux 和 Intel macOS 会在修改构建目录前失败。
- The audio runtime is pinned to PyAV 18.0.0 with FFmpeg 8.1.2 binary wheels; the official macOS arm64 package therefore requires macOS 14 or later, while Windows keeps the complete `av.libs` closure. / 音频运行时固定为内置 FFmpeg 8.1.2 的 PyAV 18.0.0 二进制 wheel；因此正式 macOS arm64 包要求 macOS 14 或更高版本，Windows 则完整保留 `av.libs` 依赖闭包。
- Release notes are generated from the matching changelog version only after package, lockfile, backend, tag, and bilingual entry synchronization checks pass. / 发布说明改为在 package、lockfile、后端、tag 与双语条目版本同步检查通过后，从对应 changelog 版本自动生成。

### Fixed / 修复

- Fixed GitHub Release upload-name normalization by publishing the Windows installer as the stable `SoundBot-Setup-<version>.exe` asset, keeping the local filename, checksum manifest, provenance subject, and remote inventory identical. / 修复 GitHub Release 上传时对安装包名称的自动规范化问题，Windows 安装包现统一发布为稳定的 `SoundBot-Setup-<版本>.exe`，确保本地文件名、校验清单、provenance 对象与远端资产清单完全一致。
- Fixed empty arrays being accepted as valid waveform data, the primary renderer condition behind blank waveform areas in packaged Windows builds. / 修复空数组被当作有效波形数据的问题，该条件是 Windows 打包版波形区域空白的主要渲染层原因。
- Fixed packaged Windows decoding for compressed containers by removing the dependency on a system FFmpeg executable and collecting the complete PyAV runtime. / 通过移除系统 FFmpeg 可执行文件依赖并收集完整 PyAV 运行时，修复 Windows 打包版压缩容器解码。
- Fixed waveform cache reuse after a source file changed by validating both source and waveform-engine fingerprints before serving stored peaks. / 通过在返回缓存峰值前同时验证源文件与波形引擎指纹，修复源文件变化后继续复用旧波形的问题。
- Fixed IPC failures being converted into successful-looking empty payloads; errors now reject renderer promises with structured context. / 修复 IPC 失败被转换成看似成功的空载荷；错误现在携带结构化上下文并正确拒绝渲染层 Promise。
- Fixed import failures being permanently skipped on later runs and fixed failed files being included in indexed counts. / 修复导入失败后被后续运行永久跳过，以及失败文件被计入已索引数量的问题。
- Fixed SQLite/Chroma drift during add, update, delete, move, and tag changes through upsert, reconciliation, revision bumps, and cache invalidation. / 通过 upsert、对账、revision 递增和缓存失效，修复新增、更新、删除、移动与标签变更时的 SQLite/Chroma 状态失步。
- Fixed active collections accepting vectors from a changed model/provider and fixed search returning Chroma rows whose SQLite artifact is pending, failed, or stale; mixed or unknown engine fingerprints now require a verified shadow rebuild. / 修复 active collection 接受已变化模型/provider 的向量，以及搜索返回 SQLite artifact 为 pending、failed 或 stale 的 Chroma 记录；混合或未知引擎指纹现在必须经过验证的影子重建。
- Fixed supported but corrupt audio files disappearing during import: their stable file records and structured artifact failures now remain in SQLite for diagnosis and retry. / 修复格式受支持但内容损坏的音频在导入时消失；其稳定文件记录和结构化 artifact 失败状态现在保留在 SQLite 中，便于诊断与重试。
- Fixed project switches reusing indexers, searchers, AI services, or cache entries from another project or collection revision. / 修复切换工程后复用其他工程或 collection revision 的索引器、搜索器、AI 服务或缓存项。
- Fixed Windows drive-letter, slash, case, `%`/`_` wildcard, duplicate URL-decoding, and unsafe index-directory handling. / 修复 Windows 盘符、斜杠、大小写、`%`/`_` 通配、重复 URL 解码与不安全索引目录处理。
- Fixed tag keyword matching when SQLite stores tags as JSON arrays and fixed invalid Chroma filter combinations. / 修复 SQLite 以 JSON 数组保存标签时的关键词匹配，以及无效的 Chroma 过滤组合。
- Fixed SSE events split across transport chunks, duplicate user messages, missing assistant history, and stale AI searchers after a project switch. / 修复 SSE 事件跨传输 chunk 拆分、用户消息重复、assistant 历史缺失，以及工程切换后 AI 搜索器未重置的问题。
- Fixed synchronous provider calls blocking the FastAPI event loop and removed duplicate availability probes before normal LLM calls. / 修复同步 provider 调用阻塞 FastAPI 事件循环，并移除正常 LLM 调用前的重复可用性探测。
- Fixed high-DPI Canvas blur, interaction-coordinate drift, and unnecessary full waveform redraws while the playhead moves. / 修复高 DPI Canvas 模糊、交互坐标偏差，以及播放头移动时不必要的整幅波形重绘。
- Fixed backend startup races by treating the frozen process's `BOUND_PORT` handshake as authoritative and by applying a finite, identity-checked health timeout even when another HTTP service occupies the originally probed port. / 通过以后端冻结进程的 `BOUND_PORT` 握手为端口权威，并在原探测端口被其他 HTTP 服务占用时仍执行有限且带身份校验的健康超时，修复后端启动竞态。
- Fixed Windows project-index deletion by explicitly closing Chroma's shared client before removing its directory and performing the filesystem work outside the FastAPI event loop. / 通过在删除目录前显式关闭 Chroma 共享 client，并把文件系统操作移出 FastAPI 事件循环，修复 Windows 工程索引目录无法删除的问题。
- Fixed interrupted artifact and job states remaining permanently stuck after a process restart. / 修复进程重启后 artifact 与作业状态永久卡在处理中状态的问题。
- Fixed folder imports creating duplicate UUIDs and search results when macOS exposed the same file through `/tmp` and `/private/tmp`; scanner roots, SQLite keys, Chroma path keys, and imported-folder mappings now share physical-path identity without changing Windows drive or UNC semantics. / 修复 macOS 通过 `/tmp` 与 `/private/tmp` 暴露同一文件时，文件夹导入产生重复 UUID 和搜索结果的问题；扫描根目录、SQLite 路径键、Chroma 路径键与导入目录映射现在统一使用物理路径身份，同时保持 Windows 盘符与 UNC 语义。

### Removed / 移除

- Removed `indexed_files_meta.json` as an index-state authority and removed destructive collection resets from the normal repair path. / 移除 `indexed_files_meta.json` 的索引状态权威角色，并移除正常修复路径中的破坏性 collection reset。
- Removed generated fake waveform data, WaveSurfer scripts and regions code, and duplicate waveform rendering paths. / 移除生成的假波形数据、WaveSurfer 脚本与 regions 代码，以及重复波形渲染链路。
- Removed renderer and backend paths that converted a complete audio file into `number[]`, used backend PortAudio playback, or depended on an unused playback WebSocket/cache API. / 移除将完整音频转换为 `number[]`、使用后端 PortAudio 播放或依赖未使用播放 WebSocket/缓存 API 的前后端链路。
- Removed obsolete reindex/reset utilities, duplicate build helpers, personal hard-coded paths, stale AI/build-fix documents, and unused dependencies. / 移除过时的重索引/重置工具、重复构建辅助脚本、个人硬编码路径、失效的 AI/构建修复文档与无用依赖。
- Hid Azure OpenAI, Google Gemini, Anthropic, and Kimi Coding entries until their adapters are validated, while preserving legacy configuration for migration. / 在对应适配器验证前隐藏 Azure OpenAI、Google Gemini、Anthropic 与 Kimi Coding 入口，同时保留旧配置供未来迁移。

### Security / 安全

- API keys are encrypted by OS-backed `safeStorage`, never returned to the renderer, never persisted by the Python backend, and never included in logs or exported configuration. / API 密钥由操作系统支持的 `safeStorage` 加密，不回传渲染层、不由 Python 后端持久化，也不会进入日志或导出配置。
- Secret saves are transactional across secure storage and backend metadata; failed saves restore the previous encrypted store, while connection tests never persist temporary credentials. / 密钥保存横跨安全存储与后端元数据并具有事务语义；保存失败会恢复先前密文，连接测试不会持久化临时凭据。
- Project and collection paths are normalized and constrained to their configured root before creation or deletion, preventing unsafe IDs from escaping the project index directory. / 工程和 collection 路径在创建或删除前会规范化并限制在配置根目录内，防止不安全 ID 逃逸工程索引目录。
- Model extraction rejects absolute paths, traversal, symlinks, Zip Slip, missing checksums, mutable revisions, malformed manifests, and per-file hash mismatches before atomic installation. / 模型解压会在原子安装前拒绝绝对路径、目录穿越、符号链接、Zip Slip、缺失校验、可变 revision、异常 manifest 和逐文件哈希不匹配。
- Packaging verifies the native executable architecture, collects PyAV/FFmpeg licenses, and excludes `.DS_Store`, the development `SoundBot.png`, WaveSurfer, models, caches, and source-only backend files. / 打包会验证原生可执行文件架构、收集 PyAV/FFmpeg 许可证，并排除 `.DS_Store`、开发用 `SoundBot.png`、WaveSurfer、模型、缓存和仅源码后端文件。
- The Windows release gate starts the frozen backend with a clean `PATH` and no system FFmpeg, then requires the complete format matrix, exact waveforms, CLAP, Chroma, hybrid search, `win-unpacked`, and NSIS installer integrity checks to pass before publishing. / Windows 发布门禁会在干净 `PATH`、无系统 FFmpeg 下启动冻结后端，并要求全格式矩阵、精确波形、CLAP、Chroma、混合搜索、`win-unpacked` 与 NSIS 安装包完整性检查全部通过后才允许发布。
- CI builds Windows x64 and macOS arm64 only on native runners and blocks release creation if any functional smoke test, model check, metadata check, package check, or installer check fails. / CI 仅在原生 runner 构建 Windows x64 与 macOS arm64，并在任一功能冒烟、模型、元数据、应用包或安装包检查失败时阻止创建 Release。

[Unreleased]: https://github.com/Huckrick/SoundBot/compare/v0.2.1-beta.3...HEAD
[0.2.1-beta.3]: https://github.com/Huckrick/SoundBot/compare/v0.2.1-beta.2...v0.2.1-beta.3
[0.2.1-beta.2]: https://github.com/Huckrick/SoundBot/compare/v0.2.1-beta.1...v0.2.1-beta.2
[0.2.1-beta.1]: https://github.com/Huckrick/SoundBot/compare/v0.2.0...v0.2.1-beta.1
[0.2.0]: https://github.com/Huckrick/SoundBot/compare/v0.1.4...v0.2.0
