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
  OverlayLayer,
} from '../../shared/types';
import { MpvClient, normalizePlaybackSpeed } from './mpv-client';
import { NativeOverlay, toPhysicalRect, windowHandleOf } from './native-overlay';
import { PlayerError } from './mpv-lib';

const TIME_EVENT_INTERVAL_MS = 100;
const VIDEO_FILTERS = [
  { name: '视频文件', extensions: ['mp4', 'mkv', 'mov', 'webm', 'avi', 'm4v', 'ts', 'flv', 'wmv', 'mpg', 'mpeg'] },
  { name: '全部文件', extensions: ['*'] },
];

/** S42/Z02：overlay 操作序号（DSH_PLAYER_DEBUG 日志用，可定位时序） */
let overlayDebugSeq = 0;

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
  private layer: OverlayLayer = 'normal';
  private switchingProject = false;
  private timeTimer: NodeJS.Timeout | null = null;
  private lastDecodeErrorAt = 0;
  private destruction: Promise<void> | null = null;
  /** S42/Z02：串行化 overlay 状态迁移（hide/show/setZ/setBounds 不再交错） */
  private overlayQueue: Promise<void> = Promise.resolve();

  private readonly handleWindowBoundsChange = (): void => {
    this.enqueueOverlayOp('window-resize-move', () => {
      this.debugLog('window-bounds-change', { layer: this.layer });
      this.applyOverlayState();
    });
  };
  private readonly handleWindowHide = (): void => {
    this.enqueueOverlayOp('window-hide', () => {
      this.debugLog('window-hide', { layer: this.layer });
      this.overlay?.hide();
    });
  };
  private readonly handleWindowShow = (): void => {
    this.enqueueOverlayOp('window-show', () => {
      this.debugLog('window-show', { layer: this.layer });
      if (this.media && this.bounds && this.bounds.width > 2 && this.bounds.height > 2) {
        this.applyOverlayState();
      }
    });
  };

  constructor(private readonly win: BrowserWindow) {
    win.on('resize', this.handleWindowBoundsChange);
    win.on('move', this.handleWindowBoundsChange);
    win.on('minimize', this.handleWindowHide);
    win.on('hide', this.handleWindowHide);
    win.on('restore', this.handleWindowShow);
    win.on('show', this.handleWindowShow);
    win.on('closed', () => { void this.destroy(); });
  }

  // ---------- 渲染区域 ----------

  setBounds(bounds: RenderBounds): void {
    this.bounds = bounds;
    this.enqueueOverlayOp('set-bounds', () => {
      this.debugLog('set-bounds', { bounds, layer: this.layer });
      try {
        this.applyOverlayState();
      } catch (error) {
        this.emitError('OVERLAY_BOUNDS_FAILED', `写入视频窗口边界失败：${(error as Error).message}`);
      }
    });
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

  setLayer(level: OverlayLayer): PlayerState {
    const previous = this.layer;
    this.layer = level;
    this.enqueueOverlayOp('set-layer', () => {
      this.debugLog('set-layer', { layer: level, previous });
      try {
        this.applyOverlayState();
      } catch (error) {
        // S42/Z02：写入失败时回滚层级并报结构化错误，不残留旧框也不谎报状态
        this.layer = previous;
        try {
          this.applyOverlayState();
        } catch {
          // 恢复失败只记录
        }
        this.emitError('OVERLAY_LAYER_FAILED', `设置视频画面层级失败：${(error as Error).message}`);
      }
    });
    this.emitState();
    return this.getState();
  }

  async setProjectTransition(active: boolean): Promise<PlayerState> {
    this.switchingProject = active;
    this.enqueueOverlayOp('project-transition', () => {
      this.applyOverlayState();
      this.debugLog('project-transition', { active });
    });
    await this.overlayQueue;
    if (active && this.media && this.client && !this.client.isPaused()) await this.pause();
    return this.getState();
  }

  /**
   * S42/Z02：串行化执行 overlay 状态迁移。所有 hide/show/setZ/setBounds 都经过
   * 同一条 Promise 链，保证时序可预测、可由 DSH_PLAYER_DEBUG 日志复盘。
   */
  private enqueueOverlayOp(_label: string, op: () => void): void {
    const run = (): void => {
      try {
        op();
      } catch (error) {
        // 窗口事件路径不允许抛出（Electron 事件回调抛错会打到未捕获异常）：
        // 记录结构化错误并继续队列。
        this.debugLog('overlay-op-failed', { message: (error as Error).message });
        if (process.env['DSH_PLAYER_DEBUG']) {
          try {
            appendFileSync(
              process.env['DSH_PLAYER_DEBUG'],
              `${JSON.stringify({ seq: ++overlayDebugSeq, at: new Date().toISOString(), event: 'overlay-op-error', message: (error as Error).message })}\n`,
              'utf8',
            );
          } catch {
            // 忽略日志失败
          }
        }
      }
    };
    this.overlayQueue = this.overlayQueue.then(run, run);
  }

  /**
   * S42/Z02：把当前 {bounds, layer} 一次性写入子窗口。
   * 旧 bounds 可能压住时间线轨道（轨高变化瞬间）：先隐藏 → 写正确 bounds → 按层级恢复，
   * 整个迁移在同一宏任务内完成，不会残留旧框。
   */
  private applyOverlayState(): void {
    if (!this.overlay) return;
    if (this.switchingProject || !this.bounds) {
      this.overlay.hide();
      return;
    }
    const physical = toPhysicalRect(this.win, this.bounds);
    if (!this.media || physical.width < 2 || physical.height < 2) {
      this.overlay.hide();
      return;
    }
    const current = this.overlay.getRect();
    const changed =
      !current ||
      current.x !== physical.x ||
      current.y !== physical.y ||
      current.width !== physical.width ||
      current.height !== physical.height;
    if (changed && this.layer !== 'hidden') {
      // 旧框先让位，避免变更瞬间旧矩形压住新布局
      this.overlay.hide();
    }
    this.overlay.setBounds(physical);
    this.overlay.setZ(this.layer);
  }

  /** S42/Z02：统一 overlay 状态日志（DSH_PLAYER_DEBUG 指向文件时开启） */
  private debugLog(event: string, extra: Record<string, unknown> = {}): void {
    const target = process.env['DSH_PLAYER_DEBUG'];
    if (!target) return;
    try {
      appendFileSync(
        target,
        `${JSON.stringify({
          seq: ++overlayDebugSeq,
          at: new Date().toISOString(),
          event,
          ...extra,
          layer: this.layer,
          overlayVisible: this.overlay?.isVisible ?? null,
          zLevel: this.overlay?.currentZLevel ?? null,
          overlayRect: this.overlay?.getRect() ?? null,
        })}\n`,
        'utf8',
      );
    } catch {
      // 调试日志失败不影响播放
    }
  }

  // ---------- 播放控制 ----------

  async open(args: { mediaPath?: string; projectId?: string; startTimeMs?: number }): Promise<MediaInfo> {
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
    if (!this.switchingProject) this.overlay?.show();

    try {
      await this.client!.loadFile(mediaPath, 15000, args.startTimeMs, this.switchingProject);
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

    // S42/Z02：载入完成后立即按当前 bounds+layer 同步子窗口（同一宏任务内原子生效）
    this.applyOverlayState();
    this.debugLog('file-opened', { sourcePath: mediaPath, projectTransition: this.switchingProject });
    this.startTimeEvents();
    this.emit(IPC.PLAYER_EVENT_LOADED, this.media);
    this.emitState();
    return this.media;
  }

  async pickMedia(): Promise<string | null> {
    const result = await dialog.showOpenDialog(this.win, {
      title: '打开影片',
      properties: ['openFile'],
      filters: VIDEO_FILTERS,
    });
    return result.canceled ? null : result.filePaths[0] ?? null;
  }

  async openDialog(): Promise<MediaInfo | null> {
    const mediaPath = await this.pickMedia();
    return mediaPath ? this.open({ mediaPath }) : null;
  }

  async play(): Promise<PlayerState> {
    const client = this.requirePlayer();
    if (this.switchingProject) return this.getState();
    this.debugLog('play-request', {});
    await client.play();
    this.debugLog('play-applied', { paused: client.isPaused() });
    this.emitState();
    return this.getState();
  }

  async pause(): Promise<PlayerState> {
    const client = this.requirePlayer();
    this.debugLog('pause-request', {});
    await client.pause();
    this.debugLog('pause-applied', { paused: client.isPaused() });
    this.emitState();
    return this.getState();
  }

  async toggle(): Promise<PlayerState> {
    const client = this.requirePlayer();
    if (this.switchingProject) return this.getState();
    const before = client.isPaused();
    this.debugLog('toggle-request', { pausedBefore: before });
    await client.toggle();
    this.debugLog('toggle-applied', { pausedBefore: before, pausedAfter: client.isPaused() });
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

  async setSpeed(rate: number): Promise<PlayerState> {
    const client = this.requirePlayer();
    await client.setSpeed(normalizePlaybackSpeed(rate));
    this.emitState();
    return this.getState();
  }

  getSpeed(): number {
    return this.client?.getSpeed() ?? 1;
  }

  close(): void {
    if (!this.client) return;
    this.debugLog('close', {});
    this.client.stop();
    this.media = null;
    this.stopTimeEvents();
    this.overlay?.hide();
    this.layer = 'normal';
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
        speed: 1,
        width: 0,
        height: 0,
        fps: 0,
        layer: this.layer,
      };
    }
    return {
      hasFile: true,
      timeMs: client.getTimeMs(),
      durationMs: client.getDurationMs(),
      paused: client.isPaused(),
      ended: client.isEnded(),
      volume: client.getVolume(),
      speed: client.getSpeed(),
      width: this.media.width,
      height: this.media.height,
      fps: this.media.fps,
      layer: this.layer,
    };
  }

  destroy(): Promise<void> {
    if (this.destruction) return this.destruction;
    this.debugLog('destroy', {});
    this.stopTimeEvents();
    this.win.removeListener('resize', this.handleWindowBoundsChange);
    this.win.removeListener('move', this.handleWindowBoundsChange);
    this.win.removeListener('minimize', this.handleWindowHide);
    this.win.removeListener('hide', this.handleWindowHide);
    this.win.removeListener('restore', this.handleWindowShow);
    this.win.removeListener('show', this.handleWindowShow);
    const client = this.client;
    const overlay = this.overlay;
    this.client = null;
    this.overlay = null;
    overlay?.hide();
    this.destruction = (client?.destroy() ?? Promise.resolve()).finally(() => {
      overlay?.destroy();
      this.debugLog('destroyed', {});
    });
    return this.destruction;
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
      if (this.bounds) this.applyOverlayState();
    }

    if (!this.client) {
      const client = new MpvClient();
      try {
        client.initialize({ wid: this.overlay.wid });
      } catch (error) {
        void client.destroy();
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
