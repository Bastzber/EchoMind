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

### 未做
- 前端标签面板拆成「场景 / 属性」两段（单选 / 多选）
- 右键「设为场景标签」「添加属性标签」
- 搜索筛选：场景=xxx AND 属性⊇(a,b)
- 自动为已有描述生成 scene/attr（可选增强）

## P3 中文 embedding（未开始）
- 候选模型：BGE-M3（2.2GB，效果好）或 bge-small-zh（95MB）
- 需重建 48,649 条文本向量
- 切换 search_engine 的 text tower

## 明日建议顺序
1. 修 M4 的 API/DB 路径不一致问题
2. 完成标签面板 UI + 筛选
3. 启动 P3
