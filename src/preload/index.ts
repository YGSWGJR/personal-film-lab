import { contextBridge, ipcRenderer } from 'electron';
import { z, type ZodType } from 'zod';
import { IPC } from '../shared/ipc-channels';
import { fail } from '../shared/ipc-result';
import {
  emptyArgsSchema,
  detectApplyArgsSchema,
  detectCancelArgsSchema,
  detectGetJobArgsSchema,
  detectRunArgsSchema,
  mediaCancelJobArgsSchema,
  mediaExtractFrameArgsSchema,
  mediaExtractFramesArgsSchema,
  mediaProbeArgsSchema,
  mediaTranscodeProxyArgsSchema,
  noteListArgsSchema,
  noteUpsertArgsSchema,
  playerFrameStepArgsSchema,
  projectCreateArgsSchema,
  projectOpenArgsSchema,
  projectSaveArgsSchema,
  projectSaveAsArgsSchema,
  projectUpdateArgsSchema,
  shotCreateArgsSchema,
  shotUpdateArgsSchema,
  stillCreateArgsSchema,
  stillCaptureArgsSchema,
  stillCaptureAtArgsSchema,
  stillListArgsSchema,
  stillSetAnnotationArgsSchema,
  stillUpdateArgsSchema,
  storyboardExportArgsSchema,
  tagAssignArgsSchema,
  tagCreateArgsSchema,
  tagListArgsSchema,
  tagUpdateArgsSchema,
  termCreateArgsSchema,
  termListArgsSchema,
  termUpdateArgsSchema,
  idArgsSchema,
  playerOpenArgsSchema,
  playerSeekArgsSchema,
  playerSetBoundsArgsSchema,
  playerSetVolumeArgsSchema,
  scopeExtractAudioWaveformArgsSchema,
} from '../shared/schemas';
import type {
  AppInfo,
  AudioWaveform,
  CancelJobResult,
  DetectApplyArgs,
  DetectApplyResult,
  DetectDoneEvent,
  DetectJobSnapshot,
  DetectProgressEvent,
  DetectRunArgs,
  DetectRunResult,
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
  ScopeExtractAudioWaveformArgs,
  TranscodeProxyArgs,
  TranscodeProxyResult,
  WindowApi,
  ProjectCreateArgs,
  ProjectUpdateArgs,
  ProjectSaveArgs,
  ProjectOpenResult,
  Project,
  Shot,
  ShotCreateArgs,
  ShotUpdateArgs,
  Still,
  StillCaptureArgs,
  StillCaptureAtArgs,
  StillCreateArgs,
  StillSetAnnotationArgs,
  StillUpdateArgs,
  StoryboardExportArgs,
  StoryboardExportResult,
  ExportDoneEvent,
  ExportProgressEvent,
  Tag,
  TagCreateArgs,
  TagUpdateArgs,
  Note,
  NoteUpsertArgs,
  Term,
  TermCreateArgs,
  TermExportResult,
  TermImportResult,
  TermUpdateArgs,
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
  [IPC.SCOPE_EXTRACT_AUDIO_WAVEFORM]: scopeExtractAudioWaveformArgsSchema,

  [IPC.DETECT_RUN]: detectRunArgsSchema,
  [IPC.DETECT_CANCEL]: detectCancelArgsSchema,
  [IPC.DETECT_GET_JOB]: detectGetJobArgsSchema,
  [IPC.DETECT_APPLY]: detectApplyArgsSchema,

  [IPC.PROJECT_CREATE]: projectCreateArgsSchema,
  [IPC.PROJECT_LIST]: emptyArgsSchema,
  [IPC.PROJECT_GET]: idArgsSchema,
  [IPC.PROJECT_UPDATE]: projectUpdateArgsSchema,
  [IPC.PROJECT_DELETE]: idArgsSchema,
  [IPC.PROJECT_SAVE]: projectSaveArgsSchema,
  [IPC.PROJECT_SAVE_AS]: projectSaveAsArgsSchema,
  [IPC.PROJECT_OPEN]: projectOpenArgsSchema,

  [IPC.SHOT_LIST]: z.object({ projectId: z.string().min(1) }),
  [IPC.SHOT_GET]: idArgsSchema,
  [IPC.SHOT_CREATE]: shotCreateArgsSchema,
  [IPC.SHOT_UPDATE]: shotUpdateArgsSchema,
  [IPC.SHOT_DELETE]: idArgsSchema,

  [IPC.STILL_LIST]: stillListArgsSchema,
  [IPC.STILL_GET]: idArgsSchema,
  [IPC.STILL_CREATE]: stillCreateArgsSchema,
  [IPC.STILL_CAPTURE]: stillCaptureArgsSchema,
  [IPC.STILL_CAPTURE_AT]: stillCaptureAtArgsSchema,
  [IPC.STILL_UPDATE]: stillUpdateArgsSchema,
  [IPC.STILL_SET_ANNOTATION]: stillSetAnnotationArgsSchema,
  [IPC.STILL_DELETE]: idArgsSchema,

  [IPC.TAG_LIST]: tagListArgsSchema,
  [IPC.TAG_CREATE]: tagCreateArgsSchema,
  [IPC.TAG_UPDATE]: tagUpdateArgsSchema,
  [IPC.TAG_DELETE]: idArgsSchema,
  [IPC.TAG_ASSIGN]: tagAssignArgsSchema,
  [IPC.TAG_UNASSIGN]: tagAssignArgsSchema,

  [IPC.NOTE_LIST]: noteListArgsSchema,
  [IPC.NOTE_GET]: idArgsSchema,
  [IPC.NOTE_UPSERT]: noteUpsertArgsSchema,
  [IPC.NOTE_DELETE]: idArgsSchema,

  [IPC.TERM_LIST]: termListArgsSchema,
  [IPC.TERM_CREATE]: termCreateArgsSchema,
  [IPC.TERM_UPDATE]: termUpdateArgsSchema,
  [IPC.TERM_DELETE]: idArgsSchema,
  [IPC.TERM_IMPORT_JSON]: emptyArgsSchema,
  [IPC.TERM_EXPORT_JSON]: emptyArgsSchema,
  [IPC.EXPORT_STORYBOARD]: storyboardExportArgsSchema,
};

/** 主进程 → 渲染层事件白名单 */
const EVENT_WHITELIST = {
  onState: IPC.PLAYER_EVENT_STATE,
  onTime: IPC.PLAYER_EVENT_TIME,
  onLoaded: IPC.PLAYER_EVENT_LOADED,
  onError: IPC.PLAYER_EVENT_ERROR,
  onMediaProgress: IPC.MEDIA_EVENT_PROGRESS,
  onDetectProgress: IPC.DETECT_EVENT_PROGRESS,
  onDetectDone: IPC.DETECT_EVENT_DONE,
  onStillCreated: IPC.STILL_EVENT_CREATED,
  onExportProgress: IPC.EXPORT_EVENT_PROGRESS,
  onExportDone: IPC.EXPORT_EVENT_DONE,
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

const detectApi = {
  run: (args: DetectRunArgs) => invoke<DetectRunResult>(IPC.DETECT_RUN, [args]),
  cancel: (args: { jobId: string }) => invoke<void>(IPC.DETECT_CANCEL, [args]),
  getJob: (args: { jobId: string }) => invoke<DetectJobSnapshot>(IPC.DETECT_GET_JOB, [args]),
  apply: (args: DetectApplyArgs) => invoke<DetectApplyResult>(IPC.DETECT_APPLY, [args]),
  onProgress: (listener: (event: DetectProgressEvent) => void) =>
    subscribe<DetectProgressEvent>(EVENT_WHITELIST.onDetectProgress, listener),
  onDone: (listener: (event: DetectDoneEvent) => void) =>
    subscribe<DetectDoneEvent>(EVENT_WHITELIST.onDetectDone, listener),
};

const scopeApi = {
  extractAudioWaveform: (args: ScopeExtractAudioWaveformArgs) =>
    invoke<AudioWaveform>(IPC.SCOPE_EXTRACT_AUDIO_WAVEFORM, [args]),
};

const projectApi = {
  create: (args: ProjectCreateArgs) => invoke<Project>(IPC.PROJECT_CREATE, [args]),
  list: () => invoke<Project[]>(IPC.PROJECT_LIST),
  get: (args: { id: string }) => invoke<Project>(IPC.PROJECT_GET, [args]),
  update: (args: ProjectUpdateArgs) => invoke<Project>(IPC.PROJECT_UPDATE, [args]),
  delete: (args: { id: string }) => invoke<{ deleted: true }>(IPC.PROJECT_DELETE, [args]),
  save: (args: ProjectSaveArgs) => invoke<ProjectSaveArgs extends never ? never : { path: string; sizeBytes: number; projectId: string }>(IPC.PROJECT_SAVE, [args]),
  saveAs: (args: { id: string; targetPath: string }) =>
    invoke<{ path: string; sizeBytes: number; projectId: string }>(IPC.PROJECT_SAVE_AS, [args]),
  open: (args: { path: string }) => invoke<ProjectOpenResult>(IPC.PROJECT_OPEN, [args]),
};

const shotApi = {
  list: (args: { projectId: string }) => invoke<Shot[]>(IPC.SHOT_LIST, [args]),
  get: (args: { id: string }) => invoke<Shot>(IPC.SHOT_GET, [args]),
  create: (args: ShotCreateArgs) => invoke<Shot>(IPC.SHOT_CREATE, [args]),
  update: (args: ShotUpdateArgs) => invoke<Shot>(IPC.SHOT_UPDATE, [args]),
  delete: (args: { id: string }) => invoke<{ deleted: true }>(IPC.SHOT_DELETE, [args]),
};

const stillApi = {
  list: (args: { projectId?: string; shotId?: string }) => invoke<Still[]>(IPC.STILL_LIST, [args]),
  get: (args: { id: string }) => invoke<Still>(IPC.STILL_GET, [args]),
  create: (args: StillCreateArgs) => invoke<Still>(IPC.STILL_CREATE, [args]),
  capture: (args: StillCaptureArgs) => invoke<Still>(IPC.STILL_CAPTURE, [args]),
  captureAt: (args: StillCaptureAtArgs) => invoke<Still>(IPC.STILL_CAPTURE_AT, [args]),
  update: (args: StillUpdateArgs) => invoke<Still>(IPC.STILL_UPDATE, [args]),
  setAnnotation: (args: StillSetAnnotationArgs) => invoke<Still>(IPC.STILL_SET_ANNOTATION, [args]),
  delete: (args: { id: string }) => invoke<{ deleted: true }>(IPC.STILL_DELETE, [args]),
  onCreated: (listener: (still: Still) => void) =>
    subscribe<Still>(EVENT_WHITELIST.onStillCreated, listener),
};

const tagApi = {
  list: (args: { category?: string } = {}) => invoke<Tag[]>(IPC.TAG_LIST, [args]),
  create: (args: TagCreateArgs) => invoke<Tag>(IPC.TAG_CREATE, [args]),
  update: (args: TagUpdateArgs) => invoke<Tag>(IPC.TAG_UPDATE, [args]),
  delete: (args: { id: string }) => invoke<{ deleted: true }>(IPC.TAG_DELETE, [args]),
  assign: (args: { shotId: string; tagIds: string[] }) =>
    invoke<{ shotId: string; tagIds: string[] }>(IPC.TAG_ASSIGN, [args]),
  unassign: (args: { shotId: string; tagIds: string[] }) =>
    invoke<{ shotId: string; tagIds: string[] }>(IPC.TAG_UNASSIGN, [args]),
};

const noteApi = {
  list: (args: { projectId?: string; shotId?: string }) => invoke<Note[]>(IPC.NOTE_LIST, [args]),
  get: (args: { id: string }) => invoke<Note>(IPC.NOTE_GET, [args]),
  upsert: (args: NoteUpsertArgs) => invoke<Note>(IPC.NOTE_UPSERT, [args]),
  delete: (args: { id: string }) => invoke<{ deleted: true }>(IPC.NOTE_DELETE, [args]),
};

const termApi = {
  list: (args: { category?: string } = {}) => invoke<Term[]>(IPC.TERM_LIST, [args]),
  create: (args: TermCreateArgs) => invoke<Term>(IPC.TERM_CREATE, [args]),
  update: (args: TermUpdateArgs) => invoke<Term>(IPC.TERM_UPDATE, [args]),
  delete: (args: { id: string }) => invoke<{ deleted: true }>(IPC.TERM_DELETE, [args]),
  importJson: () => invoke<TermImportResult>(IPC.TERM_IMPORT_JSON),
  exportJson: () => invoke<TermExportResult>(IPC.TERM_EXPORT_JSON),
};

const exportApi = {
  storyboard: (args: StoryboardExportArgs) =>
    invoke<StoryboardExportResult>(IPC.EXPORT_STORYBOARD, [args]),
  onProgress: (listener: (event: ExportProgressEvent) => void) =>
    subscribe<ExportProgressEvent>(EVENT_WHITELIST.onExportProgress, listener),
  onDone: (listener: (event: ExportDoneEvent) => void) =>
    subscribe<ExportDoneEvent>(EVENT_WHITELIST.onExportDone, listener),
};

const api: WindowApi = {
  app: appApi,
  player: playerApi,
  media: mediaApi,
  scope: scopeApi,
  detect: detectApi,
  project: projectApi,
  shot: shotApi,
  still: stillApi,
  tag: tagApi,
  note: noteApi,
  term: termApi,
  export: exportApi,
};

contextBridge.exposeInMainWorld('api', api);
