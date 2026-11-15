# S42 ZCode 端实施状态（zcode-status）

> 执行端：PC-B · ZCode / GLM 5.3 Flash
> 日期：2026-11-15
> base commit：`e8888bd`（origin/main，与 Codex 开工基线一致）
> 功能分支：`feat/s42-playback-detect`

## 一、任务完成情况

| 任务 | 状态 | 说明 |
|---|---|---|
| Z01 Space 播放偶发失灵 | ✅ 完成 | 已加载文件时空格切换不再被 busy/前次 IPC 吞键：每次按键入串行链，主进程按序返回权威状态，最后一次为准。新增渲染层 `window.__S42_PLAYBACK_LOG__` 环形日志与主进程 DSH_PLAYER_DEBUG 状态日志 |
| Z02 原生视频卡墙与 bounds 防遮挡 | ✅ 完成 | 主进程 overlay 状态迁移串行化 + 原子 hide→bounds→setZ；渲染层 videoSlot 测量改 nextTick + 双 rAF 有界等待；弹层期间 setLayer 只记账不落盘（修"卡墙"根因）；投影模式强制保持隐藏；SetWindowPos 失败回滚层级并报结构化错误 |
| Z03 检测内存治理与模型策略 | ✅ 完成 | 任务级内存记录（peakRss/帧数/子进程/批次数）进 DetectJobSnapshot；帧目录回收核验；Python 子进程 finally 兜底 kill；labelPreviews 上限 8 条、终态任务上限 20 条驱逐；标签策略 local/cloud（云端=OpenAI 兼容供应商，四道门：AI 开关→隐私确认→net.isOnline→真实供应商，mock 不可冒充）；失败按 fallbackToOpenCv 回退本地并在 UI 提示；无"云端切分"选项（边界永远本机） |
| Z04 硬件自动扫描与设置界面 | ✅ 完成 | 新 `HardwareCapabilityService`：RAM/nvidia-smi 显存/内置 Python+cv2+numpy+onnxruntime/TransNetV2+Qwen 模型文件/网络；四条能力线（混合边界/OpenCV 边界/本地标签/云端标签）均为五类结构化状态+原因+修复指引；60s 缓存 + force 重扫（不重启生效）；启动后 3s 延迟预热；IPC `hardware:scan/status` + preload 白名单 + SettingsModal 硬件区块 + DetectionModal 预检条 |

## 二、修改文件清单

**新增**
- `src/main/ai/cloud-vision-labels.ts` — 云端标签契约（提示词/data URL 编码/结果规整）
- `src/main/hardware/hardware-capability-service.ts` — 硬件能力扫描服务
- `docs/handoff/s42/zcode-status.md` / `zcode-decisions.md` / `zcode-test.md`

**修改**
- 共享：`src/shared/types.ts`（LabelStrategy/RecognitionSettings 扩展/DetectJobMemory/Hardware* 全套类型/WindowApi.hardware）、`schemas.ts`（recognition.labelStrategy/cloudLabelsAck + hardwareScanArgsSchema）、`ipc-channels.ts`（HARDWARE_SCAN/STATUS）
- 主进程：`player/player-service.ts`、`player/native-overlay.ts`、`settings/settings-service.ts`、`paths.ts`、`ai/provider.ts`（analyzeImages）、`detect/detect-service.ts`、`ipc/index.ts`、`index.ts`（硬件服务实例化+预热）、`smoke.ts`（三个新门控）
- preload：`src/preload/index.ts`（hardware 域白名单）
- 渲染层：`App.vue`（togglePlayback 串行链/playbackDebugLog/setPlayerLayer 门控/projectedMode watch/硬件状态/标签预检/labels 回退提示）、`PlayerWorkspace.vue`（稳定 bounds）、`DetectionModal.vue`（预检条）、`SettingsModal.vue`（标签策略 + 隐私确认 + 硬件区块 + 重扫）

## 三、验证命令与结果

```powershell
npm run typecheck                    # 0 error
npm run smoke                        # exit 0（官方命令）
./scripts/clean-duplicates.ps1 -Check # 副本数 0
```

新增门控（`DSH_DATA_ROOT=G:\ai\codex\2026-11-15\s42-test\smoke-data`）：

| 门控 | 结果 | 证据 |
|---|---|---|
| SMOKE_HARDWARE=1 | passed | smoke-hardware-playback.json（10/10 项，四线状态/重扫/缓存/探测） |
| SMOKE_PLAYBACK_STRESS=1（SMOKE_VIDEO=36s NTM.mp4） | passed | Space 50/50 全部生效、0 失败、奇偶一致、无滚页、layer=normal |
| SMOKE_OVERLAY_STRESS=1 | passed | 分镜墙 30 轮开关 0 失败 + 5 次窗口 resize，收尾 layer=normal、槽位在位 |
| SMOKE_WALL_UI=1（回归） | passed | smoke-wall-ui.json |
| SMOKE_STAGED_DETECT_UI=1（回归，真实 36s 视频） | passed | 17 镜头自动落库、Qwen 未参与、人工保护存活 |

结果文件目录：`G:\ai\codex\2026-11-15\s42-test\`。

## 四、关键实现决策

见 `zcode-decisions.md`。

## 五、遗留风险

1. **云端标签识别未做真实供应商联调**：请求构造/结果规整有纯函数与 mock 化结构校验，但本端无可用 API Key 做端到端调用；断网/未确认/未配置三条门有主进程+UI 双重拦截。
2. **显存阈值 6000MB 为经验值**：Qwen3-VL W4A8 8B 在 8GB 卡可用；若用户后台占用显存会报 vram-insufficient（本机实测当前即此状态，属真实反映）。
3. **onnxruntime 预检仅内置 Python 生效**：外置 Python（DSH_PYTHON 覆盖）在运行期由 S39 链路自动回退并告警，设置页显示 ort=✗ 但不阻塞 hybrid 判定。
4. **多视频/静帧列表等 Codex 端组合场景**未测（整合验收范围）；本端未修改 StoryboardWall/TimelineEditor/静帧与迁移组件。
5. SMOKE_OVERLAY_STRESS 首轮若遇会话导入向导自启（空数据根+旧 session），轮内首个 Esc 会先关向导——测试脚本已兼容，属正常让位行为而非缺陷。

## 六、交接

- 分支已推送：`feat/s42-playback-detect`（提交清单见 git log）。
- 未生成安装包；未动 main；未改写历史。
- 整合按任务书 §六：`integrate/s42-v050` 按 project-media → playback-detect 顺序合并。
