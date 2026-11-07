/**
 * 主进程 / preload / 渲染层共享的类型（docs/S01 §7）。
 * 本文件只允许放类型与常量，禁止引入 Node / Electron 依赖。
 */

/** 应用信息（S01 §6.2 app:info 返回） */
export interface AppInfo {
  version: string;
  platform: string;
  appDataPath: string;
}

export type ProxyTier = '360p' | '540p' | '720p';

/** 时间线轨道缩放档位（S36-3）：轨道高度 px 与横向密度 px/s。 */
export interface TimelineSettings {
  trackHeight: number;
  pxPerSecond: number;
}

export interface ShortcutSettings {
  split: string;
  merge: string;
}

/** S36-2：镜头识别引擎。 */
export type RecognitionEngine = 'ai' | 'opencv';

/** S39：镜头边界引擎。与 RecognitionEngine 分离，后者继续控制 Qwen 语义标注。 */
export type ShotBoundaryEngine = 'hybrid' | 'transnetv2' | 'opencv';

export interface RecognitionSettings {
  engine: RecognitionEngine;
}

/** S36-7：单个 AI 检测供应商配置。apiKey 为 safeStorage 密文。 */
export interface AiProviderConfig {
  id: string;
  name: string;
  note?: string;
  homeUrl?: string;
  baseUrl: string;
  apiKey?: string;
  /** 显式默认模型；空 = 探测自动选 */
  model?: string;
  /** 获取/手动添加的模型列表 */
  models?: string[];
}

export interface AiListModelsResult {
  ok: boolean;
  models?: string[];
  error?: { code: string; message: string };
}

/** S36-2：AI 识别配置（apiKey 在 settings.json 中为 safeStorage 密文）。 */
export interface AiSettings {
  provider?: 'local' | 'openai-compatible' | 'mock';
  /** S36-7：多供应商列表（mock 不进此列表） */
  providers?: AiProviderConfig[];
  /** S36-7：当前激活供应商 id */
  activeProviderId?: string;
  /** legacy 兼容字段；保存 providers 后清空 */
  baseUrl?: string;
  apiKey?: string;
  agentEndpoint?: string;
  segmentSeconds?: number;
  segmentOverlapSeconds?: number;
  timeoutSeconds?: number;
  maxRetriesPerSegment?: number;
  enabled?: boolean;
  /** 本地视觉识别失败时是否自动保留 OpenCV 镜头切分结果。 */
  fallbackToOpenCv?: boolean;
  /** 本地视觉分析每批图片数量。 */
  localBatchSize?: number;
}

export interface LocalAiStatus {
  available: boolean;
  running: boolean;
  engine: 'qwen3vl-8b-w4a8';
  pythonPath: string | null;
  comfyRoot: string | null;
  modelPath: string | null;
  error: string | null;
}

/** S36-3a：轨道高度档位（px）；S37 起支持折叠到 1px。 */
export const TRACK_HEIGHT_LEVELS: readonly number[] = [1, 48, 96, 144, 192, 240];

/** S36-3b：横向时间密度 6 档（px/s）。 */
export const PX_PER_SEC_LEVELS: readonly number[] = [24, 48, 96, 192, 384, 768];

/** 将任意值吸附到最近档位（纯函数，供时间线组件与主进程设置规范化共用）。 */
export function snapToLevel(value: number, levels: readonly number[]): number {
  if (levels.length === 0) return value;
  let nearest = levels[0];
  for (const level of levels) {
    if (Math.abs(level - value) < Math.abs(nearest - value)) nearest = level;
  }
  return nearest;
}

export interface Settings {
  dataRoot: string;
  cacheDir: string;
  exportDir: string;
  stillDir: string;
  proxyCacheDir?: string;
  frameCacheDir?: string;
  waveformCacheDir?: string;
  thumbCacheDir?: string;
  exportSubDir?: string;
  stillSubDir?: string;
  /** settings.json 的实际位置，用于保存成功后的用户确认 */
  settingsPath?: string;
  /** DSH_DATA_ROOT 环境变量生效时，路径设置被环境覆盖 */
  environmentOverride: boolean;
  proxyTier?: ProxyTier;
  /** 删除用户内容（镜头/静帧/标签/术语）前是否二次确认，默认 true（S36-1） */
  confirmUserContent?: boolean;
  /** 时间线轨道缩放（S36-3），缺省走 defaultSettings 默认档 */
  timeline?: TimelineSettings;
  /** 识别引擎（S36-2），缺省 ai */
  recognition?: RecognitionSettings;
  /** AI 识别配置（S36-2） */
  ai?: AiSettings;
  /** S40：镜头编辑快捷键 */
  shortcuts?: ShortcutSettings;
  /** S43：分镜墙视图状态（scale/pan 按项目分组），存 settings.json 不进库 */
  wallViewState?: Record<string, WallViewState>;
}

export interface SettingsSetArgs {
  dataRoot: string;
  cacheDir: string;
  exportDir: string;
  stillDir: string;
  proxyCacheDir?: string;
  frameCacheDir?: string;
  waveformCacheDir?: string;
  thumbCacheDir?: string;
  exportSubDir?: string;
  stillSubDir?: string;
  proxyTier?: ProxyTier;
  /** 删除用户内容前是否二次确认，缺省 true（S36-1） */
  confirmUserContent?: boolean;
  /** 时间线轨道缩放（S36-3），缺省走 defaultSettings 默认档 */
  timeline?: TimelineSettings;
  /** 识别引擎（S36-2），缺省 ai */
  recognition?: RecognitionSettings;
  /** AI 识别配置（S36-2） */
  ai?: AiSettings;
  /** S40：镜头编辑快捷键 */
  shortcuts?: ShortcutSettings;
  /** S43：分镜墙视图状态（与 Settings 同形） */
  wallViewState?: Record<string, WallViewState>;
}

export interface SettingsChooseDirectoryArgs {
  title?: string;
  defaultPath?: string;
}

export type AiTaskId =
  | 'continuity'
  | 'notes'
  | 'export-summary'
  | 'terminology'
  | 'visual-description';

export interface AiSnapshotShot {
  id: string;
  index: number;
  startMs: number;
  endMs: number;
  durationMs: number;
  shotSize: string | null;
  cameraMethod: string | null;
  dialogue: string | null;
  remark: string | null;
  tagIds: string[];
  tags: Record<string, string[]>;
  note: string | null;
  noteLength: number;
  origin: 'auto' | 'manual';
  locked: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface AiProjectSnapshot {
  project: {
    id: string;
    name: string;
    filename: string | null;
    container: string | null;
    durationMs: number;
    width: number | null;
    height: number | null;
    fps: number | null;
    videoCodec: string | null;
    audioCodec: string | null;
    shotCount: number;
  };
  shots: AiSnapshotShot[];
  generatedAt: string;
}

export interface AiContinuityCandidate {
  fromShotId: string;
  fromShotIndex: number;
  toShotId: string;
  toShotIndex: number;
  reasons: string[];
}

export interface AiCopyPromptArgs {
  projectId: string;
  tasks: AiTaskId[];
}

export interface AiCopyPromptResult {
  copied: true;
  characters: number;
}

export interface AiMcpStatus {
  enabled: boolean;
  running: boolean;
  command: string;
  port: number | null;
  error: string | null;
}

export interface AiMcpAuthRequest {
  requestId: string;
  agentName: string;
  action: string;
  detail: string;
  createdAt: string;
}

export interface AiMcpAuthResponseArgs {
  requestId: string;
  allowed: boolean;
  remember: boolean;
}

export interface AiMcpDataChangedEvent {
  projectId: string;
  shotId: string;
}

export interface AiApi {
  copyPrompt(args: AiCopyPromptArgs): Promise<IpcResult<AiCopyPromptResult>>;
  getShotSnapshot(args: { projectId: string }): Promise<IpcResult<AiProjectSnapshot>>;
  getLocalStatus(): Promise<IpcResult<LocalAiStatus>>;
  /** S36-2a：探测 API 端点能力（是否支持原生视频输入）。 */
  probeProvider(args?: { baseUrl?: string; apiKey?: string; providerId?: string }): Promise<IpcResult<AiProviderProbeResult>>;
  /** S36-7：获取供应商端点模型列表。 */
  listModels(args: { providerId?: string; baseUrl?: string; apiKey?: string }): Promise<IpcResult<AiListModelsResult>>;
  startMcp(args: { enabled: boolean }): Promise<IpcResult<AiMcpStatus>>;
  getMcpStatus(): Promise<IpcResult<AiMcpStatus>>;
  onMcpAuthRequest(listener: (request: AiMcpAuthRequest) => void): () => void;
  respondMcpAuth(args: AiMcpAuthResponseArgs): Promise<IpcResult<{ responded: boolean }>>;
  onDataChanged(listener: (event: AiMcpDataChangedEvent) => void): () => void;
}

export interface SettingsDataRootChangingEvent {
  previousRoot: string;
  nextRoot: string;
  projectCount: number;
}

export interface SettingsMigrationPreview {
  root: string;
  projects: CandidateProject[];
}

export interface SettingsMigrationConfirmArgs {
  projectIds: string[];
}

export interface SettingsMigrationResult {
  imported: Project[];
  skipped: string[];
}

export interface CandidateProject {
  id: string;
  name: string;
  shotCount: number;
  updatedAt: string;
}

export interface CandidateSource {
  root: string;
  projects: CandidateProject[];
}

export interface ImportResult {
  project: Project;
  imported: boolean;
  reason: 'imported' | 'already-exists';
}

export interface SettingsApi {
  get(): Promise<IpcResult<Settings>>;
  set(args: SettingsSetArgs): Promise<IpcResult<Settings>>;
  chooseDirectory(args: SettingsChooseDirectoryArgs): Promise<IpcResult<string | null>>;
  previewMigration(): Promise<IpcResult<SettingsMigrationPreview>>;
  confirmMigration(args: SettingsMigrationConfirmArgs): Promise<IpcResult<SettingsMigrationResult>>;
  skipMigration(): Promise<IpcResult<Settings>>;
  cancelMigration(): Promise<IpcResult<Settings>>;
  onDataRootChanging(listener: (event: SettingsDataRootChangingEvent) => void): () => void;
}

export interface DataApi {
  scanCandidates(): Promise<IpcResult<CandidateSource[]>>;
  importProject(args: { root: string; projectId: string }): Promise<IpcResult<ImportResult>>;
}

/** S43：分镜墙画布一期 */
export interface WallApi {
  getLayout(args: WallGetLayoutArgs): Promise<IpcResult<WallLayoutItem[]>>;
  saveLayout(args: WallSaveLayoutArgs): Promise<IpcResult<void>>;
  listEdges(args: WallEdgeListArgs): Promise<IpcResult<WallEdge[]>>;
  addEdge(args: WallEdgeAddArgs): Promise<IpcResult<WallEdge>>;
  removeEdge(args: WallEdgeRemoveArgs): Promise<IpcResult<void>>;
  listGroups(args: WallEdgeListArgs): Promise<IpcResult<WallGroup[]>>;
  createGroup(args: WallGroupCreateArgs): Promise<IpcResult<WallGroup>>;
  dissolveGroup(args: WallGroupDissolveArgs): Promise<IpcResult<void>>;
  listAnnotations(args: WallAnnotationListArgs): Promise<IpcResult<Record<string, WallAnnotation[]>>>;
  saveAnnotations(args: WallAnnotationSaveArgs): Promise<IpcResult<void>>;
  exportImages(args: WallExportArgs): Promise<IpcResult<WallExportResult>>;
  listBoards(): Promise<IpcResult<WallBoardInfo[]>>;
  createBoard(args: WallBoardCreateArgs): Promise<IpcResult<{ id: string }>>;
  deleteBoard(args: WallBoardDeleteArgs): Promise<IpcResult<void>>;
  renameBoard(args: WallBoardRenameArgs): Promise<IpcResult<void>>;
  listNodes(args: WallNodeListArgs): Promise<IpcResult<WallBoardNodeInfo[]>>;
  addNode(args: WallNodeAddArgs): Promise<IpcResult<WallBoardNodeInfo>>;
  updateNode(args: WallNodeUpdateArgs): Promise<IpcResult<WallBoardNodeInfo>>;
  deleteNode(args: WallNodeDeleteArgs): Promise<IpcResult<void>>;
  listNodeEdges(args: WallNodeEdgeListArgs): Promise<IpcResult<WallEdge[]>>;
  addNodeEdge(args: WallNodeEdgeAddArgs): Promise<IpcResult<void>>;
  removeNodeEdge(args: WallNodeEdgeRemoveArgs): Promise<IpcResult<void>>;
  listNodeAnnotations(args: WallNodeAnnotationListArgs): Promise<IpcResult<Record<string, WallAnnotation[]>>>;
  saveNodeAnnotations(args: WallNodeAnnotationSaveArgs): Promise<IpcResult<void>>;
  importImage(args: WallImportImageArgs): Promise<IpcResult<WallImportImageResult>>;
  pickImage(): Promise<IpcResult<WallPickImageResult>>;
}

export interface WorkspaceState {
  projectId: string | null;
  timeMs: number;
  selectedShotId: string | null;
  leftCollapsed: boolean;
  rightCollapsed: boolean;
  volume: number;
  shotScrollTop?: number;
}

export interface SessionApi {
  get(): Promise<IpcResult<WorkspaceState | null>>;
  save(state: WorkspaceState): Promise<IpcResult<WorkspaceState>>;
  clear(): Promise<IpcResult<{ cleared: true }>>;
}

/** IPC 错误体（S01 §6.1） */
export interface IpcError {
  code: string;
  message: string;
  /** 可选诊断信息（媒体任务失败时带 stderr / exitCode / command 等） */
  details?: Record<string, unknown>;
}

/** 统一返回信封（S01 §6.1） */
export type IpcResult<T> = { ok: true; data: T } | { ok: false; error: IpcError };

/** 播放器加载媒体后的基础信息（player:open 返回） */
export interface MediaInfo {
  path: string;
  durationMs: number;
  width: number;
  height: number;
  fps: number;
}

/** 媒体探测结果（media:probe 返回；字段与 S01 §7.1 Project.media 对齐） */
export interface MediaProbeResult extends MediaInfo {
  filename: string;
  container: string;
  videoCodec: string | null;
  audioCodec: string | null;
  bitrate: number | null;
  sizeBytes: number;
  hasVideo: boolean;
  hasAudio: boolean;
}

export type OverlayLayer = 'normal' | 'bottom' | 'hidden';

export const PLAYBACK_SPEEDS = [0.5, 1, 1.5, 2] as const;
export type PlaybackSpeed = (typeof PLAYBACK_SPEEDS)[number];

/** 播放器状态（player:getState / player:event:state） */
export interface PlayerState {
  hasFile: boolean;
  timeMs: number;
  durationMs: number;
  paused: boolean;
  ended: boolean;
  volume: number;
  speed: PlaybackSpeed;
  width: number;
  height: number;
  fps: number;
  layer: OverlayLayer;
}

/** 当前帧信息（player:getFrame / player:frameStep 返回） */
export interface FrameInfo {
  frame: number;
  timeMs: number;
  durationMs: number;
  fps: number;
}

/** 渲染区域（CSS 像素，相对渲染层视口左上角） */
export interface RenderBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** 事件载荷 */
export interface PlayerTimeEvent {
  timeMs: number;
}

export interface PlayerErrorEvent {
  code: string;
  message: string;
}

export interface PlayerOpenArgs {
  mediaPath?: string;
  projectId?: string;
}

/** ---------- MediaService（S01 §5.2） ---------- */

export type FrameFormat = 'jpg' | 'jpeg' | 'png';

export type TranscodeQueueState = 'waiting' | 'running' | 'done' | 'failed' | 'cancelled';

export interface TranscodeQueueItem {
  jobId: string;
  sourcePath: string;
  hash: string;
  state: TranscodeQueueState;
  percent: number;
  message: string;
  encoderUsed?: string;
  startedAt?: number;
}

/** 媒体长任务进度（media:event:progress） */
export interface MediaProgressEvent {
  jobId: string;
  stage: 'transcode' | 'extractFrames';
  /** 0..100，整数 */
  percent: number;
  message: string;
  queueState?: TranscodeQueueState;
  gpu?: GpuStatus;
}

export interface MediaProbeArgs {
  path: string;
  /** 默认 30s */
  timeoutMs?: number;
}

export interface ExtractFrameArgs {
  path: string;
  timeMs: number;
  /** 缺省时落到 userData/lapian/frames/ 下 */
  outputPath?: string;
  format?: FrameFormat;
  /** JPG 质量，1（最好）..31（最差），默认 2 */
  quality?: number;
  /** 解码硬件加速：默认 auto，优先 cuda，其次 d3d11va */
  hwaccel?: 'auto' | 'cuda' | 'd3d11va' | 'none';
  /** 默认 60s */
  timeoutMs?: number;
}

export interface ExtractFrameResult {
  path: string;
  requestedTimeMs: number;
  width: number;
  height: number;
  sizeBytes: number;
  elapsedMs: number;
}

export interface ExtractFramesArgs {
  path: string;
  outputDir: string;
  /** 抽帧间隔（毫秒），最小 50 */
  intervalMs: number;
  startMs?: number;
  /** 缺省到影片结尾 */
  endMs?: number;
  format?: FrameFormat;
  prefix?: string;
  /** JPG 质量，1..31，默认 3 */
  quality?: number;
  /** 最大帧数保护，默认 5000，硬上限 20000 */
  maxFrames?: number;
  /** 默认 30 分钟 */
  timeoutMs?: number;
}

export interface ExtractedFrameInfo {
  index: number;
  timeMs: number;
  path: string;
  sizeBytes: number;
}

export interface ExtractFramesResult {
  outputDir: string;
  frames: ExtractedFrameInfo[];
  count: number;
  intervalMs: number;
  startMs: number;
  endMs: number;
  elapsedMs: number;
}

export interface TranscodeProxyArgs {
  sourcePath: string;
  /** 缺省为 userData/lapian/proxies/<原名>-proxy.mp4；绝不覆盖源文件 */
  outputPath?: string;
  /** 兼容旧调用：仅用于 auto 分辨率模式的目标高度上限 */
  maxHeight?: number;
  /** 兼容旧调用；当前代理编码参数由编码器策略决定 */
  crf?: number;
  /** 兼容旧调用；当前代理编码参数由编码器策略决定 */
  preset?: string;
  /** 强制指定编码器名，仅用于调试/测试 */
  encoder?: string;
  /** 代理档位：极速/均衡/画质，默认 balanced */
  proxyMode?: 'fast' | 'balanced' | 'quality';
  /** 代理分辨率：auto 走档位规则，显式档覆盖自动规则，默认 auto */
  proxyResolution?: 'auto' | 'p240' | 'p360' | 'p540' | 'p720' | 'p1080';
  /** S33-4：用户代理档位，参与缓存身份，默认 540p */
  tier?: ProxyTier;
  /** 默认 60 分钟 */
  timeoutMs?: number;
}

export interface TranscodeProxyResult {
  sourcePath: string;
  outputPath: string;
  sourceSizeBytes: number;
  sizeBytes: number;
  durationMs: number;
  width: number;
  height: number;
  elapsedMs: number;
  /** 实际使用的编码器名，如 h264_nvenc / libx264 */
  encoderUsed: string;
  /** 最终是否使用硬件编码器 */
  hardwareAccelerated: boolean;
  /** 硬编初始化/执行失败后回退软编时的原因 */
  fallbackReason?: string;
  /** 源音频是否直接复制而未重编码 */
  audioCopied: boolean;
  /** 是否命中已有代理缓存 */
  cached: boolean;
}

export interface CancelJobArgs {
  jobId: string;
}

export interface CancelJobResult {
  jobId: string;
  cancelled: boolean;
}

/** preload 暴露给渲染层的 window.api 契约（按域组织，S01 §3.2 / §6.2） */
export interface AppApi {
  getInfo(): Promise<IpcResult<AppInfo>>;
}

export interface PlayerApi {
  open(args: PlayerOpenArgs): Promise<IpcResult<MediaInfo>>;
  openDialog(): Promise<IpcResult<MediaInfo | null>>;
  close(): Promise<IpcResult<void>>;
  play(): Promise<IpcResult<PlayerState>>;
  pause(): Promise<IpcResult<PlayerState>>;
  toggle(): Promise<IpcResult<PlayerState>>;
  seek(args: { timeMs: number; exact?: boolean }): Promise<IpcResult<PlayerState>>;
  frameStep(args: { dir: 1 | -1 }): Promise<IpcResult<FrameInfo>>;
  getState(): Promise<IpcResult<PlayerState>>;
  getFrame(): Promise<IpcResult<FrameInfo>>;
  setVolume(args: { volume: number }): Promise<IpcResult<PlayerState>>;
  getSpeed(): Promise<IpcResult<number>>;
  setSpeed(args: { rate: number }): Promise<IpcResult<PlayerState>>;
  setBounds(bounds: RenderBounds): Promise<IpcResult<void>>;
  setLayer(args: { level: OverlayLayer }): Promise<IpcResult<PlayerState>>;
  onState(listener: (state: PlayerState) => void): () => void;
  onTime(listener: (event: PlayerTimeEvent) => void): () => void;
  onLoaded(listener: (info: MediaInfo) => void): () => void;
  onError(listener: (event: PlayerErrorEvent) => void): () => void;
}

export interface MediaApi {
  probe(args: MediaProbeArgs): Promise<IpcResult<MediaProbeResult>>;
  extractFrame(args: ExtractFrameArgs): Promise<IpcResult<ExtractFrameResult>>;
  extractFrames(args: ExtractFramesArgs): Promise<IpcResult<ExtractFramesResult>>;
  transcodeProxy(args: TranscodeProxyArgs): Promise<IpcResult<TranscodeProxyResult>>;
  cancelJob(args: CancelJobArgs): Promise<IpcResult<CancelJobResult>>;
  queueList(): Promise<IpcResult<TranscodeQueueItem[]>>;
  setTranscodeConcurrency(args: { concurrency: 1 | 2 | 4 }): Promise<IpcResult<{ concurrency: number }>>;
  onProgress(listener: (event: MediaProgressEvent) => void): () => void;
}

export interface GpuStatus {
  available: boolean;
  utilizationPercent: number | null;
  encoderPercent: number | null;
  memoryUsedMiB: number | null;
  memoryTotalMiB: number | null;
  updatedAt: string;
}

export interface GpuApi {
  getStatus(): Promise<IpcResult<GpuStatus>>;
}

export interface AudioWaveformBucket {
  startMs: number;
  peak: number;
  rms: number;
}

export interface AudioWaveform {
  buckets: AudioWaveformBucket[];
  bucketMs: number;
  totalMs: number;
}

export interface ScopeExtractAudioWaveformArgs {
  path: string;
  /** 可选的低码率代理文件；存在且有效时优先用于解码，缓存键仍使用 path */
  proxyPath?: string;
  bucketMs?: number;
}

export interface WindowApi {
  app: AppApi;
  settings: SettingsApi;
  session: SessionApi;
  player: PlayerApi;
  media: MediaApi;
  gpu: GpuApi;
  scope: ScopeApi;
  project: ProjectApi;
  shot: ShotApi;
  still: StillApi;
  tag: TagApi;
  note: NoteApi;
  term: TermApi;
  export: ExportApi;
  data: DataApi;
  detect: DetectApi;
  stats: StatsApi;
  ai: AiApi;
  wall: WallApi;
}
/** ---------- 数据层（S01 §7 / §7.4） ---------- */

export interface ProjectSource {
  type: 'local' | 'url';
  path: string | null;
  url: string | null;
  platform: string | null;
}

export interface ProjectMedia {
  filename: string | null;
  container: string | null;
  durationMs: number;
  width: number | null;
  height: number | null;
  fps: number | null;
  videoCodec: string | null;
  audioCodec: string | null;
  sizeBytes: number | null;
  proxyPath: string | null;
}

export interface DetectWeights {
  s?: number;
  c?: number;
  h?: number;
  hv?: number;
  edge?: number;
  grid?: number;
}

export interface DetectEnvCheck {
  ok: boolean;
  pythonPath: string | null;
  pythonVersion: string | null;
  cv2Version: string | null;
  numpyVersion: string | null;
  error: {
    code: string;
    message: string;
    guide: string;
  } | null;
}

export interface DetectOptions {
  sensitivity: number;
  minShotSeconds: number;
  filterTransitions: boolean;
  weights: DetectWeights;
  frameInterval?: number;
  /** 直接指定抽帧间隔（毫秒）；优先于 frameInterval */
  intervalMs?: number;
  /** S36-2：识别引擎；缺省读取 settings.recognition.engine（默认 ai） */
  engine?: RecognitionEngine;
  /** S39：镜头边界引擎；缺省 hybrid，模型不可用时自动回退 opencv */
  boundaryEngine?: ShotBoundaryEngine;
}

export interface Project {
  id: string;
  name: string;
  source: ProjectSource;
  media: ProjectMedia;
  detectOptions: DetectOptions;
  createdAt: string;
  updatedAt: string;
}

export interface ProjectCreateArgs {
  name: string;
  source?: Partial<ProjectSource>;
  media?: Partial<ProjectMedia>;
  detectOptions?: Partial<DetectOptions>;
}

export interface ProjectUpdateArgs {
  id: string;
  patch: {
    name?: string;
    source?: Partial<ProjectSource>;
    media?: Partial<ProjectMedia>;
    detectOptions?: Partial<DetectOptions>;
  };
}

export interface ProjectSaveArgs {
  id: string;
  targetPath?: string;
  /** 是否把项目资源目录（stills/frames/exports）一并打包，默认 true */
  includeAssets?: boolean;
  /** 是否把 source/proxy 视频一并打包，默认 false（体积大，通常按原路径引用） */
  includeMedia?: boolean;
}

export interface ProjectSaveResult {
  path: string;
  sizeBytes: number;
  projectId: string;
}

export interface ProjectOpenArgs {
  path: string;
}

export interface ProjectOpenResult {
  project: Project;
  /** id 冲突时是否重命名生成了新项目 */
  renamed: boolean;
}

export interface Shot {
  id: string;
  projectId: string;
  index: number;
  startMs: number;
  endMs: number;
  durationMs: number;
  shotSize: string | null;
  cameraMethod: string | null;
  dialogue: string | null;
  remark: string | null;
  origin: 'auto' | 'manual';
  locked: boolean;
  thumbnail?: string | null;
  tagIds: string[];
  /** S41：被用户手动编辑过的语义字段（标签应用策略据此保留人工标注） */
  manualFields: ManualShotField[];
  createdAt: string;
  updatedAt: string;
}

export interface Scene {
  id: string;
  projectId: string;
  index: number;
  label: string | null;
  startMs: number;
  endMs: number;
  createdAt: string;
  updatedAt: string;
}

export interface ShotPreview {
  id: string;
  index: number;
  startMs: number;
  endMs: number;
  durationMs: number;
  thumbnail?: string | null;
  /** 兼容 D1-E 初版字段；新调用优先使用 thumbnail */
  thumbPath?: string;
  shotSize?: string | null;
  cameraMethod?: string | null;
  dialogue?: string | null;
  remark?: string | null;
  tags?: Record<string, string[]>;
  confidence?: number;
}

export interface DetectResult {
  shots: ShotPreview[];
  scenes: Scene[];
}

export type DetectJobStatus = 'queued' | 'running' | 'done' | 'cancelled' | 'error';

export interface DetectJobSnapshot {
  jobId: string;
  projectId: string;
  status: DetectJobStatus;
  progress: number;
  error: string | null;
  /** S36-2：AI 任务附加进度（OpenCV 任务缺省） */
  engine?: RecognitionEngine;
  currentSegment?: number;
  segmentsTotal?: number;
  usage?: ShotDetectionUsage;
  /** S39：实际执行的镜头边界引擎（模型运行中失败时可能从 hybrid 变为 opencv） */
  boundaryEngine?: ShotBoundaryEngine;
  /** S39：是否因模型/FFmpeg不可用而回退 OpenCV */
  boundaryFallback?: boolean;
  /** S39：边界引擎降级或 Python 返回的可读警告 */
  boundaryWarning?: string | null;
  /** S41：任务所属管线（boundary=切分落库，labels=标签识别） */
  pipeline: DetectPipeline;
  /** S41：边界任务自动应用的镜头数量 */
  applied?: number;
}

export interface DetectRunArgs {
  projectId: string;
  options: DetectOptions;
  dryRun?: boolean;
}

export interface DetectRunResult {
  jobId: string;
}

export interface DetectProgressEvent {
  jobId: string;
  stage: 'extractFrames' | 'analyze';
  percent: number;
  /** S41：管线标识，渲染层据此区分切分进度与标签进度 */
  pipeline: DetectPipeline;
}

export interface BoundaryAppliedEvent {
  jobId: string;
  result: BoundaryAppliedResult;
}

export interface LabelsDoneEvent {
  jobId: string;
  result: LabelPreviewResult;
}

export interface DetectDoneEvent {
  jobId: string;
  result: DetectResult;
}

export interface DetectApplyArgs {
  projectId: string;
  shotIds: string[];
  sceneIds?: string[];
}

export interface DetectApplyResult {
  applied: number;
}

/** ---------- S41：分阶段检测（边界任务 / 标签任务） ---------- */

export type DetectPipeline = 'boundary' | 'labels';

export type LabelApplyPolicy = 'overwrite-all' | 'preserve-manual';

/** 标签应用可能覆盖、且需要字段级人工保护的镜头字段 */
export type ManualShotField = 'shotSize' | 'cameraMethod' | 'dialogue' | 'remark' | 'tags';

export interface BoundaryDetectRunArgs {
  projectId: string;
  options: DetectOptions;
}

export interface BoundaryAppliedResult {
  jobId: string;
  applied: number;
  /** 因与人工/锁定镜头重叠而被跳过的候选数量 */
  skippedProtected: number;
  /** 应用后的持久化镜头（落库结果） */
  shots: Shot[];
  scenes: Scene[];
  boundaryEngine: ShotBoundaryEngine;
  boundaryFallback: boolean;
  boundaryWarning: string | null;
}

export interface LabelDetectRunArgs {
  projectId: string;
  shotIds?: string[];
}

export interface LabelShotPrediction {
  shotId: string;
  index: number;
  startMs: number;
  endMs: number;
  predicted: {
    shotSize: string | null;
    cameraMethod: string | null;
    remark: string | null;
    tags: Record<string, string[]>;
  };
  confidence: number;
}

export interface LabelPreviewResult {
  jobId: string;
  projectId: string;
  shots: LabelShotPrediction[];
}

export interface LabelApplyArgs {
  jobId: string;
  shotIds: string[];
  policy: LabelApplyPolicy;
}

export interface LabelApplyResult {
  appliedShots: number;
  updatedFields: number;
  updatedTagLinks: number;
  preserved: Array<{ shotId: string; fields: ManualShotField[] }>;
  skipped: Array<{ shotId: string; code: string; message: string }>;
}

/** ---------- S43：分镜墙画布一期（看板） ---------- */

export interface WallLayoutItem {
  shotId: string;
  x: number;
  y: number;
}

export interface WallGetLayoutArgs {
  projectId: string;
}

export interface WallSaveLayoutArgs {
  projectId: string;
  items: WallLayoutItem[];
}

export type WallEdgeKind = 'solid' | 'dash';

export interface WallEdge {
  fromShotId: string;
  toShotId: string;
  kind: WallEdgeKind;
}

export interface WallEdgeAddArgs {
  projectId: string;
  fromShotId: string;
  toShotId: string;
  kind: WallEdgeKind;
}

export interface WallEdgeRemoveArgs {
  projectId: string;
  fromShotId: string;
  toShotId: string;
}

export interface WallEdgeListArgs {
  projectId: string;
}

export interface WallGroup {
  groupId: string;
  name: string;
  shotIds: string[];
}

export interface WallGroupCreateArgs {
  projectId: string;
  name: string;
  shotIds: string[];
}

export interface WallGroupDissolveArgs {
  projectId: string;
  groupId: string;
}

export type WallAnnotationType =
  | 'brush'
  | 'smear'
  | 'line'
  | 'arrow'
  | 'rect'
  | 'ellipse'
  | 'text'
  | 'mosaic';

/** 归一化标注（x: 0~100, y: 0~56.25，相对 16:9 画面） */
export interface WallAnnotation {
  id: string;
  type: WallAnnotationType;
  color: string;
  data: {
    pts?: Array<{ x: number; y: number }>;
    x?: number;
    y?: number;
    w?: number;
    h?: number;
    text?: string;
  };
}

export interface WallAnnotationListArgs {
  projectId: string;
  shotIds?: string[];
}

export interface WallAnnotationSaveArgs {
  projectId: string;
  shotId: string;
  items: Array<Omit<WallAnnotation, 'id'>>;
}

export interface WallExportArgs {
  projectId: string;
}

export interface WallExportResult {
  dir: string;
  count: number;
  skipped: number;
}

export type WallBoardNodeSource = 'image' | 'text';

export interface WallBoardNodeInfo {
  id: string;
  source: WallBoardNodeSource;
  assetPath: string | null;
  title: string;
  textContent: string;
  durationMs: number;
  note: string;
  shotSize: string | null;
  cameraMethod: string | null;
  x: number;
  y: number;
}

export interface WallBoardInfo {
  id: string;
  name: string;
  nodeCount: number;
  updatedAt: string;
}

export interface WallBoardListArgs {
  projectId?: string;
}

export interface WallBoardCreateArgs {
  name: string;
}

export interface WallBoardDeleteArgs {
  boardId: string;
}

export interface WallBoardRenameArgs {
  boardId: string;
  name: string;
}

export interface WallNodeListArgs {
  boardId: string;
}

export interface WallNodeAddArgs {
  boardId: string;
  source: WallBoardNodeSource;
  assetPath?: string | null;
  title?: string;
  x: number;
  y: number;
}

export interface WallNodeUpdateArgs {
  nodeId: string;
  patch: Partial<
    Pick<WallBoardNodeInfo, 'title' | 'textContent' | 'durationMs' | 'note' | 'shotSize' | 'cameraMethod' | 'x' | 'y'>
  >;
}

export interface WallNodeDeleteArgs {
  nodeId: string;
}

export interface WallNodeEdgeListArgs {
  boardId: string;
}

export interface WallNodeEdgeAddArgs {
  boardId: string;
  fromNodeId: string;
  toNodeId: string;
  kind: WallEdgeKind;
}

export interface WallNodeEdgeRemoveArgs {
  boardId: string;
  fromNodeId: string;
  toNodeId: string;
}

export interface WallNodeAnnotationListArgs {
  boardId: string;
}

export interface WallNodeAnnotationSaveArgs {
  boardId: string;
  nodeId: string;
  items: Array<{ type: WallAnnotationType; color: string; data: WallAnnotation['data'] }>;
}

export interface WallImportImageArgs {
  boardId: string;
  srcPath: string;
}

export interface WallImportImageResult {
  nodeId: string;
  assetUrl: string;
}

export interface WallPickImageResult {
  path: string | null;
}

/** 分镜墙视图状态（缩放/平移），按项目存 settings.json，不进数据库 */
export interface WallViewState {
  scale: number;
  panX: number;
  panY: number;
}

/** ---------- S36-2：镜头识别 AI 契约 ---------- */

/** 交给 provider 的单个视频分段输入（原生视频，不本地抽帧）。 */
export interface ShotDetectionSegment {
  videoPath: string;
  startMs: number;
  endMs: number;
}

/** 结构化镜头：字段完整率 100% 的契约单元。 */
export interface ShotDetectionShot {
  id: string;
  startMs: number;
  endMs: number;
  representativeTimeMs: number;
  note: string;
  /** category → name[]，如 { 景别: ['中景'], 运镜: ['跟'] } */
  tags: Record<string, string[]>;
  confidence: number;
}

export interface ShotDetectionUsage {
  seconds: number;
  tokens: number;
  /** 估算费用（USD），provider 可选返回 */
  cost?: number;
}

export interface ShotDetectionResult {
  segment: { startMs: number; endMs: number };
  shots: ShotDetectionShot[];
  usage: ShotDetectionUsage;
  generatedAt: string;
}

/** Provider 能力探测结果（S36-2a）。 */
export interface AiProviderProbeResult {
  ok: boolean;
  supportsNativeVideo: boolean;
  provider: string;
  model: string | null;
  error: { code: string; message: string } | null;
}

/** AI 识别任务快照（MCP get_detection_job 返回）。 */
export interface AiJobSnapshot {
  jobId: string;
  projectId: string;
  status: DetectJobStatus;
  progress: number;
  currentSegment: number;
  segmentsTotal: number;
  error: string | null;
  usage: ShotDetectionUsage;
}

export interface ShotCreateArgs {
  projectId: string;
  startMs: number;
  endMs: number;
  index?: number;
  shotSize?: string | null;
  cameraMethod?: string | null;
  dialogue?: string | null;
  remark?: string | null;
}

export interface ShotUpdateArgs {
  id: string;
  patch: {
    index?: number;
    startMs?: number;
    endMs?: number;
    shotSize?: string | null;
    cameraMethod?: string | null;
    dialogue?: string | null;
    remark?: string | null;
  };
}

export interface ShotSplitArgs {
  projectId: string;
  shotId: string;
  cutMs: number;
}

export interface ShotSplitResult {
  left: Shot;
  right: Shot;
}

export interface ShotMergeArgs {
  projectId: string;
  shotIdA: string;
  shotIdB: string;
}

export interface ShotMergeResult {
  shot: Shot;
}

export interface ShotTrimArgs {
  projectId: string;
  leftShotId: string;
  rightShotId: string;
  cutMs: number;
}

export interface ShotTrimResult {
  left: Shot;
  right: Shot;
}

export type AnnotationType = 'box' | 'arrow' | 'text';
export interface Annotation {
  type: AnnotationType;
  x?: number;
  y?: number;
  w?: number;
  h?: number;
  points?: [number, number][];
  color?: string;
  label?: string | null;
}

export interface Still {
  id: string;
  projectId: string;
  shotId: string | null;
  timeMs: number;
  filePath: string;
  thumbPath: string | null;
  width: number | null;
  height: number | null;
  caption: string | null;
  role: 'main' | 'auto-thumb';
  annotations: Annotation[];
  createdAt: string;
  updatedAt: string;
}

export interface StillCreateArgs {
  projectId: string;
  shotId?: string | null;
  timeMs: number;
  filePath: string;
  thumbPath?: string | null;
  width?: number | null;
  height?: number | null;
  caption?: string | null;
  role?: 'main' | 'auto-thumb';
  annotations?: Annotation[];
}

export interface StillCaptureArgs {
  projectId: string;
  timeMs: number;
  shotId?: string | null;
  caption?: string | null;
}

export interface StillCaptureAtArgs {
  shotId: string;
  caption?: string | null;
}

export interface StillSetAnnotationArgs {
  id: string;
  annotations: Annotation[];
}

export interface StillUpdateArgs {
  id: string;
  patch: {
    shotId?: string | null;
    timeMs?: number;
    filePath?: string;
    thumbPath?: string | null;
    width?: number | null;
    height?: number | null;
    caption?: string | null;
    role?: 'main' | 'auto-thumb';
    annotations?: Annotation[];
  };
}

export interface Tag {
  id: string;
  category: string;
  name: string;
  color: string | null;
  builtin: boolean;
  sortOrder: number;
  createdAt: string;
}

export interface TagCreateArgs {
  category: string;
  name: string;
  color?: string | null;
  builtin?: boolean;
  sortOrder?: number;
}

export interface TagUpdateArgs {
  id: string;
  patch: {
    category?: string;
    name?: string;
    color?: string | null;
    sortOrder?: number;
  };
}

export interface Note {
  id: string;
  projectId: string;
  shotId: string;
  text: string;
  createdAt: string;
  updatedAt: string;
}

export interface NoteUpsertArgs {
  id?: string;
  projectId: string;
  shotId: string;
  text: string;
}

export interface Term {
  id: string;
  category: string;
  term: string;
  definition: string;
  builtin: boolean;
  sortOrder: number;
  createdAt: string;
}

export interface TermCreateArgs {
  category?: string;
  term: string;
  definition: string;
  builtin?: boolean;
  sortOrder?: number;
}

export interface TermUpdateArgs {
  id: string;
  patch: {
    category?: string;
    term?: string;
    definition?: string;
    sortOrder?: number;
  };
}

export interface TermJsonEntry {
  term: string;
  definition: string;
  category?: string;
}

export interface TermImportResult {
  canceled: boolean;
  path: string | null;
  total: number;
  imported: number;
  skipped: number;
}

export interface TermExportResult {
  canceled: boolean;
  path: string | null;
  count: number;
}

export type StoryboardFormat = 'pdf' | 'docx';
export type StoryboardImageStrategy = 'both' | 'thumbnail' | 'full';
export type StoryboardColumnKey =
  | 'index'
  | 'duration'
  | 'thumbnail'
  | 'shotSize'
  | 'cameraMethod'
  | 'image'
  | 'dialogue'
  | 'remark';

export interface StoryboardHeader {
  key: StoryboardColumnKey;
  label: string;
}

export interface StoryboardExportArgs {
  projectId: string;
  format: StoryboardFormat;
  range?: {
    shotIds?: string[];
  };
  headers?: StoryboardHeader[];
  imageStrategy?: StoryboardImageStrategy;
  /** S33-2：导出时并入右侧标签与镜头笔记（默认 true） */
  includeTags?: boolean;
}

export interface StoryboardExportResult {
  jobId: string;
  canceled: boolean;
  filePath: string | null;
  format: StoryboardFormat;
  rowCount: number;
}

export interface ExportProgressEvent {
  jobId: string;
  percent: number;
  stage: 'prepare' | 'thumbnails' | 'render' | 'write';
  message: string;
}

export interface ExportDoneEvent {
  jobId: string;
  filePath: string;
  format: StoryboardFormat;
  rowCount: number;
}

export interface StatsTagDistributionItem {
  category: '景别' | '机位' | '运镜';
  name: string;
  count: number;
}

export interface StatsRhythmPoint {
  shotId: string;
  index: number;
  startMs: number;
  durationMs: number;
  durationSeconds: number;
}

export interface StatsProgress {
  annotatedShots: number;
  totalShots: number;
  percent: number;
}

export interface ProjectApi {
  create(args: ProjectCreateArgs): Promise<IpcResult<Project>>;
  list(): Promise<IpcResult<Project[]>>;
  get(args: { id: string }): Promise<IpcResult<Project>>;
  update(args: ProjectUpdateArgs): Promise<IpcResult<Project>>;
  delete(args: { id: string }): Promise<IpcResult<{ deleted: true }>>;
  save(args: ProjectSaveArgs): Promise<IpcResult<ProjectSaveResult>>;
  saveAs(args: { id: string; targetPath: string }): Promise<IpcResult<ProjectSaveResult>>;
  open(args: ProjectOpenArgs): Promise<IpcResult<ProjectOpenResult>>;
}

export interface ShotApi {
  list(args: { projectId: string }): Promise<IpcResult<Shot[]>>;
  get(args: { id: string }): Promise<IpcResult<Shot>>;
  create(args: ShotCreateArgs): Promise<IpcResult<Shot>>;
  update(args: ShotUpdateArgs): Promise<IpcResult<Shot>>;
  delete(args: { id: string }): Promise<IpcResult<{ deleted: true }>>;
  split(args: ShotSplitArgs): Promise<IpcResult<ShotSplitResult>>;
  merge(args: ShotMergeArgs): Promise<IpcResult<ShotMergeResult>>;
  trim(args: ShotTrimArgs): Promise<IpcResult<ShotTrimResult>>;
  setThumbnail(args: { id: string; thumbnail: string | null }): Promise<IpcResult<Shot>>;
}

export interface StillApi {
  list(args: { projectId?: string; shotId?: string }): Promise<IpcResult<Still[]>>;
  get(args: { id: string }): Promise<IpcResult<Still>>;
  create(args: StillCreateArgs): Promise<IpcResult<Still>>;
  capture(args: StillCaptureArgs): Promise<IpcResult<Still>>;
  captureAt(args: StillCaptureAtArgs): Promise<IpcResult<Still>>;
  update(args: StillUpdateArgs): Promise<IpcResult<Still>>;
  setAnnotation(args: StillSetAnnotationArgs): Promise<IpcResult<Still>>;
  delete(args: { id: string }): Promise<IpcResult<{ deleted: true }>>;
  onCreated(listener: (still: Still) => void): () => void;
}

export interface TagApi {
  list(args?: { category?: string }): Promise<IpcResult<Tag[]>>;
  create(args: TagCreateArgs): Promise<IpcResult<Tag>>;
  update(args: TagUpdateArgs): Promise<IpcResult<Tag>>;
  delete(args: { id: string }): Promise<IpcResult<{ deleted: true }>>;
  assign(args: { shotId: string; tagIds: string[] }): Promise<IpcResult<{ shotId: string; tagIds: string[] }>>;
  unassign(args: { shotId: string; tagIds: string[] }): Promise<IpcResult<{ shotId: string; tagIds: string[] }>>;
}

export interface NoteApi {
  list(args: { projectId?: string; shotId?: string }): Promise<IpcResult<Note[]>>;
  get(args: { id: string }): Promise<IpcResult<Note>>;
  upsert(args: NoteUpsertArgs): Promise<IpcResult<Note>>;
  delete(args: { id: string }): Promise<IpcResult<{ deleted: true }>>;
}

export interface TermApi {
  list(args?: { category?: string }): Promise<IpcResult<Term[]>>;
  create(args: TermCreateArgs): Promise<IpcResult<Term>>;
  update(args: TermUpdateArgs): Promise<IpcResult<Term>>;
  delete(args: { id: string }): Promise<IpcResult<{ deleted: true }>>;
  importJson(): Promise<IpcResult<TermImportResult>>;
  exportJson(): Promise<IpcResult<TermExportResult>>;
}

export interface ExportApi {
  storyboard(args: StoryboardExportArgs): Promise<IpcResult<StoryboardExportResult>>;
  onProgress(listener: (event: ExportProgressEvent) => void): () => void;
  onDone(listener: (event: ExportDoneEvent) => void): () => void;
}

export interface DetectApi {
  checkEnv(): Promise<IpcResult<DetectEnvCheck>>;
  run(args: DetectRunArgs): Promise<IpcResult<DetectRunResult>>;
  cancel(args: { jobId: string }): Promise<IpcResult<void>>;
  getJob(args: { jobId: string }): Promise<IpcResult<DetectJobSnapshot>>;
  apply(args: DetectApplyArgs): Promise<IpcResult<DetectApplyResult>>;
  /** S41：边界任务（切分 + 自动落库），不调用 Qwen */
  runBoundary(args: BoundaryDetectRunArgs): Promise<IpcResult<DetectRunResult>>;
  /** S41：标签任务（对已落库镜头做 Qwen 识别，仅生成预览） */
  runLabels(args: LabelDetectRunArgs): Promise<IpcResult<DetectRunResult>>;
  /** S41：按策略应用标签预览（唯一写库入口） */
  applyLabels(args: LabelApplyArgs): Promise<IpcResult<LabelApplyResult>>;
  onProgress(listener: (event: DetectProgressEvent) => void): () => void;
  onDone(listener: (event: DetectDoneEvent) => void): () => void;
  onBoundaryApplied(listener: (event: BoundaryAppliedEvent) => void): () => void;
  onLabelsDone(listener: (event: LabelsDoneEvent) => void): () => void;
}

export interface ScopeApi {
  extractAudioWaveform(args: ScopeExtractAudioWaveformArgs): Promise<IpcResult<AudioWaveform>>;
}

export interface StatsApi {
  tagDistribution(args: { projectId: string }): Promise<IpcResult<StatsTagDistributionItem[]>>;
  rhythm(args: { projectId: string }): Promise<IpcResult<StatsRhythmPoint[]>>;
  progress(args: { projectId: string }): Promise<IpcResult<StatsProgress>>;
}
