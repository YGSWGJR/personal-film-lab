import { appendFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { dialog, screen, type BrowserWindow } from 'electron';
import { IPC } from '../../shared/ipc-channels';
import type {
  FrameInfo,
  MediaInfo,
  PlayerState,
  RenderBounds,
  PlayerErrorEvent,
} from '../../shared/types';
import { MpvClient } from './mpv-client';
import { NativeOverlay, toPhysicalRect, windowHandleOf } from './native-overlay';
import { PlayerError } from './mpv-lib';

const TIME_EVENT_INTERVAL_MS = 100;
const VIDEO_FILTERS = [
  { name: '视频文件', extensions: ['mp4', 'mkv', 'mov', 'webm', 'avi', 'm4v', 'ts', 'flv', 'wmv', 'mpg', 'mpeg'] },
  { name: '全部文件', extensions: ['*'] },
];

/**
 * PlayerService（docs/S01 §5.1）：
 * 负责 libmpv 实例生命周期、播放/暂停/seek/逐帧步进、状态推送，以及原生视频子窗口的位置同步。
 * IPC 契约见 S01 §6.2 player 域；服务不解析媒体文件（探测归 MediaService）。
 */
export class PlayerService {
  private client: MpvClient | null = null;
  private overlay: NativeOverlay | null = null;
  private bounds: RenderBounds | null = null;
  private media: MediaInfo | null = null;
  private timeTimer: NodeJS.Timeout | null = null;
  private lastDecodeErrorAt = 0;

  private readonly handleWindowBoundsChange = (): void => this.syncOverlayBounds();
  private readonly handleWindowHide = (): void => this.overlay?.hide();
  private readonly handleWindowShow = (): void => {
    if (this.media && this.bounds && this.bounds.width > 2 && this.bounds.height > 2) {
      this.overlay?.show();
    }
  };

  constructor(private readonly win: BrowserWindow) {
    win.on('resize', this.handleWindowBoundsChange);
    win.on('move', this.handleWindowBoundsChange);
    win.on('minimize', this.handleWindowHide);
    win.on('hide', this.handleWindowHide);
    win.on('restore', this.handleWindowShow);
    win.on('show', this.handleWindowShow);
    win.on('closed', () => this.destroy());
  }

  // ---------- 渲染区域 ----------

  setBounds(bounds: RenderBounds): void {
    this.bounds = bounds;
    this.syncOverlayBounds();
    if (process.env['DSH_PLAYER_DEBUG']) {
      try {
        const physical = toPhysicalRect(this.win, bounds);
        appendFileSync(
          process.env['DSH_PLAYER_DEBUG'],
          `${JSON.stringify({
            bounds,
            physical,
            overlayRect: this.overlay?.getRect() ?? null,
            winBounds: this.win.getBounds(),
            contentBounds: this.win.getContentBounds(),
            scale: screen.getDisplayMatching(this.win.getBounds()).scaleFactor,
          })}\n`,
          'utf8',
        );
      } catch {
        // 调试日志失败不影响播放
      }
    }
  }

  private syncOverlayBounds(): void {
    if (!this.overlay || !this.bounds) return;
    const physical = toPhysicalRect(this.win, this.bounds);
    if (!this.media || physical.width < 2 || physical.height < 2) {
      this.overlay.hide();
      return;
    }
    this.overlay.setBounds(physical);
    this.overlay.show();
  }

  // ---------- 播放控制 ----------

  async open(args: { mediaPath?: string; projectId?: string }): Promise<MediaInfo> {
    if (!args.mediaPath) {
      throw new PlayerError(
        'PROJECT_PLAYER_NOT_READY',
        '按 projectId 打开需要数据层（阶段 1），当前请传入 mediaPath',
      );
    }

    const mediaPath = resolve(args.mediaPath);
    let stat;
    try {
      stat = statSync(mediaPath);
    } catch {
      throw new PlayerError('FILE_NOT_FOUND', `文件不存在：${mediaPath}`);
    }
    if (!stat.isFile()) {
      throw new PlayerError('FILE_NOT_FOUND', `路径不是文件：${mediaPath}`);
    }
    if (stat.size === 0) {
      throw new PlayerError('FILE_EMPTY', `文件为空：${mediaPath}`);
    }

    this.ensurePlayer();
    this.overlay?.show();

    try {
      await this.client!.loadFile(mediaPath, 15000);
    } catch (error) {
      this.media = null;
      this.stopTimeEvents();
      this.overlay?.hide();
      throw error;
    }

    const size = this.client!.getVideoSize();
    this.media = {
      path: mediaPath,
      durationMs: this.client!.getDurationMs(),
      width: size.width,
      height: size.height,
      fps: size.fps,
    };

    this.syncOverlayBounds();
    this.startTimeEvents();
    this.emit(IPC.PLAYER_EVENT_LOADED, this.media);
    this.emitState();
    return this.media;
  }

  async openDialog(): Promise<MediaInfo | null> {
    const result = await dialog.showOpenDialog(this.win, {
      title: '打开影片',
      properties: ['openFile'],
      filters: VIDEO_FILTERS,
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    return this.open({ mediaPath: result.filePaths[0] });
  }

  async play(): Promise<PlayerState> {
    const client = this.requirePlayer();
    await client.play();
    this.emitState();
    return this.getState();
  }

  async pause(): Promise<PlayerState> {
    const client = this.requirePlayer();
    await client.pause();
    this.emitState();
    return this.getState();
  }

  async toggle(): Promise<PlayerState> {
    const client = this.requirePlayer();
    await client.toggle();
    this.emitState();
    return this.getState();
  }

  async seek(timeMs: number, exact = true): Promise<PlayerState> {
    const client = this.requirePlayer();
    await client.seekMs(timeMs, exact);
    const state = this.getState();
    this.emit(IPC.PLAYER_EVENT_TIME, { timeMs: state.timeMs });
    this.emitState();
    return state;
  }

  async frameStep(dir: 1 | -1): Promise<FrameInfo> {
    const client = this.requirePlayer();
    const snapshot = await client.frameStep(dir);
    this.emit(IPC.PLAYER_EVENT_TIME, { timeMs: snapshot.timeMs });
    this.emitState();
    return snapshot;
  }

  getFrame(): FrameInfo {
    const client = this.requirePlayer();
    return client.getFrame();
  }

  async setVolume(volume: number): Promise<PlayerState> {
    const client = this.requirePlayer();
    await client.setVolume(volume);
    this.emitState();
    return this.getState();
  }

  close(): void {
    if (!this.client) return;
    this.client.stop();
    this.media = null;
    this.stopTimeEvents();
    this.overlay?.hide();
    this.emitState();
  }

  getState(): PlayerState {
    const client = this.client;
    if (!client || !this.media || !client.hasFile) {
      return {
        hasFile: false,
        timeMs: 0,
        durationMs: 0,
        paused: true,
        ended: false,
        volume: 1,
        width: 0,
        height: 0,
        fps: 0,
      };
    }
    return {
      hasFile: true,
      timeMs: client.getTimeMs(),
      durationMs: client.getDurationMs(),
      paused: client.isPaused(),
      ended: client.isEnded(),
      volume: client.getVolume(),
      width: this.media.width,
      height: this.media.height,
      fps: this.media.fps,
    };
  }

  destroy(): void {
    this.stopTimeEvents();
    this.win.removeListener('resize', this.handleWindowBoundsChange);
    this.win.removeListener('move', this.handleWindowBoundsChange);
    this.win.removeListener('minimize', this.handleWindowHide);
    this.win.removeListener('hide', this.handleWindowHide);
    this.win.removeListener('restore', this.handleWindowShow);
    this.win.removeListener('show', this.handleWindowShow);
    this.client?.destroy();
    this.client = null;
    this.overlay?.destroy();
    this.overlay = null;
  }

  // ---------- 内部实现 ----------

  private ensurePlayer(): void {
    if (this.client && this.overlay) return;

    if (!this.overlay) {
      const parent = windowHandleOf(this.win);
      const rect = this.bounds
        ? toPhysicalRect(this.win, this.bounds)
        : { x: 0, y: 0, width: 1, height: 1 };
      this.overlay = NativeOverlay.create(parent, rect);
      if (this.bounds) this.syncOverlayBounds();
    }

    if (!this.client) {
      const client = new MpvClient();
      try {
        client.initialize({ wid: this.overlay.wid });
      } catch (error) {
        client.destroy();
        throw error;
      }
      client.onEnded = () => this.emitState();
      client.onPlaybackError = (error) => {
        this.emitError(error.code, error.message);
        this.emitState();
      };
      client.onLogError = (message) => {
        const now = Date.now();
        if (now - this.lastDecodeErrorAt < 1000) return;
        if (!/decod|Failed to open|Invalid data|error while decoding/i.test(message)) return;
        this.lastDecodeErrorAt = now;
        this.emitError('DECODE_FAILED', `解码错误：${message}`);
      };
      this.client = client;
    }
  }

  private requirePlayer(): MpvClient {
    if (!this.client || !this.media || !this.client.hasFile) {
      throw new PlayerError('PLAYER_NOT_READY', '播放器尚未加载文件');
    }
    return this.client;
  }

  private startTimeEvents(): void {
    if (this.timeTimer) return;
    this.timeTimer = setInterval(() => {
      if (!this.media) return;
      this.emit(IPC.PLAYER_EVENT_TIME, { timeMs: this.client?.getTimeMs() ?? 0 });
    }, TIME_EVENT_INTERVAL_MS);
    this.timeTimer.unref?.();
  }

  private stopTimeEvents(): void {
    if (!this.timeTimer) return;
    clearInterval(this.timeTimer);
    this.timeTimer = null;
  }

  private emitState(): void {
    this.emit(IPC.PLAYER_EVENT_STATE, this.getState());
  }

  private emitError(code: string, message: string): void {
    const payload: PlayerErrorEvent = { code, message };
    this.emit(IPC.PLAYER_EVENT_ERROR, payload);
  }

  private emit(channel: string, payload: unknown): void {
    if (this.win.isDestroyed()) return;
    this.win.webContents.send(channel, payload);
  }
}