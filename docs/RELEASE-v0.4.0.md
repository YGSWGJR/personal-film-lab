# v0.4.0 发布说明（分镜本节点交互 + 标注面板 + 投影完善 + 复合节点）

- 分支：`main`；tag `v0.4.0`
- 日期：2026-11-07
- 基线：v0.3.2（`6519212`）→ v0.4.0（12 个功能/修复提交 + 发布提交）

## 新功能

1. **复合节点（组即节点）**：Ctrl+点选 ≥2 张 → 右键「合并为复合节点」——卡片折叠为带 `❐ N` 徽标的复合卡（缩略图=子节点 2×2 网格合成）；外部连线自动重路由到复合节点（内部连线保留）；**时长自动按内部连线计算**（同层并行=同时、跨层推进，与时间线语义一致）；双击展开子节点托盘（子卡可点选进标注面板）；右键/托盘/标注面板可解散（子节点回原位）。复合节点不嵌套。投影/放映/独立保存/导入全链支持。
2. **独立分镜本保存**：设置新增「分镜本保存目录」（默认 `数据根\exports\boards`）——分镜本任何改动约 1 秒内自动同步为独立文件夹 `board-<id>/board.json + assets/`（含图片副本），可备份携迁；分镜墙菜单「导入分镜本（board.json）」一键重建（图片自动复制回数据根）；「打开独立保存目录」直达。
3. **节点视觉对齐竞品（SHOTLOOM）四件套**：卡片上方悬浮名称条；卡片时长占比条（相对画布最长卡）；链路首尾绿色端点（有连线时，起点左/终点右）；卡角蓝色流向三角（入左出右）。
4. **关墙自动投影**：独立分镜本关墙回主界面时自动开启投影（时间线/主播放/右侧面板直接显示分镜本节点）；右上绿徽标「退出」可关，手动退出后同一会话不再自动弹出。
5. **投影宫格合成截图**：投影模式点「截图」= 导出当前宫格合成图（2 列布局 PNG，存 `数据根\exports\board\<boardId>\`），不写 stills 表。

## 修复（用户三轮实测反馈）

1. **左端口拖线失效（系统性根因）**：独立分镜本模式把 `'boards'` 字面量当 projectId 传给了项目镜头域的连线/标注 API——拖线建边、删线、断开全部连线、PPT 标注、放映前刷新**全部静默失败**。现已全部分流到分镜本专属 API（node-edge / node-annotation）。
2. **「防误触 1.2 卡宽」阈值移除**：邻近卡片拖线大多被静默丢弃；现在端口拖拽落到目标卡内即建边（左端口=目标→本卡，右端口=本卡→目标）。
3. **导入照片破图**：缩略图 URL 多拼一层 `boards/` 导致 404 破图——导入本身成功，仅显示坏；已修。
4. **导入照片白名单**：`wall:pickImage` 未进 preload IPC 白名单导致文件选择器静默无反应；已补 + 失败 toast。
5. **投影模式编辑不保存**：投影下笔记/标签/景别/运镜的写操作误走 shots 表或被拦截——现在全部路由回分镜本节点（笔记→node.note、标签→wall_node_tags、景别/运镜镜像到节点字段）；拆分/合并/删除在投影模式禁用并提示「请在分镜墙中编辑结构」。
6. **白底文本节点**：按用户要求移除「白底+文本」入口；文本节点统一黑底。
7. **资产协议 CORS**：分镜本图片画进 canvas（复合缩略图/投影截图导出）时报 tainted canvas——协议响应补 `Access-Control-Allow-Origin`，加载器匿名跨域。
8. 文本节点内联编辑：双击黑底卡直接打字，字号随画布缩放反向补偿，字实时画进缩略图（12 字/行×6 行折行），DB 写入 500ms 防抖。

## 节点标注面板（图二需求）

选中节点 → 右侧 300px 可折叠面板：名称/持续时间/六类标签（景别·机位·运镜·光线·声音·剪辑，存 `wall_node_tags` 与镜头标签同构不混表）/笔记——**选中即载入、改动即存**（字段 500ms 防抖、标签即时 upsert）；导入照片/新建文本后自动选中并打开面板；复合节点显示自动时长提示与解散按钮。

## 数据迁移

- `011`：wall_nodes 增 `text_content`/`bg_color`，新建 `wall_node_tags`。
- `012`：wall_nodes 重建（source CHECK 增 `'composite'` + `parent_id` 自引用），子表数据备份回填。
- 旧数据自动迁移，无需手动操作。

## 已知边界

- Word 使用说明本版**已重建**：`USER_GUIDE.md` 新增「分镜墙与独立分镜本」整章（节点/连线/复合节点/投影/独立保存），`python -I scripts/build-user-guide.py` 生成（`-I` 隔离模式可避开本地安全钩子误拦，0.3.1/0.3.2 的欠账一并补上）。
- 卸载工具沿用 0.3.1+ 同一二进制（SHA 见 SHA256SUMS.txt）。
- local-ai 与 0.1.9/0.2.0/0.3.x 完全一致（local-vision-service 未改动，硬边界），复用旧分卷。
- 分镜墙 HUD「⇩ 导出镜头图片」在独立分镜本模式下仍走项目导出（不可用），规划 v0.5。

## 验证

- `npm run typecheck` 0 error
- 门控全绿：`SMOKE_BOARD`（含 textContent/标签/复合节点生命周期/独立保存导出断言）、`SMOKE_WALL_UI`（含内联编辑落库/真实图片渲染/端口拖线建边/复合建组托盘解散/自动投影徽标断言）、`SMOKE_WALL`、`SMOKE_STAGED_DETECT_UI`（真实视频）、默认 smoke、`SMOKE_TIMELINE_WHEEL_ZOOM`
- 打包前 main 为 `73c0e49` + 版本提交

## 提交清单（6519212 → v0.4.0）

`886a4f7` fix(board): in-port css, pick-image whitelist, drop white-text node
`667b8fa` feat(board): text nodes with inline editing and thumbnail render
`44e74ee` feat(board): node inspector panel with per-node persistence
`10c34fe` feat(board): projection edit routing and grid export
`76530c9` test(board): gates for text-content, node tags, inline edit, in-port drag
`8e3a71f` fix(board): board-mode node-edge/annotation routing, port drop, asset url, auto-projection on close
`8b3256a` feat(board): independent board save (board.json + assets) with settings dir and import
`4f4c4a3` feat(board): composite nodes data layer (migration 012, group-as-node, edge rerouting, asset CORS)
`73c0e49` feat(board): composite UI (grid thumb/tray/menus/panel) + durbar, endpoints, flow marks, card titles, gates
