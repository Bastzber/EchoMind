# Changelog / 更新日志

> 说明：本项目沿用 SoundBot 的变更记录格式（[Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)），
> 版本号遵循[语义化版本](https://semver.org/lang/zh-CN/)。测试版编号 V<n> 对应 `0.3.0-beta.<n>`。

## [Unreleased]

## [0.3.0-beta.13] - 2026-10-31

> 测试版 V13。这一版把「索引到底为什么失败」讲清楚了：长 ID3 的配乐 MP3 一直编不出音频向量，根因是 mel 子进程少解一个包，不是解码器、也不是模型限制。 / Beta 13 makes indexing failures explainable: the long-ID3 tracks had no audio vector because the mel worker unpacked a two-tuple as features, so every encode returned None — not a decoder or model limitation.

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