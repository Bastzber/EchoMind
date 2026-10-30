# Changelog / 更新日志

All notable changes to SoundBot are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

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
# Changelog / 更新日志

All notable changes to SoundBot are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses [Semantic Versioning](https://semver.org/). / 本文件记录 SoundBot 的重要变更，格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循[语义化版本](https://semver.org/lang/zh-CN/)。

## [0.3.0-beta.11] - 2026-10-25
