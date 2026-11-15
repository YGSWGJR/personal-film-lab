# S42 ZCode 端测试记录（zcode-test）

> 执行端：PC-B · ZCode；base `e8888bd`；分支 `feat/s42-playback-detect`
> 数据根：`DSH_DATA_ROOT=G:\ai\codex\2026-11-15\s42-test\smoke-data`（隔离，全新建库，迁移链 1~12 从零验证）
> 测试视频：`E:\bilidown_Windows_x86_64\download\正片 FINAL Ver. 1080p全码率 [ElySian-瑋] [高清 1080P+] [36秒] NTM.mp4`（8,870,595B，1920×1080@29.97，35.75s）
> 证据目录：`G:\ai\codex\2026-11-15\s42-test\`

## 一、命令结果汇总

| # | 命令 | 结果 | 证据 |
|---|---|---|---|
| 1 | `npm run typecheck` | 0 error | 终端 |
| 2 | `npm run smoke`（官方） | exit 0，passed | 终端 SMOKE_RESULT |
| 3 | `./scripts/clean-duplicates.ps1 -Check` | 副本数 0 | 终端 |
| 4 | SMOKE_HARDWARE=1 | passed（10/10） | smoke-hardware-playback.json |
| 5 | SMOKE_PLAYBACK_STRESS=1 + SMOKE_VIDEO | passed（50/50） | 同上 |
| 6 | SMOKE_OVERLAY_STRESS=1 | passed（30 轮 0 失败） | smoke-overlay-stress.json |
| 7 | SMOKE_WALL_UI=1（回归） | passed | smoke-wall-ui.json |
| 8 | SMOKE_STAGED_DETECT_UI=1 + SMOKE_VIDEO（回归） | passed（17 镜头自动落库） | smoke-staged.json |

## 二、Z01 Space 播放（对应评分标准 B01）

- 方法：合成 KeyboardEvent(Space) 派发 document.body，250–1000ms 随机间隔 × 50 次；
  `window.__S42_PLAYBACK_LOG__` 记录每次 keydown/toggle-request/toggle-applied。
- 结果：pressed=50，applied=50，failed=0；最终 paused=true 与偶数次一致；scrollY=0；
  layer=normal。
- 结论：无失效、无状态倒置、无滚页。（B02 弹层让位：残留导入向导打开时按键不触发播放，
  由诊断轮次实证——见 §四 问题 1）

## 三、Z02 原生窗口（对应 E01/E02 本端部分）

- 方法：真实项目 + 分镜墙钩子，Esc 关闭 → openWall 重开 × 30 轮；每 6 轮主窗口
  setBounds 变更一次（1280×800→1440×900→1600×900→1366×768→1600×900）。
- 结果：openFailures=0，closeFailures=0；收尾 wallClosed=true、finalLayerNormal=true、
  video-slot 在位。DSH_PLAYER_DEBUG 未启用（门控走断言；调试日志链路代码在位，按需开启）。
- 说明：trackHeight 全档位遍历由 SMOKE_WALL_UI 与既有 timeline 门控覆盖控件行为；
  HWND 级 100 次 resize 压力中 5 次真实窗口 resize 由本门控覆盖，其余以 bounds 原子迁移
  + 串行队列的代码路径为保证，如实记录为"部分覆盖"。

## 四、测试中发现的问题与处置

1. **[非缺陷] Space 50 连按第一轮 applied=0**
   - 现象：压力脚本 50 次空格全部无响应，诊断显示按键到达 window 捕获阶段但 App 处理器
     未执行。
   - 根因：隔离数据根为空而 session.json 引用旧项目 → 启动导入向导自动打开 →
     `overlayOpen=true` → 空格按设计让位（正是 Z01 要求的弹层让位行为）。
   - 处置：测试脚本按键前 Esc×3 清场；产品行为正确，不改代码。
2. **[非缺陷] overlay 压力收尾 finalLayerNormal=false**
   - 根因：关墙后 layer 恢复是异步 IPC，脚本 0ms 后读状态读到旧值。
   - 处置：脚本加 600ms 落定等待后稳定通过；产品时序无问题。
3. **[已修] smoke whitelistOnly 断言未含 hardware 域** — 更新断言字符串。

## 五、Z03 检测（对应 F01/F02/F04 本端部分）

- SMOKE_STAGED_DETECT_UI 用真实 36s 视频完整跑通边界任务：17 镜头抽帧→TransNetV2/OpenCV
  →缩略图→事务化落库→boundaryApplied；Qwen 未参与；`detect:getJob` 快照含 memory 记录
  （peakRss/framesExtracted/framesCleaned/childProcesses）。
- 取消清理与子进程退出由代码路径保证（cancel → abort → child.kill + framesDir 回退核验），
  专项 10 秒内退出计时未在本轮单独执行——如实标注为待人工复验项。
- 断网不静默上云：`net.isOnline()` 在云端标签链路第一道门（隐私确认之后、请求之前），
  mock 供应商不可冒充云端；未提供云端切分选项。

## 六、Z04 硬件（对应 F03 本端部分）

- 扫描结构：ram/gpu/python/models/network + 四条能力线状态/原因/修复。
- 本机实测（smoke 日志）：`hybrid=ready opencv=ready labelsLocal=vram-insufficient
  labelsCloud=unconfigured online=true`——显存阈值判定与真实占用一致（当前后台占显存），
  unconfigured/断网等状态在 UI 由设置/预检条呈现，禁用项主进程兜底不可绕过。
- 重扫：scan(force) 二次扫描 scannedAt 递增、getStatus 命中缓存（cacheHit=true），无需重启。

## 七、未验证事项（如实登记）

- 云端标签识别端到端真实供应商调用（无 API Key）。
- 检测取消后子进程 10 秒退出计时专项。
- 200%/多显示器 DPI 场景（E04，整合阶段环境具备时补）。
- NSIS 安装版复核（属最终发布阶段）。
- Codex 端组合场景（多视频×检测、静帧×原生窗口）——整合验收。
