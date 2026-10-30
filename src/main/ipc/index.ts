import { app, ipcMain, type BrowserWindow } from 'electron';
import { IPC } from '../../shared/ipc-channels';
import { withEnvelope } from '../../shared/ipc-result';
import type {
  AiCopyPromptArgs,
  AiCopyPromptResult,
  AiMcpAuthResponseArgs,
  AiMcpStatus,
  AiProjectSnapshot,
  AppInfo,
  CandidateSource,
  CancelJobResult,
  DetectApplyArgs,
  DetectApplyResult,
  DetectEnvCheck,
  DetectJobSnapshot,
  DetectRunArgs,
  DetectRunResult,
  ExtractFrameArgs,
  ExtractFramesArgs,
  ExtractFramesResult,
  ExtractFrameResult,
  ImportResult,
  MediaInfo,
  MediaProbeArgs,
  MediaProbeResult,
  Note,
  NoteUpsertArgs,
  PlayerState,
  OverlayLayer,
  Project,
  ProjectCreateArgs,
  ProjectOpenArgs,
  ProjectOpenResult,
  ProjectSaveArgs,
  ProjectSaveResult,
  ProjectUpdateArgs,
  RenderBounds,
  ScopeExtractAudioWaveformArgs,
  Settings,
  SettingsChooseDirectoryArgs,
  SettingsMigrationConfirmArgs,
  SettingsMigrationPreview,
  SettingsMigrationResult,
  SettingsSetArgs,
  Shot,
  ShotCreateArgs,
  ShotUpdateArgs,
  Still,
  StillCaptureArgs,
  StillCaptureAtArgs,
  StillCreateArgs,
  StillSetAnnotationArgs,
  StillUpdateArgs,
  Tag,
  TagCreateArgs,
  TagUpdateArgs,
  Term,
  TermCreateArgs,
  TermExportResult,
  TermImportResult,
  TermUpdateArgs,
  TranscodeProxyArgs,
  TranscodeProxyResult,
  TranscodeQueueItem,
  StoryboardExportArgs,
  StoryboardExportResult,
  AudioWaveform,
  WorkspaceState,
  StatsProgress,
  StatsRhythmPoint,
  StatsTagDistributionItem,
} from '../../shared/types';
import type { DataLayer } from '../../data/db';
import type { CaptureService } from '../capture/capture-service';
import type { DetectService } from '../detect/detect-service';
import type { ExportService } from '../export/export-service';
import { DataError } from '../../data/errors';
import { importProjectFrom, scanCandidateRoots } from '../data/import-service';
import type { ProjectPackageService } from '../../data/project-package';
import { MediaError } from '../media/media-error';
import type { MediaService } from '../media/media-service';
import type { AiAccessService } from '../ai/mcp-server';
import { PlayerError } from '../player/mpv-lib';
import type { PlayerService } from '../player/player-service';
import type { ScopeService } from '../scope/scope-service';
import { SettingsError, type SettingsService } from '../settings/settings-service';
import { SessionError, type SessionService } from '../session/session-service';
import type { StatsService } from '../stats/stats-service';
import type { TermTransferService } from '../terms/term-transfer-service';
import { resolveProjectStillDir } from '../paths';

export interface IpcDeps {
  getWindow(): BrowserWindow | null;
  getPlayer(): PlayerService | null;
  getMedia(): MediaService | null;
  getData(): DataLayer | null;
  getPackage(): ProjectPackageService | null;
  getCapture(): CaptureService | null;
  getTermTransfer(): TermTransferService | null;
  getExport(): ExportService | null;
  getDetect(): DetectService | null;
  getScope(): ScopeService | null;
  getSettings(): SettingsService | null;
  previewSettingsMigration(): SettingsMigrationPreview;
  confirmSettingsMigration(projectIds: string[]): SettingsMigrationResult;
  skipSettingsMigration(): Settings;
  cancelSettingsMigration(): Settings;
  getSession(): SessionService | null;
  getStats(): StatsService | null;
  getAi(): AiAccessService | null;
}

/**
 * IPC 注册器（docs/S01 §4 / §6.2）。
 * 所有 handler 经 withEnvelope 统一返回 IpcResult 信封；错误码由领域 Error 透传。
 */
export function registerIpcHandlers(deps: IpcDeps): void {
  const requirePlayer = (): PlayerService => {
    const player = deps.getPlayer();
    if (!player) throw new PlayerError('PLAYER_UNAVAILABLE', '播放器尚未初始化');
    return player;
  };
  const requireMedia = (): MediaService => {
    const media = deps.getMedia();
    if (!media) throw new MediaError('MEDIA_UNAVAILABLE', '媒体服务尚未初始化');
    return media;
  };
  const requireAi = (): AiAccessService => {
    const service = deps.getAi();
    if (!service) throw new Error('AI 服务尚未就绪');
    return service;
  };
  const requireData = (): DataLayer => {
    const data = deps.getData();
    if (!data) throw new DataError('DATA_UNAVAILABLE', '数据层尚未初始化');
    return data;
  };
  const requirePackage = (): ProjectPackageService => {
    const service = deps.getPackage();
    if (!service) throw new DataError('DATA_UNAVAILABLE', '项目包服务尚未初始化');
    return service;
  };
  const requireCapture = (): CaptureService => {
    const capture = deps.getCapture();
    if (!capture) throw new DataError('DATA_UNAVAILABLE', '静帧截图服务尚未初始化');
    return capture;
  };
  const requireTermTransfer = (): TermTransferService => {
    const service = deps.getTermTransfer();
    if (!service) throw new DataError('DATA_UNAVAILABLE', '术语导入导出服务尚未初始化');
    return service;
  };
  const requireExport = (): ExportService => {
    const service = deps.getExport();
    if (!service) throw new DataError('DATA_UNAVAILABLE', '导出服务尚未初始化');
    return service;
  };
  const requireDetect = (): DetectService => {
    const service = deps.getDetect();
    if (!service) throw new DataError('DATA_UNAVAILABLE', '镜头检测服务尚未初始化');
    return service;
  };
  const requireScope = (): ScopeService => {
    const service = deps.getScope();
    if (!service) throw new DataError('DATA_UNAVAILABLE', '示波器服务尚未初始化');
    return service;
  };
  const requireSettings = (): SettingsService => {
    const service = deps.getSettings();
    if (!service) throw new SettingsError('SETTINGS_UNAVAILABLE', '设置服务尚未初始化');
    return service;
  };
  const requireSession = (): SessionService => {
    const service = deps.getSession();
    if (!service) throw new SessionError('SESSION_UNAVAILABLE', '会话服务尚未初始化');
    return service;
  };
  const requireStats = (): StatsService => {
    const service = deps.getStats();
    if (!service) throw new DataError('DATA_UNAVAILABLE', '统计服务尚未初始化');
    return service;
  };

  ipcMain.handle(
    IPC.APP_INFO,
    withEnvelope((): AppInfo => ({
      version: app.getVersion(),
      platform: process.platform,
      appDataPath: app.getPath('userData'),
    })),
  );

  ipcMain.handle(
    IPC.AI_COPY_PROMPT,
    withEnvelope((args: AiCopyPromptArgs): AiCopyPromptResult => requireAi().copyPrompt(args)),
  );
  ipcMain.handle(
    IPC.AI_GET_SNAPSHOT,
    withEnvelope((args: { projectId: string }): AiProjectSnapshot => requireAi().getSnapshot(args.projectId)),
  );
  ipcMain.handle(
    IPC.AI_START_MCP,
    withEnvelope((args: { enabled: boolean }): Promise<AiMcpStatus> => requireAi().setEnabled(args.enabled)),
  );
  ipcMain.handle(
    IPC.AI_GET_MCP_STATUS,
    withEnvelope((): AiMcpStatus => requireAi().getStatus()),
  );
  ipcMain.handle(
    IPC.AI_RESPOND_MCP_AUTH,
    withEnvelope((args: AiMcpAuthResponseArgs): { responded: boolean } => requireAi().respondMcpAuth(args)),
  );

  // ---------- settings ----------
  ipcMain.handle(
    IPC.SETTINGS_GET,
    withEnvelope((): Settings => requireSettings().get()),
  );
  ipcMain.handle(
    IPC.SETTINGS_SET,
    withEnvelope((args: SettingsSetArgs): Settings => requireSettings().set(args)),
  );
  ipcMain.handle(
    IPC.SETTINGS_CHOOSE_DIRECTORY,
    withEnvelope((args: SettingsChooseDirectoryArgs): Promise<string | null> =>
      requireSettings().chooseDirectory(args),
    ),
  );
  ipcMain.handle(
    IPC.SETTINGS_PREVIEW_MIGRATION,
    withEnvelope((): SettingsMigrationPreview => deps.previewSettingsMigration()),
  );
  ipcMain.handle(
    IPC.SETTINGS_CONFIRM_MIGRATION,
    withEnvelope((args: SettingsMigrationConfirmArgs): SettingsMigrationResult =>
      deps.confirmSettingsMigration(args.projectIds),
    ),
  );
  ipcMain.handle(
    IPC.SETTINGS_SKIP_MIGRATION,
    withEnvelope((): Settings => deps.skipSettingsMigration()),
  );
  ipcMain.handle(
    IPC.SETTINGS_CANCEL_MIGRATION,
    withEnvelope((): Settings => deps.cancelSettingsMigration()),
  );

  // ---------- session ----------
  ipcMain.handle(
    IPC.SESSION_GET,
    withEnvelope((): WorkspaceState | null => requireSession().get()),
  );
  ipcMain.handle(
    IPC.SESSION_SAVE,
    withEnvelope((state: WorkspaceState): WorkspaceState => requireSession().save(state)),
  );
  ipcMain.handle(
    IPC.SESSION_CLEAR,
    withEnvelope((): { cleared: true } => requireSession().clear()),
  );

  // ---------- player ----------
  ipcMain.handle(
    IPC.PLAYER_OPEN,
    withEnvelope((args: { mediaPath?: string; projectId?: string }): Promise<MediaInfo> =>
      requirePlayer().open(args),
    ),
  );
  ipcMain.handle(
    IPC.PLAYER_OPEN_DIALOG,
    withEnvelope((): Promise<MediaInfo | null> => requirePlayer().openDialog()),
  );
  ipcMain.handle(
    IPC.PLAYER_CLOSE,
    withEnvelope((): void => requirePlayer().close()),
  );
  ipcMain.handle(
    IPC.PLAYER_PLAY,
    withEnvelope((): Promise<PlayerState> => requirePlayer().play()),
  );
  ipcMain.handle(
    IPC.PLAYER_PAUSE,
    withEnvelope((): Promise<PlayerState> => requirePlayer().pause()),
  );
  ipcMain.handle(
    IPC.PLAYER_TOGGLE,
    withEnvelope((): Promise<PlayerState> => requirePlayer().toggle()),
  );
  ipcMain.handle(
    IPC.PLAYER_SEEK,
    withEnvelope((args: { timeMs: number; exact?: boolean }): Promise<PlayerState> =>
      requirePlayer().seek(args.timeMs, args.exact ?? true),
    ),
  );
  ipcMain.handle(
    IPC.PLAYER_FRAME_STEP,
    withEnvelope((args: { dir: 1 | -1 }) => requirePlayer().frameStep(args.dir)),
  );
  ipcMain.handle(
    IPC.PLAYER_GET_STATE,
    withEnvelope((): PlayerState => requirePlayer().getState()),
  );
  ipcMain.handle(
    IPC.PLAYER_GET_FRAME,
    withEnvelope(() => requirePlayer().getFrame()),
  );
  ipcMain.handle(
    IPC.PLAYER_SET_VOLUME,
    withEnvelope((args: { volume: number }): Promise<PlayerState> => requirePlayer().setVolume(args.volume)),
  );
  ipcMain.handle(
    IPC.PLAYER_GET_SPEED,
    withEnvelope((): number => requirePlayer().getSpeed()),
  );
  ipcMain.handle(
    IPC.PLAYER_SET_SPEED,
    withEnvelope((args: { rate: number }): Promise<PlayerState> => requirePlayer().setSpeed(args.rate)),
  );
  ipcMain.handle(
    IPC.PLAYER_SET_BOUNDS,
    withEnvelope((bounds: RenderBounds): void => requirePlayer().setBounds(bounds)),
  );
  ipcMain.handle(
    IPC.PLAYER_SET_LAYER,
    withEnvelope((args: { level: OverlayLayer }): PlayerState =>
      requirePlayer().setLayer(args.level),
    ),
  );

  // ---------- media ----------
  ipcMain.handle(
    IPC.MEDIA_PROBE,
    withEnvelope((args: MediaProbeArgs): Promise<MediaProbeResult> => requireMedia().probe(args)),
  );
  ipcMain.handle(
    IPC.MEDIA_EXTRACT_FRAME,
    withEnvelope((args: ExtractFrameArgs): Promise<ExtractFrameResult> => requireMedia().extractFrame(args)),
  );
  ipcMain.handle(
    IPC.MEDIA_EXTRACT_FRAMES,
    withEnvelope((args: ExtractFramesArgs): Promise<ExtractFramesResult> => requireMedia().extractFrames(args)),
  );
  ipcMain.handle(
    IPC.MEDIA_TRANSCODE_PROXY,
    withEnvelope((args: TranscodeProxyArgs): Promise<TranscodeProxyResult> => requireMedia().transcodeProxy(args)),
  );
  ipcMain.handle(
    IPC.MEDIA_CANCEL_JOB,
    withEnvelope((args: { jobId: string }): CancelJobResult => requireMedia().cancelJob(args.jobId)),
  );
  ipcMain.handle(
    IPC.MEDIA_QUEUE_LIST,
    withEnvelope((): TranscodeQueueItem[] => requireMedia().queueList()),
  );
  ipcMain.handle(
    IPC.MEDIA_SET_TRANSCODE_CONCURRENCY,
    withEnvelope((args: { concurrency: 1 | 2 }): { concurrency: number } => {
      requireMedia().setTranscodeConcurrency(args.concurrency);
      return { concurrency: args.concurrency };
    }),
  );

  // ---------- scope ----------
  ipcMain.handle(
    IPC.SCOPE_EXTRACT_AUDIO_WAVEFORM,
    withEnvelope((args: ScopeExtractAudioWaveformArgs): Promise<AudioWaveform> =>
      requireScope().extractAudioWaveform(args),
    ),
  );

  // ---------- detect ----------
  ipcMain.handle(
    IPC.DETECT_CHECK_ENV,
    withEnvelope((): Promise<DetectEnvCheck> => requireDetect().checkEnvironment()),
  );
  ipcMain.handle(
    IPC.DETECT_RUN,
    withEnvelope((args: DetectRunArgs): DetectRunResult => requireDetect().run(args)),
  );
  ipcMain.handle(
    IPC.DETECT_CANCEL,
    withEnvelope((args: { jobId: string }): void => requireDetect().cancel(args.jobId)),
  );
  ipcMain.handle(
    IPC.DETECT_GET_JOB,
    withEnvelope((args: { jobId: string }): DetectJobSnapshot => requireDetect().getJob(args.jobId)),
  );
  ipcMain.handle(
    IPC.DETECT_APPLY,
    withEnvelope((args: DetectApplyArgs): DetectApplyResult => requireDetect().apply(args)),
  );

  // ---------- data: external project import ----------
  ipcMain.handle(
    IPC.DATA_SCAN_CANDIDATES,
    withEnvelope((): CandidateSource[] => scanCandidateRoots(requireData())),
  );
  ipcMain.handle(
    IPC.DATA_IMPORT_PROJECT,
    withEnvelope((args: { root: string; projectId: string }): ImportResult =>
      importProjectFrom(requireData(), args.root, args.projectId),
    ),
  );

  // ---------- data: project ----------
  ipcMain.handle(
    IPC.PROJECT_CREATE,
    withEnvelope((args: ProjectCreateArgs): Project => requireData().projects.create(args)),
  );
  ipcMain.handle(
    IPC.PROJECT_LIST,
    withEnvelope((): Project[] => requireData().projects.list()),
  );
  ipcMain.handle(
    IPC.PROJECT_GET,
    withEnvelope((args: { id: string }): Project => requireData().projects.get(args.id)),
  );
  ipcMain.handle(
    IPC.PROJECT_UPDATE,
    withEnvelope((args: ProjectUpdateArgs): Project => requireData().projects.update(args)),
  );
  ipcMain.handle(
    IPC.PROJECT_DELETE,
    withEnvelope((args: { id: string }): { deleted: true } => {
      requireData().projects.delete(args.id);
      return { deleted: true };
    }),
  );
  ipcMain.handle(
    IPC.PROJECT_SAVE,
    withEnvelope((args: ProjectSaveArgs): ProjectSaveResult => requirePackage().exportProject(args)),
  );
  ipcMain.handle(
    IPC.PROJECT_SAVE_AS,
    withEnvelope((args: { id: string; targetPath: string }): ProjectSaveResult =>
      requirePackage().exportProject({ id: args.id, targetPath: args.targetPath }),
    ),
  );
  ipcMain.handle(
    IPC.PROJECT_OPEN,
    withEnvelope((args: ProjectOpenArgs): ProjectOpenResult => requirePackage().importProject(args.path)),
  );

  // ---------- data: shot ----------
  ipcMain.handle(
    IPC.SHOT_LIST,
    withEnvelope((args: { projectId: string }): Shot[] => requireData().shots.list(args.projectId)),
  );
  ipcMain.handle(
    IPC.SHOT_GET,
    withEnvelope((args: { id: string }): Shot => requireData().shots.get(args.id)),
  );
  ipcMain.handle(
    IPC.SHOT_CREATE,
    withEnvelope((args: ShotCreateArgs): Shot => requireData().shots.create(args)),
  );
  ipcMain.handle(
    IPC.SHOT_UPDATE,
    withEnvelope((args: ShotUpdateArgs): Shot => requireData().shots.update(args)),
  );
  ipcMain.handle(
    IPC.SHOT_DELETE,
    withEnvelope((args: { id: string }): { deleted: true } => {
      const data = requireData();
      const projectId = data.shots.get(args.id).projectId;
      data.shots.delete(args.id, [resolveProjectStillDir(projectId)]);
      return { deleted: true };
    }),
  );

  // ---------- data: still ----------
  ipcMain.handle(
    IPC.STILL_LIST,
    withEnvelope((args: { projectId?: string; shotId?: string }): Still[] => requireData().stills.list(args)),
  );
  ipcMain.handle(
    IPC.STILL_GET,
    withEnvelope((args: { id: string }): Still => requireData().stills.get(args.id)),
  );
  ipcMain.handle(
    IPC.STILL_CAPTURE,
    withEnvelope((args: StillCaptureArgs): Promise<Still> => requireCapture().capture(args)),
  );
  ipcMain.handle(
    IPC.STILL_CAPTURE_AT,
    withEnvelope((args: StillCaptureAtArgs): Promise<Still> => requireCapture().captureAt(args)),
  );
  ipcMain.handle(
    IPC.STILL_CREATE,
    withEnvelope((args: StillCreateArgs): Still => requireData().stills.create(args)),
  );
  ipcMain.handle(
    IPC.STILL_UPDATE,
    withEnvelope((args: StillUpdateArgs): Still => requireData().stills.update(args)),
  );
  ipcMain.handle(
    IPC.STILL_SET_ANNOTATION,
    withEnvelope((args: StillSetAnnotationArgs): Still =>
      requireCapture().setAnnotations(args.id, args.annotations),
    ),
  );
  ipcMain.handle(
    IPC.STILL_DELETE,
    withEnvelope((args: { id: string }): { deleted: true } => {
      const data = requireData();
      const projectId = data.stills.get(args.id).projectId;
      data.stills.delete(args.id, [resolveProjectStillDir(projectId)]);
      return { deleted: true };
    }),
  );

  // ---------- data: tag ----------
  ipcMain.handle(
    IPC.TAG_LIST,
    withEnvelope((args: { category?: string } = {}): Tag[] => requireData().tags.list(args.category)),
  );
  ipcMain.handle(
    IPC.TAG_CREATE,
    withEnvelope((args: TagCreateArgs): Tag => requireData().tags.create(args)),
  );
  ipcMain.handle(
    IPC.TAG_UPDATE,
    withEnvelope((args: TagUpdateArgs): Tag => requireData().tags.update(args)),
  );
  ipcMain.handle(
    IPC.TAG_DELETE,
    withEnvelope((args: { id: string }): { deleted: true } => {
      requireData().tags.delete(args.id);
      return { deleted: true };
    }),
  );
  ipcMain.handle(
    IPC.TAG_ASSIGN,
    withEnvelope((args: { shotId: string; tagIds: string[] }): { shotId: string; tagIds: string[] } => {
      const tagIds = requireData().tags.assign(args.shotId, args.tagIds);
      return { shotId: args.shotId, tagIds };
    }),
  );
  ipcMain.handle(
    IPC.TAG_UNASSIGN,
    withEnvelope((args: { shotId: string; tagIds: string[] }): { shotId: string; tagIds: string[] } => {
      const tagIds = requireData().tags.unassign(args.shotId, args.tagIds);
      return { shotId: args.shotId, tagIds };
    }),
  );

  // ---------- data: note ----------
  ipcMain.handle(
    IPC.NOTE_LIST,
    withEnvelope((args: { projectId?: string; shotId?: string }): Note[] => requireData().notes.list(args)),
  );
  ipcMain.handle(
    IPC.NOTE_GET,
    withEnvelope((args: { id: string }): Note => requireData().notes.get(args.id)),
  );
  ipcMain.handle(
    IPC.NOTE_UPSERT,
    withEnvelope((args: NoteUpsertArgs): Note => requireData().notes.upsert(args)),
  );
  ipcMain.handle(
    IPC.NOTE_DELETE,
    withEnvelope((args: { id: string }): { deleted: true } => {
      requireData().notes.delete(args.id);
      return { deleted: true };
    }),
  );

  // ---------- data: term ----------
  ipcMain.handle(
    IPC.TERM_LIST,
    withEnvelope((args: { category?: string } = {}): Term[] => requireData().terms.list(args.category)),
  );
  ipcMain.handle(
    IPC.TERM_CREATE,
    withEnvelope((args: TermCreateArgs): Term => requireData().terms.create(args)),
  );
  ipcMain.handle(
    IPC.TERM_UPDATE,
    withEnvelope((args: TermUpdateArgs): Term => requireData().terms.update(args)),
  );
  ipcMain.handle(
    IPC.TERM_DELETE,
    withEnvelope((args: { id: string }): { deleted: true } => {
      requireData().terms.delete(args.id);
      return { deleted: true };
    }),
  );
  ipcMain.handle(
    IPC.TERM_IMPORT_JSON,
    withEnvelope((): Promise<TermImportResult> => requireTermTransfer().importJson()),
  );
  ipcMain.handle(
    IPC.TERM_EXPORT_JSON,
    withEnvelope((): Promise<TermExportResult> => requireTermTransfer().exportJson()),
  );

  // ---------- export ----------
  ipcMain.handle(
    IPC.EXPORT_STORYBOARD,
    withEnvelope((args: StoryboardExportArgs): Promise<StoryboardExportResult> =>
      requireExport().exportStoryboard(args),
    ),
  );

  // ---------- stats ----------
  ipcMain.handle(
    IPC.STATS_TAG_DISTRIBUTION,
    withEnvelope((args: { projectId: string }): StatsTagDistributionItem[] =>
      requireStats().tagDistribution(args.projectId),
    ),
  );
  ipcMain.handle(
    IPC.STATS_RHYTHM,
    withEnvelope((args: { projectId: string }): StatsRhythmPoint[] =>
      requireStats().rhythm(args.projectId),
    ),
  );
  ipcMain.handle(
    IPC.STATS_PROGRESS,
    withEnvelope((args: { projectId: string }): StatsProgress =>
      requireStats().progress(args.projectId),
    ),
  );
}
