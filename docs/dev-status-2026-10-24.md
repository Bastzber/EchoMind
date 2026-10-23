# 开发进度 2026-10-24（夜间自主推进）

## 目标
按 M4 → P3 顺序完成剩余开发，不触碰拟音工坊。

## M4 标签双层（进行中）

### 已完成
- `backend/core/tag_layers.py`：tags / file_tags 表结构、迁移函数、列表/改层/改名/删除、单文件设标签（含 scene 互斥约束）
- `database.py`：启动时自动建表 + 一次性迁移 files.tags → tags/file_tags（迁移标记写在 app_meta）
- `main.py`：新增 5 个接口
  - GET    /api/v1/tags            分组返回 scene / attr
  - POST   /api/v1/tags            新建（name, layer）
  - PATCH  /api/v1/tags/{id}       改名 / 改层
  - DELETE /api/v1/tags/{id}
  - POST   /api/v1/files/{uuid}/tags   设置文件标签（多个 scene 会报 400）

### 迁移结果（真实库）
```
[Tags] 双层标签迁移完成，关联 1 条
tags total: 1  scene: 0  attr: 1   （动物）
```
说明：库内带标签的文件本来就极少（48,649 条里只有 1 条有标签），迁移量小属正常。

### 已排查（已解决）
- 现象：/api/v1/tags 返回 404 且 scene=0。
- 根因：端口 8000 被**打包版 soundbot-backend.exe** 占用（旧代码没有新路由），dev 启动的 python 后端没抢到端口。
- 解决：先按进程名清掉 soundbot-backend 再启动 dev；`scripts/dev.ps1` 已包含该清理动作。

### 已完成（第二轮）
- 侧栏按「场景 / 属性」分组渲染，标签右键可改层/删除
- 音效右键「设置标签…」：场景单选 + 属性多选，支持多选音效批量打
- 点标签按后端过滤：`GET /api/v1/files?tag=名称`（实测「动物」命中 1 条）
- `rendererApi.patch` 客户端方法补齐

### 未做
- 新建标签时无法指定层（默认 attr，之后右键提升）
- 搜索语法里的标签条件（scene:xxx attr:yyy）尚未接入 FTS 查询
- 自动为已有描述生成 scene/attr（可选增强）

## P3 中文 embedding（进行中）

### 已完成
- `backend/core/zh_embedder.py`：transformers 直接加载 BAAI/bge-m3，mean-pooling + L2 归一化，自动 cuda/cpu，模型缺失返回 None
- API：`GET /api/v1/embed/status`、`POST /api/v1/embed/preview`（返回维度与两两相似度）
- 模型下载到 `models/bge-m3`（走 hf-mirror + 代理）

### 进展（第三轮）
- BGE-M3（2.2GB）下载卡在 46MB 不动（hf-mirror 大文件被限速/中断）
- 改用 **bge-small-zh-v1.5（92MB，512 维）** 并成功加载：
  ```
  encode 3 条耗时 3.9s，shape (3, 512)
  sim(玻璃破碎声, 茶杯摔碎的脆响) = 0.586
  sim(玻璃破碎声, 沉重的脚步声) = 0.400
  ```
  语义区分度正常，中文场景够用
- `backend/core/zh_text_index.py`：Chroma 集合 `text_zh`，批量编码入库
- 小规模验证：200 条 5.9 秒，0 失败 → 全量约 24 分钟
- `POST /api/v1/embed/rebuild`、`GET /api/v1/embed/rebuild/status`
- 全量重建已在后台启动

### 已完成（第四轮）
- 全量重建：**48,648 条，0 失败，1.6 分钟**（GPU）
- `zh_text_index.search / search_rows` 接入 `search_async`：
  ```
  engine = 'bge'，layers.semantic = 5，elapsed 2.77s（首次含模型加载）
  0.861 打碎玻璃声.wav
  0.832 打碎玻璃声.wav
  0.828 GLASS1.WAV
  ```
  语义质量明显优于 CLAP 文本塔

### 待办
- **HTTP 接口路径未走 BGE**：`POST /api/v1/search` 仍耗时 17.8s（CLAP），直接调 `searcher.search_async` 却是 bge。
  怀疑接口在调用前对 query 做了英文翻译，导致 `contains_chinese` 判定失效 —— 下一轮排查 `main.py:3401` 附近。
- 模型选择：网络恢复后可换回 bge-m3（代码已支持按目录自动选择，维度自适应）

## 旧的 P3 说明（存档）
- 候选模型：BGE-M3（2.2GB，效果好）或 bge-small-zh（95MB）
- 需重建 48,649 条文本向量
- 切换 search_engine 的 text tower

## 明日建议顺序
1. 修 M4 的 API/DB 路径不一致问题
2. 完成标签面板 UI + 筛选
3. 启动 P3
