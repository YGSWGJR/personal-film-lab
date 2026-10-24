import { app, ipcMain, type BrowserWindow } from 'electron';
import { IPC } from '../../shared/ipc-channels';
import { withEnvelope } from '../../shared/ipc-result';
import type {
  AppInfo,
  CancelJobResult,
  ExtractFrameArgs,
  ExtractFramesArgs,
  ExtractFramesResult,
  ExtractFrameResult,
  MediaInfo,
  MediaProbeArgs,
  MediaProbeResult,
  PlayerState,
  RenderBounds,
  TranscodeProxyArgs,
  TranscodeProxyResult,
} from '../../shared/types';
import { MediaError } from '../media/media-error';
import { PlayerError } from '../player/mpv-lib';
import type { MediaService } from '../media/media-service';
import type { PlayerService } from '../player/player-service';

export interface IpcDeps {
  getWindow(): BrowserWindow | null;
  getPlayer(): PlayerService | null;
  getMedia(): MediaService | null;
}

/**
 * IPC 注册器（docs/S01 §4 / §6.2）。
 * 所有 handler 经 withEnvelope 统一返回 IpcResult 信封；错误码由 PlayerError 透传。
 */
export function registerIpcHandlers(deps: IpcDeps): void {
  const requirePlayer = (): PlayerService => {
    const player = deps.getPlayer();
    if (!player) throw new PlayerError('PLAYER_UNAVAILABLE', '播放器尚未初始化');
    return player;
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
    IPC.PLAYER_SET_BOUNDS,
    withEnvelope((bounds: RenderBounds): void => requirePlayer().setBounds(bounds)),
  );

  const requireMedia = (): MediaService => {
    const media = deps.getMedia();
    if (!media) throw new MediaError('MEDIA_UNAVAILABLE', '媒体服务尚未初始化');
    return media;
  };

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
}