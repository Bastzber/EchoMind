# EchoMind 测试版 V5

> 用一句话找到你想要的声音。

## 下载

**百度网盘（完整安装包 3.27 GB）**

链接：https://pan.baidu.com/s/15Xd2k2od5080t4tGYx0JSw?pwd=pvdt

提取码：`pvdt`

下载后解压，双击 `win-unpacked\EchoMind.exe` 运行。

> 安装包 3.27 GB，超过 GitHub 单附件 2 GB 上限，因此以网盘方式分发，Release 不挂附件。

## 界面

**主界面：目录树 + AI 描述 + 波形试听**

![主界面](https://raw.githubusercontent.com/Bastzber/EchoMind/main/assets/screenshots/main.png)

**库里有就找出来，库里没有就当场生成**

![创造音效](https://raw.githubusercontent.com/Bastzber/EchoMind/main/assets/screenshots/generate.png)

## 这个版本做了什么

### 索引

- 修复打包后 mel worker 被当成第二个 HTTP 服务、导致音频向量全部编码失败（15,226 条假失败）
- 毒文件黑名单改为「连续失败 2 次才拉黑、3 天过期」，不再永久跳过正常文件
- 清理 1,565 条永久无法索引的记录（源文件缺失 / 解码失败）

### 搜索

- 检索器按工程缓存，修掉每次搜索重建 7~13 秒的问题
- 扩展词分层打分：原查询不封顶、分词 0.65、同义词 0.40 —— 修复 `DRIP.wav` 压过真实雨声的排序
- 搜索框走快速通道：**0.06 ~ 0.3 秒**出结果
- 语义结果改为后台追加，不阻塞、不替换已有排序

### 描述

- 48,649 条一句话描述 100% 生成并校验（0 条异常）
- 新增可移植描述包：换盘换机后导入即可复用（已内置在安装包根目录）

### 界面

- 文件夹树按全库统计构建，点击目录列出该目录全部文件，滚到底自动加载
- 支持拖拽文件夹 / 文件导入

## 系统要求

| 项 | 最低 | 建议 |
|---|---|---|
| 系统 | Windows 10 64 位 | Windows 11 64 位 |
| 内存 | 8 GB | 16 GB |
| 磁盘 | 5 GB | 10 GB 以上 |
| 显卡 | 无（CPU 可用） | NVIDIA 6 GB 显存以上 |

## 已知限制

- 语义搜索单次 8~14 秒（已用两段式缓解：关键词先出、语义后补）
- 启动后约 20 秒内首次搜索偏慢（检索器预热中）

## 说明

本项目基于 [SoundBot](https://github.com/Huckrick/SoundBot)（GPL-3.0-or-later，作者 Nagisa_Huckrick / 胡杨）修改。
