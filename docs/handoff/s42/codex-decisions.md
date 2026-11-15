# S42 Codex 本端决策

## 数据库

- `project_media` 是多视频的事实源；`projects` 中原单媒体列保留为兼容投影。
- `projects.active_media_id` 指向当前视频；旧项目使用 `legacy-media-<projectId>` 确定性 ID 回填。
- `shots.media_id`、`scenes.media_id`、`stills.media_id` 作为实体隔离键；默认仓储查询读取当前激活媒体。
- `shot_index` 只在同一个 `media_id` 内编号，避免两个视频的镜头编号互相污染。
- 迁移前自动生成 `backups/lapian-v<old>-<timestamp>.db`；备份失败则中止迁移。

## 会话

- `WorkspaceState.activeMediaId` 记录当前视频。
- `WorkspaceState.mediaSessions[mediaId]` 保存每个视频的播放位置、选中镜头、滚动位置和检测结果快照。
- 快速切换通过串行 Promise 队列执行，避免多个异步加载互相覆盖。

## 项目包

- 项目包格式升级到 manifest v2，同时继续读取 v1。
- v2 记录 `appVersion`、`schemaVersion`、媒体 ID/顺序/文件名和资源路径清单。
- 导出快照中的 `projects.source_path`、`project_media.source_path`、`proxy_path` 清空，避免泄露本机私有绝对路径。
- 导入时重映射媒体、镜头、场景、静帧、分镜布局、连线、分组和镜头标注。
- 失效媒体由项目中心显式重定位，不自动猜测或指向其他媒体。

## 渲染层

- 项目媒体与项目中心拥有独立 IPC 域，不把任意通道透传给 renderer。
- 静帧库状态使用 `pfl:wall-stills:<projectId>` 与 `pfl:wall-view:<projectId>` 本地存储，不写入 shared settings。
- 画笔 `size` 保存在本地 view 的标注 `data.size`，继续由现有 `z.looseObject` 承载，不扩展 shared annotation schema。
- 一次绘制/擦除手势只推入一条历史；取消手势恢复手势前快照且不写库。
- 普通点击画布卡会立即选择该卡；此前 plain click 只清空选择、不加入当前卡的问题已修复。
- 分镜墙自行消费播放/画笔状态下的 Esc；外部节点编辑和文本输入优先让位。
- 缩放面板使用普通文档流，不再绝对定位覆盖轨道；轨道区域负责内部滚动。
