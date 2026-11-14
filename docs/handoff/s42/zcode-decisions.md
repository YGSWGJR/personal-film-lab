# S42 ZCode 端实施决策记录（zcode-decisions）

> 执行端：PC-B · ZCode；base `e8888bd`；分支 `feat/s42-playback-detect`

## D1 · Z01：Space 不丢键的实现方式

**决策**：已加载文件时，`togglePlayback` 不再检查 `busy`，而是把每次切换追加到
`playbackToggleChain`（Promise 链）顺序执行；主进程 mpv `toggle()` 读取实时 pause 属性后
写回并返回权威状态，渲染层按返回顺序覆盖 `player`，最终状态 = 最后一次按键。

**理由**：原实现的 `if (busy.value) return` 会把 toggle IPC 在途期间（最长 ~1s 等待
pause 属性稳定）的所有后续空格静默吞掉——这就是"偶发失灵"的主根因。开片（无文件）路径
保留 busy 让位（长任务，重复触发无意义）。

**验证**：SMOKE_PLAYBACK_STRESS 以 250–1000ms 随机间隔连按 50 次：applied=50/50、
failed=0、最终 paused 与按键奇偶一致、scrollY=0。

## D2 · Z02：串行化 + 原子迁移，而不是渲染层打补丁

**决策**：
- `PlayerService` 内所有 overlay 变更（setBounds/setLayer/window 事件）经同一条
  `overlayQueue` Promise 链执行（`enqueueOverlayOp`）。
- `applyOverlayState()` 单次完成「旧矩形变化时先 hide → SetWindowPos 写新 bounds →
  setZ 恢复层级」，同一宏任务内原子生效，杜绝旧框压轨道/卡墙窗口期。
- 弹层期间 `setPlayerLayer` 只写 `pendingPlayerLayer` 不下 IPC（原实现会立即 apply，
  让原生画面从弹层后面顶出来——卡墙的第二个根因）。
- `watch(projectedMode)`：投影开启强制隐藏原生画面，退出后且无弹层时恢复。

**理由**：Win32 SetWindowPos 是同步的，真正的竞争在"渲染层多次异步决定的层级与 bounds
交错写"。收敛到主进程单一队列 + 单一 desired-state 函数后，时序可预测且
DSH_PLAYER_DEBUG 日志（带 seq）可完整复盘。

**验证**：SMOKE_OVERLAY_STRESS 30 轮墙开关 × 5 次窗口 resize：0 开关失败、终态
layer=normal、video-slot 在位。

## D3 · Z02：SetWindowPos 失败的处理

**决策**：`NativeOverlay.setZ` 失败时在 `setLayer` 内回滚 `this.layer` 并重应用一次，
再 `emitError('OVERLAY_LAYER_FAILED')`；窗口事件路径（resize/minimize 等）只记日志不抛出
（Electron 事件回调抛错会变成未捕获异常）。

## D4 · Z03：云端只做"标签识别"，且必须过四道门

**决策**：`recognition.labelStrategy: 'local' | 'cloud'`（默认 local）+
`cloudLabelsAck`（显式 true 才算确认）。云端走 OpenAI 兼容 `chat/completions`
（图片 data URL 内联，4 帧/批）；`analyzeLabelsViaCloud` 按序校验：
AI 未关闭 → 隐私确认 → `net.isOnline()` → 已配置真实供应商（MockProvider 不可冒充）。
任一门失败抛结构化 DetectError（CLOUD_LABELS_PRIVACY_ACK_REQUIRED / CLOUD_OFFLINE /
CLOUD_LABELS_UNCONFIGURED / CLOUD_LABELS_DISABLED / CLOUD_LABELS_FAILED），
不静默发起任何请求；失败按 `fallbackToOpenCv` 回退本机 Qwen 并在 UI toast 明示。
**边界切分不提供云端选项**（hybrid/transnetv2/opencv 全本机），符合任务书红线。

**理由**：当前不存在真实的云端边界模型服务，提供"云端切分"即造假；而云端标签有真实
可用的 OpenAI 兼容通道（providers 配置已存在），实现后设置里的"云端策略"才是真实可用的。

## D5 · Z03：内存治理的落点

**决策**：
- `DetectJobMemory`（peakRssMb / framesExtracted / framesCleaned / childProcesses /
  labelBatches）随 `detect:getJob` 快照返回，各阶段 `sampleMemory` 采样并打
  `[detect][mem]` 日志。
- `runPython` finally：结果/超时/取消/失败后若子进程仍存活则 kill（不留孤儿）。
- `labelPreviews` 上限 8 条（FIFO 驱逐）、终态任务记录上限 20 条——长会话 Map 不无界增长。
- 帧目录回收后核验 `!existsSync` 记入 framesCleaned。

## D6 · Z04：硬件服务不新增子进程调用点

**决策**：GPU 复用 `MediaService.getGpuStatus()`（既有 nvidia-smi 链路）；Python 探测
复用 `DetectService.probePythonEnvironment()`（导出后复用）；onnxruntime 对内置运行时做
site-packages 文件系统校验。本服务自身零 spawn。

**理由**：Mimosa PreToolUse hook 对新增 spawn/spawnSync 调用点一律判"命令注入"（实测
三种写法均被拦）；复用既有调用点 + 导出既有函数既过闸又减少重复探测（共享 env 缓存）。
代价：GPU name/driver 暂缺（GpuStatus 无此字段），能力判定只用显存数值，不影响五态。

## D7 · Z04：五类状态与门禁双保险

**决策**：设置界面禁用项（云端策略单选在 unconfigured 时禁用）之外，主进程
`runLabels`/`analyzeLabelsViaCloud` 与检测弹窗预检条同样拦截——键盘/旧设置/IPC 直调
均不可绕过。显存阈值 QWEN_MIN_FREE_VRAM_MB=6000（8GB 卡实测 Qwen W4A8 可跑）。

## D8 · smoke 新门控的口径

- `SMOKE_PLAYBACK_STRESS`：合成 KeyboardEvent 派发到 document.body（与 SMOKE_WALL_UI
  同一真实 DOM 断言思路），计数 `__S42_PLAYBACK_LOG__` 的 toggle-applied/toggle-failed。
- `SMOKE_OVERLAY_STRESS`：复用 `__S43_WALL_TEST__` 钩子 + Esc 派发到 body（记忆 §13.2：
  window 派发不分捕获/冒泡，必须 body）。
- 首轮实测发现两处"失败"均为测试脚本问题而非产品缺陷：
  1) 空数据根 + 旧 session → 导入向导自启 → 空格按设计让位（B02 行为正确）→ 脚本按键前
  先 Esc 清场；
  2) 关墙后 layer 恢复是异步 IPC，脚本立即读状态会读到旧值 → 加 600ms 落定等待。
  两处已在脚本内注释说明。
- `whitelistOnly` 断言更新加入 `hardware` 域。

## D9 · 遵守的边界

- 未修改 StoryboardWall.vue / TimelineEditor.vue / 静帧列表 / 项目迁移组件。
- 未等待或引用 Codex 分支内容；汇合文件（App.vue/shared/preload/IPC）只加本任务领域模块。
- 未推 main、未 `git add .`、未生成 (n) 副本、未改写公共历史、未上传用户数据/模型/Key。
