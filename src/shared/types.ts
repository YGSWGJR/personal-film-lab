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
}

/** 统一返回信封（S01 §6.1） */
export type IpcResult<T> = { ok: true; data: T } | { ok: false; error: IpcError };

/** 媒体探测结果（player:open 返回，字段与 S01 §6.2 对齐） */
export interface MediaInfo {
  path: string;
  durationMs: number;
  width: number;
  height: number;
  fps: number;
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

export interface WindowApi {
  app: AppApi;
  player: PlayerApi;
}