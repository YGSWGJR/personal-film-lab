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
  onProgress(listener: (event: DetectProgressEvent) => void): () => void;
  onDone(listener: (event: DetectDoneEvent) => void): () => void;
}

export interface ScopeApi {
  extractAudioWaveform(args: ScopeExtractAudioWaveformArgs): Promise<IpcResult<AudioWaveform>>;
}

export interface StatsApi {
  tagDistribution(args: { projectId: string }): Promise<IpcResult<StatsTagDistributionItem[]>>;
  rhythm(args: { projectId: string }): Promise<IpcResult<StatsRhythmPoint[]>>;
  progress(args: { projectId: string }): Promise<IpcResult<StatsProgress>>;
}
