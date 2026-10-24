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

/** 播放器状态（player:getState / player:event:state） */
export interface PlayerState {
  hasFile: boolean;
  timeMs: number;
  durationMs: number;
  paused: boolean;
  ended: boolean;
  volume: number;
  width: number;
  height: number;
  fps: number;
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

/** 媒体长任务进度（media:event:progress） */
export interface MediaProgressEvent {
  jobId: string;
  stage: 'transcode' | 'extractFrames';
  /** 0..100，整数 */
  percent: number;
  message: string;
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
  /** 代理目标最大高度，默认 720（不放大） */
  maxHeight?: number;
  /** x264 CRF，默认 26 */
  crf?: number;
  /** x264 preset，默认 veryfast */
  preset?: string;
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
  setBounds(bounds: RenderBounds): Promise<IpcResult<void>>;
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
  onProgress(listener: (event: MediaProgressEvent) => void): () => void;
}

export interface WindowApi {
  app: AppApi;
  player: PlayerApi;
  media: MediaApi;
}