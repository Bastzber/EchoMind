# 交接文档（新会话从这里读）

更新：2026-10-24

## 一、项目位置与运行

```
E:\音效库管理软件\EchoMind\EchoMind-main     ← 代码
E:\音效库管理软件\EchoMind\EchoMind-main\dist-electron-v5\EchoMind测试版V8.zip   ← 最新安装包
```

**开发模式（改完 Ctrl+R 生效，不用打包）**

```powershell
cd E:\音效库管理软件\EchoMind\EchoMind-main
powershell -ExecutionPolicy Bypass -File scripts\dev.ps1
```

**打包发版**

```powershell
.venv\Scripts\python.exe -m PyInstaller backend\main.spec --distpath dist\backend --workpath dist\build --noconfirm --clean
npx --no-install electron-builder --win --x64 --config.directories.output=dist-electron-v5
```

## 二、当前版本

- `0.3.0-beta.8`（测试版 V8），health 接口可验证
- 数据库：`%APPDATA%\EchoMind\db\soundmind.db`
- 库内 48,648 条音效，音频/文本/波形索引 100% 就绪

## 三、已完成功能

- 标签双层（场景/属性）+ 右键设标签 + 按标签筛选 + `tag:名称` 搜索
- 中文语义搜索（bge-small-zh 512 维，内置），短词 0.05s、长句 0.3s
- 拟音工坊（五类环境音、四音轨、远近×强弱、历史录音）
- 星标收藏、重复音效检测、排序、来源标记
- 文件夹右键删除（可选删源文件 + 回收站）

## 四、进行中：批量重命名

**后端已完成**（`POST /api/v1/files/rename`，支持 dry_run，编译通过，未打包）

下一步做前端：
1. 右键选中多个音效 →「批量重命名…」
2. 弹窗列「原名 → 新名」，可编辑
3. 「预览」调 dry_run 显示可改/失败项
4. 「执行」后刷新列表

## 五、待办

| 优先级 | 项 |
|---|---|
| P0 | 林间鸟鸣无声（音频有内容，播放链路待查） |
| P1 | 批量重命名前端界面 |
| P1 | 拟音工坊试听面板移到右侧（三栏布局） |
| P2 | 各环境音细节区分度调参 |
| P2 | 描述包导入未匹配 CSV 导出 |
| P3 | `metadata/apply` 后自动重建文本索引 |

## 六、已知坑（踩过的）

- `main.js` 优先找打包后端；开发必须设 `SOUNDBOT_BACKEND_DEV=1`（dev.ps1 已含）
- 端口 8000 被旧 `soundbot-backend.exe` 占用会导致新接口 404，先杀进程
- 编辑 `package.json` 时不能带 BOM，否则 electron-builder 报 JSON 解析失败
- 后端 `tags` 列是 JSON 字符串，前端必须 `normalizeTags` 转数组
- git 需要显式代理：`git config http.proxy http://127.0.0.1:7890`

## 七、文档

- `docs/EchoMind-V6-更新说明.md/.docx`（面向用户）
- `docs/EchoMind-V6-安装指南.md/.docx`
- `CHANGELOG.md`、`docs/dev-status-2026-10-24.md`
