# EchoMind × Premiere Pro 面板

在 PR 里用一句话搜本地音效库，试听、看波形，一键导入到项目面板。
覆盖 Premiere Pro 2022 ~ 2025（CEP 扩展，PPRO [22.0,99.9]）。

## 安装（一次）

1. 完全退出 Premiere Pro（要 Completely Exit，只关窗口不算）
2. 双击本目录里的 安装到PR.bat
3. 重新打开 PR → 菜单 窗口 → 扩展 → EchoMind 音效搜索

脚本做的事：把面板拷到 %APPDATA%\Adobe\CEP\extensions\com.echomind.panel，
并给 HKCU\Software\Adobe\CSXS.9~12 写 PlayerDebugMode=1（免签名加载）。

## 用之前：两件事

1. EchoMind 要在后台运行（面板左上角会显示「已连接」或「EchoMind 未启动」）
2. 在 EchoMind 设置里配好 DeepSeek（设置 → AI → 提供商选 DeepSeek → 填 API Key）
   没配也能用，会降级成纯关键词搜索，面板上会提示

## 用法

| 操作 | 说明 |
|---|---|
| 输入一句话，回车 | 例如「低沉的猪哼，短一点」「电子质感的爆炸，只要 2 秒左右」 |
| Shift+回车 | 输入框内换行 |
| 试听 | 面板底部播放器；APE/CAF 这类浏览器放不了的，用「在 EchoMind 打开」 |
| 导入到项目 | 素材进入 PR 项目面板（PR 不允许面板直接往时间线塞素材，需要你在项目面板拖一下） |
| 复制路径 | 复制磁盘完整路径，方便别的流程用 |

## 面板背后调的接口

| 接口 | 用途 |
|---|---|
| POST /api/v1/ai/nl-search | 一句话 → 关键词/标签/时长 → 混合搜索（新增） |
| GET /api/v1/files/{id}/audio | 流式音频，支持 Range（新增，供 audio 标签播放） |
| GET /api/v1/files/{id}/waveform | 波形峰值 |
| GET /api/v1/projects | 工程列表 |

## 排查

| 现象 | 处理 |
|---|---|
| PR 里找不到「扩展」菜单 | PR 2022 的扩展菜单位于「窗口 → 扩展」；确认完全退出后重启 |
| 面板空白 / 白屏 | 确认 CSXS/manifest.xml 拷过去了；看 %TEMP%\cep_logs |
| 面板显示「EchoMind 未启动」 | 先打开 EchoMind 主程序，再回来点搜索 |
| 显示「AI 未配置」 | EchoMind 设置里填 DeepSeek Key，或忽略（关键词搜索也能用） |
| 导入到项目没反应 | 确认 PR 里已经打开了一个项目（没有项目时导不进去） |

## 卸载

删掉 %APPDATA%\Adobe\CEP\extensions\com.echomind.panel 即可。
