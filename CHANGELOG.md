# Changelog / 更新日志

> 说明：本项目沿用 SoundBot 的变更记录格式（[Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)），
> 版本号遵循[语义化版本](https://semver.org/lang/zh-CN/)。测试版编号 V<n> 对应 `0.3.0-beta.<n>`。

## [Unreleased]

### Added / 新增

- 长文本转语音并进「声音克隆」：顶部两个标签页（短音频 / 长音频），共用同一个音色库 / Long-form TTS folded into the Voice Clone dialog as a second tab, sharing one voice library
- 新增「长文本转语音」：粘贴整章文字后台生成，进度可查，可中途停止，输出文件夹和文件名自己选 / Long-form text to speech: paste a chapter, watch progress, stop midway, choose output folder and filename
- **右键「找相似」**：主列表右键菜单最上面，按「标签 / 描述 / 音频向量」混合找相似——同类段（词命中 + IDF）排在前面，听感段（CLAP 余弦 ≥ 0.55）接在后面，总数 100；结果顶部有「与 X 相似 · 返回全部」横幅 / **Find similar** in the list context menu: hybrid ranking of tag/description term hits (IDF-weighted, first) and CLAP audio neighbours (cosine ≥ 0.55, after), capped at 100, with a banner to return to the full list.

## [0.3.0-beta.18] - 2026-11-04

> 测试版 V14。可用性清账：导入 6.5 万条压到 1 分钟内、保存标签 10 秒 → 0.5 秒、 / 
> 两套标签合成一个入口、后端主文件拆成 21 个模块（10,147 → 5,330 行）。 / Beta 14 is a usability pass: importing 65k files down to under a minute, saving tags from 10s to 0.5s, unified tag entry, and the backend main file split into 21 modules.

### Changed / 变更

- 两套标签合并成一个入口：一个弹窗选预设词或输入自定义，用户不用区分两套 / Tags merged into one entry: a single dialog for preset words and custom labels, users no longer need to know there are two stores
- 后端主文件拆分：129 个接口搬进 21 个模块（10,147 → 5,330 行） / Backend main file split: 129 endpoints moved into 21 modules (10,147 → 5,330 lines)
- 时长显示改 `HH:MM:SS`，主列表、播放器、波形坐标统一 / Duration display switched to `HH:MM:SS` across list, player and waveform ruler
- 导入完成后提示「请导入知识包」，不再提示「索引还没建完」 / Import completion now suggests importing the knowledge pack instead of warning about unfinished indexing
- AI 生成音效改落 `%APPDATA%\EchoMind\generated\YYYYMMDD\`，历史支持重命名 / 定位 / 删除 / Generated audio now lands in a stable directory; history supports rename, reveal in folder and delete

### Performance / 性能

- 导入写库改批量事务 + 单线程 executor：6.5 万条十几分钟 → 1 分钟内 / Import writes batched into transactions on a single-thread executor: 65k files from 15+ minutes to under a minute
- 保存标签时清搜索缓存改后台执行：10 秒 → 0.5 秒 / Search-cache invalidation moved to the background: saving tags from 10s to 0.5s
- 左侧标签树改轻量刷新，只拉 `/api/v1/tags`（0ms） / Tag tree refresh now only queries `/api/v1/tags` (0ms) instead of the 2.2s full-library aggregation
- AI 生成音效响度标准化到 -16 LUFS、峰值 ≤ -1 dBTP（实测增益 +5.2 / +7.5 dB） / Generated audio normalized to -16 LUFS with peak below -1 dBTP (measured gain +5.2 / +7.5 dB)

### Fixed / 修复

- 长文本生成超过 45 秒后内容对不上：Breeze 默认按 600 字切分（约 120 秒一整段），改成 150 字（约 30 秒），服务端逐段生成且每段沿用第一段的音色 / Long-form synthesis drifted past 45s: Breeze split at 600 chars by default (~120s a pass); lowered to 150 chars (~30s), each piece conditioned on the first to keep the voice stable
- 中文音色名注册 Breeze 报 400：voice id 只接受 ASCII 字母数字短横下划线 / CJK voice names failed to register: the voice id only accepts ASCII letters, digits, dash and underscore
- 重新读取目录报 canonicalize_path 未定义 / Library rescan failed with canonicalize_path undefined
- 设置里新增本地数据面板：查看占用、清理缓存、清除全部数据 / Settings gained a Local Data panel: usage, cache clear, full reset
- 一句话描述保存失败：`canonical_path` 未命中时按 `file_uuid` 兜底写入 / One-line description save failure: falls back to `file_uuid` when `canonical_path` misses
- 系统标签与右键加标签保存失败：`_projects_deleting` 漏了调用括号 / Tag save failure: a missing call parenthesis on `_projects_deleting`
- 重新读取目录扫到父目录：`list_library_roots` 改为按盘符求公共前缀 / Library rescan no longer walks the parent folder: roots are computed per drive via common prefix
- 拖拽导出 `handlePlaybackEnded is not defined` / Drag-export crashed with `handlePlaybackEnded is not defined`
- 更新器静默挂起：`.finish-update.cmd` 生成后从未被执行 / Updater no longer silently defers: the finish-update script is now actually executed
- 知识包：四级匹配、向量按 `file_uuid` 去重、文本向量维度校验不再误判整包拒收 / Knowledge pack: four-level matching, vector dedupe by `file_uuid`, and dimension checks no longer reject whole packs
- 扫描跳过系统目录（回收站 / System Volume Information / 缓存 / 点开头目录） / Scanning skips system folders (recycle bin, System Volume Information, caches, dot-directories)

### Fixed / 修复

- **长 ID3 配乐 MP3 编不出音频向量**：`melworker._main()` 把 `_process_one()` 返回的 `(features, reason)` 当成 features 传给 `_forward_one()`，内部 `AttributeError` 被吞掉，worker 对任何文件都返回 None；修复后实测 `audio_vector` ready 64,873 / failed 1 → ready 64,874 / failed 0 / **Long-ID3 tracks had no audio vector**: the mel worker passed the `(features, reason)` tuple straight to `_forward_one()`, whose swallowed `AttributeError` made every encode return None; the live library went from 64,873 ready / 1 failed to 64,874 ready / 0 failed.
- **失败原因写不出来**：artifact 的 `error_message` 现在带 worker 回报的具体原因（`blacklisted` / `decode_timeout` / `forward_none` / `processor_error`），不再只有一句「批量编码未产出向量（原因: unknown）」 / **Failure reasons are now recorded**: artifact `error_message` carries the worker-reported cause (`blacklisted`, `decode_timeout`, `forward_none`, `processor_error`) instead of a bare unknown.
- **`compute_mel_batch()` 误判**：特征提取超过 3 秒的正常文件会被写成 `error`，现在只记诊断并继续 forward / **Slow files were misreported**: files taking more than 3 s in feature extraction were written as `error`; they are now only logged and still encoded.
- **全新安装的文件列表会报错**：全新数据库在表还不存在时就尝试补列，异常被吞掉，导致缺 `is_favorite` / `sha256` / `source`，文件列表接口直接抛 `no such column`；现在建表后立即补列，已用全新库实测通过 / **Fresh installs had a broken file list**: the column top-up ran before the tables existed and its exception was swallowed, leaving `is_favorite`, `sha256` and `source` missing; it now runs right after table creation and a brand-new database passes.
- **导入知识包/描述包在手写描述面前会一条都写不进去**：`metadata_pack.apply()` 里的闭包写 `skipped += 1` 少了 `nonlocal`  ，只要库里有一条非 `[auto]` 的描述就抛 `UnboundLocalError`，异常被吞成一条 warning，整批 `continue`，界面显示「应用 0 条」  / **Pack imports silently applied nothing**: a missing `nonlocal` in `metadata_pack.apply()` raised `UnboundLocalError`  whenever the library already had a hand-written description, and the swallowed exception made the whole batch write nothing.

### Changed / 变更

- **毒文件名单保持「漏封」**：单文件编码超时不再写名单（原来的三列格式读取端从来不认，实际从未生效），只记一条 warning；名单只由二分定位失败两次的文件写入 / **Timeouts no longer poison-list a file**: the old three-column write was never honoured by the reader and is removed; only files that fail twice during bisection are recorded, so one timeout can no longer lock a good file out for three days.
- **工件计数只看仍然存在的文件**：`get_artifact_counts` 改为 `JOIN files`，无主工件不再让界面永远显示「待索引 N」 / **Artifact counts ignore orphan rows**: `get_artifact_counts` now joins `files`, so rows whose file was deleted no longer keep a phantom pending counter alive.

### Removed / 清理

- **24 行孤儿工件已清理**（音频 pending 6 / ready 2、文本 pending 8、波形 pending 1 / ready 7），删除前把整行写进 `%APPDATA%\EchoMind\db\orphan-artifacts-*.json` / **24 orphan artifact rows removed** (audio pending 6 / ready 2, text pending 8, waveform pending 1 / ready 7); every row was journalled to `orphan-artifacts-*.json` before deletion.
- **新增 `scripts/prune_orphan_artifacts.py`**：默认 dry-run，`--apply` 才删除，删前自动落 JSON 备份 / **New maintenance script** `scripts/prune_orphan_artifacts.py` is dry-run by default and journals every row before `--apply` deletes it.

### Docs / 文档

- **新增根因记录** `docs/长ID3音频向量-根因与修复-20261031.md`：证据链、改动清单、复现脚本 / **New root-cause record** `docs/长ID3音频向量-根因与修复-20261031.md` documents the evidence chain, the change list and the reproduction scripts.

## [0.3.0-beta.12] - 2026-10-29

> 测试版 V12。这一版做的是「助理能看见、能听见」：顶栏的小精灵换成了一个会呼吸、会眨眼、会跟着说话的少女形象，声音换成少女音，长回复也改成了边合成边播。 / Beta 12 gives the assistant a face and a voice: the top-bar mascot becomes an animated少女, her voice moves to a girl timbre, and long replies are synthesised sentence by sentence.

### Added / 新增

- **助理形象**：顶栏「声音克隆」右侧换成 WebGL 网格形象（回声少女），会眨眼、呼吸、头发随头部摆动；点它仍然打开助理面板 / **Assistant avatar**: the mascot beside the top-bar controls is now a WebGL mesh character that blinks, breathes and sways her hair; clicking it still opens the assistant panel
- **说话对口型**：播报时按音量驱动嘴部网格 / **Lip sync**: the mouth mesh follows playback loudness
- **少女音**：本地 Breeze TTS 增加了音色指令，助理播报的基频从 190 Hz 提到 238 Hz / **Girl voice**: a voice-style instruction on local Breeze TTS raises the assistant's median pitch from 190 Hz to 238 Hz
- **实时语音**：长回复按句切分、流水线合成，第一句出声从 7–9 秒降到约 1.1 秒；新回复会打断上一条 / **Realtime speech**: replies are split into sentences and synthesised as a pipeline, cutting time-to-first-audio from 7–9 s to about 1.1 s; a newer reply cancels the previous one

### Changed / 变更

- 助理名字从「大肥鱼」统一为「回声」，面板标题、欢迎语、提示、设置项都改 / **Renamed**: the assistant is called 回声 everywhere (panel title, welcome text, tooltips, settings)
- 助理人设写明了语音能力，不再自称「没有语音输出能力」 / **Persona**: the system prompt now states the assistant does speak when the voice toggle is on

### Fixed / 修复

- 播报口型钩子挂在不存在的全局对象上，从未生效 / The lip-sync hook was attached to a global that never existed in the renderer
- 语音开关默认关闭，助理从不出声 / The voice toggle defaulted to off, so the assistant never spoke

## [0.3.0-beta.11] - 2026-10-25

- （该版本的条目在整理时缺失，改动见 git 历史与 `docs/` 下的实施记录
  / entries for this version are missing; see git history and `docs/`)