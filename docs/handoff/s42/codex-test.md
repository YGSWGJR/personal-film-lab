# S42 Codex 本端测试记录

更新日期：2026-11-15

## 环境

- Windows 11 x64
- Node.js 24.20.0（满足 `>=22.12.0`）
- npm 11.19.0
- Electron 45 开发运行时
- 所有数据测试使用独立 `DSH_DATA_ROOT`

## 命令

```powershell
npm run typecheck
node tests/unit/project-media-migration.mjs
node tests/unit/project-media-backup-fixture.mjs work/s42-v12-fixture
npm run smoke   # SMOKE_PROJECT_MEDIA=1
npm run smoke   # SMOKE_S42_PROJECT_UI=1
npm run smoke   # SMOKE_S42_WALL_UI=1
npm run smoke   # SMOKE_WALL_UI=1 + SMOKE_TIMELINE_ZOOM=1
npm run smoke   # SMOKE_NLE_TRACKS=1
npm run smoke   # SMOKE_DELETE_UI=1
./scripts/clean-duplicates.ps1 -Check
```

## 实测证据

### 数据迁移

- v12 夹具：projects=1、shots=1、scenes=1、stills=1。
- 升级后 schema=13，四类旧记录数量保持不变。
- `project_media=1`，`active_media_id` 与 shots/stills/scenes 的 `media_id` 一致。
- 自动生成 `backups/lapian-v12-2026-11-15T04-04-20-674Z.db`，大小 253,952 B。

### 项目媒体

- 两个媒体分别创建 1 个镜头与 1 张静帧。
- 内存中交替激活两个媒体 20 次，每次只返回对应媒体的 1 个镜头。
- 项目包 manifest v2 包含 2 个媒体，schema=13。
- 包内数据库不包含输入夹具的 `C:\media\...` 绝对路径。
- 同 ID 冲突导入后仍有两个媒体，每个媒体各有 1 个镜头。
- 空项目项目包往返后媒体数=0、activeMediaId=null、镜头数=0。
- `SMOKE_PROJECT_MEDIA=1` 全部检查通过。

### 分镜墙静帧与画笔

- 3 张 main 静帧在列表中出现，auto-thumb 被排除。
- 缩略图宽度 240→420px，双击进入放映，Esc 返回后宽度恢复为 420px。
- Ctrl+0 在静帧库复位到 240px。
- 1px 与 48px 笔划均只生成 1 个对象；旧无 size 笔划按 0.125 归一化线宽渲染。
- 一次连续橡皮手势删除 2 个命中对象，单次撤销后两个对象全部恢复。
- 取消手势不改变对象数；3 条有效标注最终写入数据库。
- 独立分镜本文本输入中 Backspace 不删除节点；退出编辑后 Backspace 弹确认并可删除节点。
- `SMOKE_S42_WALL_UI=1` 全部检查通过。

### 项目中心

- 两个媒体标签显示 `center-one.mp4`、`center-two.mp4`。
- 连续切换 20 次后，会话保存了 projectId 和第二个媒体的 activeMediaId。
- 新建空项目后无媒体标签，并显示空项目状态。
- `SMOKE_S42_PROJECT_UI=1` 使用两个真实短视频完成，全部检查通过。

### 删除、轨道与旧交互

- 时间线输入框内 Delete/Backspace 不删除镜头。
- Backspace 弹确认，Esc 保留镜头；Delete 弹确认，Enter 删除镜头。
- 轨道高度与时间密度全部档位可调，缩放面板处于正常布局行，Ctrl+0 复位有效。
- 分镜墙旧图片导入、端口连线、复合节点、投影与独立保存门禁保持通过。
- `SMOKE_WALL_UI=1 + SMOKE_TIMELINE_ZOOM=1` 全部检查通过。
- `SMOKE_NLE_TRACKS=1` 全部检查通过，三轨、锁定、M/S、导航、缩放和恢复均正常。
- `SMOKE_DELETE_UI=1` 全部检查通过，包含 Backspace 确认、输入守卫、危险路径拒绝和孤立实体检查。
- `./scripts/clean-duplicates.ps1 -Check`：当前副本数 0。

## 未执行

- 因本机缺少 Visual Studio C++ Build Tools，未执行完整 `npm ci` 原生依赖重建。
- 未生成 NSIS 安装包。
- 未执行跨分支交叉审查和最终 v0.5.0 发布评分。

## 2026-11-15 回归修复复测

- `vue-tsc --noEmit -p tsconfig.web.json`：通过。
- `tsc --noEmit -p tsconfig.node.json`：通过。
- `electron-vite build`：通过。
- 定向 Electron smoke：`passed=true`，失败项为空。
- `SMOKE_S42_PROJECT_UI=1`、`SMOKE_S42_WALL_UI=1`、`SMOKE_WALL_UI=1`、`SMOKE_TIMELINE_ZOOM=1` 全部通过。
- 轨道高度最低档为 48px；48px 输入和设置读取均被校正到合法档位。
- 分镜墙标注保存、撤销、重做、橡皮单次撤销和旧标注兼容通过。
- 反馈入口鼠标、Enter、Space 和 Esc 行为通过。
- 分镜墙选择框在 1426×864 视口中完整居中显示。
- v12→v13 数据库迁移 GUI 复核通过，旧项目可打开，自动生成 v12 备份。
