import { contextBridge, ipcRenderer } from 'electron';
import type { ZodType } from 'zod';
import { IPC } from '../shared/ipc-channels';
import { fail } from '../shared/ipc-result';
import {
  emptyArgsSchema,
  mediaCancelJobArgsSchema,
  mediaExtractFrameArgsSchema,
  mediaExtractFramesArgsSchema,
  mediaProbeArgsSchema,
  mediaTranscodeProxyArgsSchema,
  playerFrameStepArgsSchema,
  playerOpenArgsSchema,
  playerSeekArgsSchema,
  playerSetBoundsArgsSchema,
  playerSetVolumeArgsSchema,
} from '../shared/schemas';
import type {
  AppInfo,
  CancelJobResult,
  ExtractFrameArgs,
  ExtractFramesArgs,
  ExtractFramesResult,
  ExtractFrameResult,
  FrameInfo,
  IpcResult,
  MediaInfo,
  MediaProbeResult,
  MediaProgressEvent,
  PlayerErrorEvent,
  PlayerOpenArgs,
  PlayerState,
  PlayerTimeEvent,
  RenderBounds,
  TranscodeProxyArgs,
  TranscodeProxyResult,
  WindowApi,
} from '../shared/types';

/**
 * preload：渲染层与主进程之间唯一的桥（docs/S01 §3.2 / §6.1）。
 *
 * - contextIsolation: true，渲染层拿不到 ipcRenderer / require；
 * - sandbox: true，本文件只能使用 electron 内置模块（zod 等已打进产物）；
 * - 仅暴露白名单方法，禁止 send(channel, ...) 这类通用透传；
 * - 入参先经 shared/schemas.ts 校验，非法载荷直接拒绝。
 */

/** 白名单：通道 → 入参校验 schema；未登记的通道不会转发 */
const INVOKE_WHITELIST: Record<string, ZodType> = {
  [IPC.APP_INFO]: emptyArgsSchema,
  [IPC.PLAYER_OPEN]: playerOpenArgsSchema,
  [IPC.PLAYER_OPEN_DIALOG]: emptyArgsSchema,
  [IPC.PLAYER_CLOSE]: emptyArgsSchema,
  [IPC.PLAYER_PLAY]: emptyArgsSchema,
  [IPC.PLAYER_PAUSE]: emptyArgsSchema,
  [IPC.PLAYER_TOGGLE]: emptyArgsSchema,
  [IPC.PLAYER_SEEK]: playerSeekArgsSchema,
  [IPC.PLAYER_FRAME_STEP]: playerFrameStepArgsSchema,
  [IPC.PLAYER_GET_STATE]: emptyArgsSchema,
  [IPC.PLAYER_GET_FRAME]: emptyArgsSchema,
  [IPC.PLAYER_SET_VOLUME]: playerSetVolumeArgsSchema,
  [IPC.PLAYER_SET_BOUNDS]: playerSetBoundsArgsSchema,
  [IPC.MEDIA_PROBE]: mediaProbeArgsSchema,
  [IPC.MEDIA_EXTRACT_FRAME]: mediaExtractFrameArgsSchema,
  [IPC.MEDIA_EXTRACT_FRAMES]: mediaExtractFramesArgsSchema,
  [IPC.MEDIA_TRANSCODE_PROXY]: mediaTranscodeProxyArgsSchema,
  [IPC.MEDIA_CANCEL_JOB]: mediaCancelJobArgsSchema,
};

/** 主进程 → 渲染层事件白名单 */
const EVENT_WHITELIST = {
  onState: IPC.PLAYER_EVENT_STATE,
  onTime: IPC.PLAYER_EVENT_TIME,
  onLoaded: IPC.PLAYER_EVENT_LOADED,
  onError: IPC.PLAYER_EVENT_ERROR,
  onMediaProgress: IPC.MEDIA_EVENT_PROGRESS,
} as const;

async function invoke<T>(channel: string, args: unknown[] = []): Promise<IpcResult<T>> {
  const schema = INVOKE_WHITELIST[channel];
  if (!schema) {
    return fail('IPC_CHANNEL_NOT_WHITELISTED', `通道未在白名单中：${channel}`);
  }

  const parsed = schema.safeParse(args.length === 0 ? [] : args[0]);
  if (!parsed.success) {
    return fail('IPC_INVALID_PAYLOAD', parsed.error.message);
  }

  const payload = Array.isArray(parsed.data) ? (parsed.data as unknown[]) : [parsed.data];
  return (await ipcRenderer.invoke(channel, ...payload)) as IpcResult<T>;
}

function subscribe<T>(channel: string, listener: (payload: T) => void): () => void {
  if (typeof listener !== 'function') {
    throw new TypeError('listener must be a function');
  }
  const wrapped = (_event: unknown, payload: T): void => listener(payload);
  ipcRenderer.on(channel, wrapped);
  return () => ipcRenderer.removeListener(channel, wrapped);
}

const appApi = {
  getInfo: () => invoke<AppInfo>(IPC.APP_INFO),
};

const playerApi = {
  open: (args: PlayerOpenArgs) => invoke<MediaInfo>(IPC.PLAYER_OPEN, [args]),
  openDialog: () => invoke<MediaInfo | null>(IPC.PLAYER_OPEN_DIALOG),
  close: () => invoke<void>(IPC.PLAYER_CLOSE),
  play: () => invoke<PlayerState>(IPC.PLAYER_PLAY),
  pause: () => invoke<PlayerState>(IPC.PLAYER_PAUSE),
  toggle: () => invoke<PlayerState>(IPC.PLAYER_TOGGLE),
  seek: (args: { timeMs: number; exact?: boolean }) => invoke<PlayerState>(IPC.PLAYER_SEEK, [args]),
  frameStep: (args: { dir: 1 | -1 }) => invoke<FrameInfo>(IPC.PLAYER_FRAME_STEP, [args]),
  getState: () => invoke<PlayerState>(IPC.PLAYER_GET_STATE),
  getFrame: () => invoke<FrameInfo>(IPC.PLAYER_GET_FRAME),
  setVolume: (args: { volume: number }) => invoke<PlayerState>(IPC.PLAYER_SET_VOLUME, [args]),
  setBounds: (bounds: RenderBounds) => invoke<void>(IPC.PLAYER_SET_BOUNDS, [bounds]),
  onState: (listener: (state: PlayerState) => void) => subscribe<PlayerState>(EVENT_WHITELIST.onState, listener),
  onTime: (listener: (event: PlayerTimeEvent) => void) => subscribe<PlayerTimeEvent>(EVENT_WHITELIST.onTime, listener),
  onLoaded: (listener: (info: MediaInfo) => void) => subscribe<MediaInfo>(EVENT_WHITELIST.onLoaded, listener),
  onError: (listener: (event: PlayerErrorEvent) => void) => subscribe<PlayerErrorEvent>(EVENT_WHITELIST.onError, listener),
};

const mediaApi = {
  probe: (args: { path: string; timeoutMs?: number }) => invoke<MediaProbeResult>(IPC.MEDIA_PROBE, [args]),
  extractFrame: (args: ExtractFrameArgs) => invoke<ExtractFrameResult>(IPC.MEDIA_EXTRACT_FRAME, [args]),
  extractFrames: (args: ExtractFramesArgs) => invoke<ExtractFramesResult>(IPC.MEDIA_EXTRACT_FRAMES, [args]),
  transcodeProxy: (args: TranscodeProxyArgs) => invoke<TranscodeProxyResult>(IPC.MEDIA_TRANSCODE_PROXY, [args]),
  cancelJob: (args: { jobId: string }) => invoke<CancelJobResult>(IPC.MEDIA_CANCEL_JOB, [args]),
  onProgress: (listener: (event: MediaProgressEvent) => void) =>
    subscribe<MediaProgressEvent>(EVENT_WHITELIST.onMediaProgress, listener),
};

const api: WindowApi = {
  app: appApi,
  player: playerApi,
  media: mediaApi,
};

contextBridge.exposeInMainWorld('api', api);