import { PLAYBACK_SPEEDS, type PlaybackSpeed } from '../../shared/types';
import { getMpvLibrary, MPV_END_FILE_REASON, MPV_EVENT, MPV_FORMAT, PlayerError, toPlayerError, type MpvLibrary } from './mpv-lib';

export interface MpvClientOptions {
  /** 子窗口句柄（十进制字符串），mpv 通过 wid 嵌入渲染 */
  wid: string;
  logFile?: string;
}

export interface FrameSnapshot {
  frame: number;
  timeMs: number;
  durationMs: number;
  fps: number;
}

const EVENT_POLL_INTERVAL_MS = 10;
const PROPERTY_WAIT_TIMEOUT_MS = 3000;

export function normalizePlaybackSpeed(rate: number): PlaybackSpeed {
  if (!Number.isFinite(rate)) return 1;
  let nearest: PlaybackSpeed = PLAYBACK_SPEEDS[0];
  for (const candidate of PLAYBACK_SPEEDS) {
    if (Math.abs(candidate - rate) < Math.abs(nearest - rate)) nearest = candidate;
  }
  return nearest;
}

type PropertyValue = number | boolean;

interface Waiter {
  name: string;
  predicate: (value: PropertyValue) => boolean;
  resolve: () => void;
  timer: NodeJS.Timeout;
}

/**
 * libmpv client API 封装（单实例）。
 * - 事件泵：主线程 10ms 轮询 mpv_wait_event，维护属性缓存、分发事件；
 * - 属性读取：同步 mpv_get_property，供 getTime/getDuration/getFrame 使用；
 * - 所有失败统一抛 PlayerError（带领域错误码）。
 */
export class MpvClient {
  private readonly lib: MpvLibrary;
  private readonly ctx: unknown;
  private readonly properties = new Map<string, PropertyValue>();
  private readonly waiters = new Set<Waiter>();
  private readonly observed = new Map<bigint, string>();
  private pollTimer: NodeJS.Timeout | null = null;
  private loadWaiter: { resolve: () => void; reject: (error: PlayerError) => void } | null = null;
  private restartWaiters: Array<() => void> = [];
  private destroyed = false;
  private fileLoaded = false;
  private loadInfo = { width: 0, height: 0, fps: 0, durationMs: 0 };
  private loadedPath: string | null = null;

  onEnded: (() => void) | null = null;
  onFileLoaded: (() => void) | null = null;
  onLogError: ((message: string) => void) | null = null;
  onPlaybackError: ((error: PlayerError) => void) | null = null;

  constructor() {
    this.lib = getMpvLibrary();
    this.ctx = this.lib.fns.create();
    if (!this.ctx) {
      throw new PlayerError('MPV_INIT_FAILED', 'mpv_create() 返回空句柄');
    }
  }

  initialize(options: MpvClientOptions): void {
    const { fns } = this.lib;

    const setOption = (name: string, value: string): void => {
      const rc = fns.setOptionString(this.ctx, name, value);
      if (rc < 0) {
        throw toPlayerError(rc, `设置 mpv 选项 ${name} 失败`);
      }
    };

    const options_: Record<string, string> = {
      terminal: 'no',
      'msg-level': 'all=error',
      config: 'no',
      idle: 'yes',
      'keep-open': 'yes',
      pause: 'yes',
      'input-default-bindings': 'no',
      'input-terminal': 'no',
      osc: 'no',
      'osd-level': '0',
      'osd-on-seek': 'no',
      'osd-bar': 'no',
      'audio-pitch-correction': 'yes',
      'hr-seek': 'yes',
      'hr-seek-framedrop': 'no',
      'hwdec': 'auto',
      vo: 'gpu',
      'gpu-api': 'd3d11',
      wid: options.wid,
    };
    if (options.logFile) options_.log = 'no';
    for (const [name, value] of Object.entries(options_)) {
      setOption(name, value);
    }

    const rc = fns.initialize(this.ctx);
    if (rc < 0) {
      throw toPlayerError(rc, 'mpv 初始化失败');
    }

    fns.requestLogMessages(this.ctx, 'error');

    const properties: Array<[string, number]> = [
      ['time-pos', MPV_FORMAT.DOUBLE],
      ['duration', MPV_FORMAT.DOUBLE],
      ['pause', MPV_FORMAT.FLAG],
      ['eof-reached', MPV_FORMAT.FLAG],
      ['volume', MPV_FORMAT.DOUBLE],
      ['speed', MPV_FORMAT.DOUBLE],
    ];
    let id = 1n;
    for (const [name, format] of properties) {
      const formatValue = fns.observeProperty(this.ctx, id, name, format);
      if (formatValue >= 0) this.observed.set(id, name);
      id += 1n;
    }

    this.pollTimer = setInterval(() => this.pollEvents(), EVENT_POLL_INTERVAL_MS);
    this.pollTimer.unref?.();
  }

  /** 当前是否已加载文件 */
  get hasFile(): boolean {
    return this.fileLoaded;
  }

  get path(): string | null {
    return this.loadedPath;
  }

  async loadFile(filePath: string, timeoutMs = 15000): Promise<void> {
    this.fileLoaded = false;
    this.loadedPath = null;

    const rc = this.lib.fns.commandString(this.ctx, `loadfile "${escapeMpvPath(filePath)}"`);
    if (rc < 0) {
      throw toPlayerError(rc, '加载文件失败');
    }

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.loadWaiter = null;
        reject(new PlayerError('FILE_LOAD_TIMEOUT', `加载文件超时（${timeoutMs}ms）`));
      }, timeoutMs);

      this.loadWaiter = {
        resolve: () => {
          clearTimeout(timer);
          this.loadWaiter = null;
          resolve();
        },
        reject: (error) => {
          clearTimeout(timer);
          this.loadWaiter = null;
          reject(error);
        },
      };
    });

    this.loadInfo = {
      width: this.getInt('video-params/w') ?? 0,
      height: this.getInt('video-params/h') ?? 0,
      fps: this.getNumber('container-fps') ?? 0,
      durationMs: Math.round((this.getNumber('duration') ?? 0) * 1000),
    };

    if (this.loadInfo.width <= 0 || this.loadInfo.height <= 0) {
      this.stop();
      throw new PlayerError('UNSUPPORTED_FORMAT', '该文件没有可显示的图像轨道（格式不支持）');
    }

    this.loadedPath = filePath;
    this.lib.fns.setPropertyString(this.ctx, 'speed', '1.0');
    this.fileLoaded = true;
  }

  play(): Promise<void> {
    return this.setPaused(false);
  }

  pause(): Promise<void> {
    return this.setPaused(true);
  }

  async toggle(): Promise<void> {
    const paused = this.getFlag('pause') ?? true;
    await this.setPaused(!paused);
  }

  async seekMs(timeMs: number, exact = true): Promise<void> {
    const durationMs = this.getDurationMs();
    const targetMs = Math.max(0, Math.min(timeMs, Math.max(0, durationMs - 1)));
    const seconds = (targetMs / 1000).toFixed(3);
    const mode = exact ? 'absolute+exact' : 'absolute';
    const rc = this.lib.fns.commandString(this.ctx, `seek ${seconds} ${mode}`);
    if (rc < 0) {
      throw toPlayerError(rc, 'seek 失败');
    }

    // 等精确 seek 完成：mpv 会在目标帧显示后发出 playback-restart
    await this.waitForPlaybackRestart(PROPERTY_WAIT_TIMEOUT_MS).catch(() => undefined);
    const deadline = Date.now() + PROPERTY_WAIT_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const current = this.getTimeMs();
      if (Math.abs(current - targetMs) <= 24) return;
      await delay(8);
    }
  }

  /**
   * 逐帧步进。为保证「帧级定位」稳定：先暂停，再下发 frame-step，等待 time-pos 实际变化。
   */
  async frameStep(dir: 1 | -1): Promise<FrameSnapshot> {
    await this.pause();
    // 等当前帧真正显示且属性稳定，避免在上一次 seek/步进未落定时继续步进
    await this.waitForStableTime(400);

    const before = this.getFrame();
    const frameDurationMs = before.fps > 0 ? 1000 / before.fps : 40;
    // 片头/片尾边界：返回当前帧而不是报错，避免快捷键在边界频繁弹错误
    if (dir < 0 && before.frame <= 0) return before;
    if (
      dir > 0 &&
      before.durationMs > 0 &&
      before.timeMs >= before.durationMs - frameDurationMs * 1.5
    ) {
      return before;
    }
    const command = dir > 0 ? 'frame-step' : 'frame-back-step';
    const rc = this.lib.fns.commandString(this.ctx, command);
    if (rc < 0) {
      throw toPlayerError(rc, `${command} 失败`);
    }

    const deadline = Date.now() + PROPERTY_WAIT_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const current = this.getFrame();
      const frameChanged = current.frame !== before.frame;
      const timeChanged = Math.abs(current.timeMs - before.timeMs) >= Math.max(2, frameDurationMs * 0.5);
      if (frameChanged || timeChanged) {
        await this.waitForStableTime(400);
        return this.getFrame();
      }
      await delay(8);
    }

    throw new PlayerError('FRAME_STEP_FAILED', '逐帧步进未生效（可能已到片头/片尾）');
  }

  getTimeMs(): number {
    const value = this.getNumber('time-pos');
    if (value !== null) return Math.max(0, Math.round(value * 1000));
    const cached = this.properties.get('time-pos');
    return typeof cached === 'number' ? Math.max(0, Math.round(cached * 1000)) : 0;
  }

  getDurationMs(): number {
    const value = this.getNumber('duration');
    if (value !== null && value > 0) return Math.round(value * 1000);
    return this.loadInfo.durationMs;
  }

  getFrame(): FrameSnapshot {
    const timeMs = this.getTimeMs();
    const fps = this.loadInfo.fps > 0 ? this.loadInfo.fps : (this.getNumber('container-fps') ?? 0);
    const durationMs = this.getDurationMs();
    const estimated = this.getInt('estimated-frame-number');
    const frame = estimated !== null && estimated >= 0 ? Number(estimated) : Math.round((timeMs / 1000) * fps);
    return { frame, timeMs, durationMs, fps };
  }

  getVideoSize(): { width: number; height: number; fps: number } {
    return {
      width: this.loadInfo.width,
      height: this.loadInfo.height,
      fps: this.loadInfo.fps,
    };
  }

  getVolume(): number {
    const value = this.getNumber('volume');
    if (value !== null) return Math.max(0, Math.min(1, value / 100));
    const cached = this.properties.get('volume');
    return typeof cached === 'number' ? Math.max(0, Math.min(1, cached / 100)) : 1;
  }

  async setVolume(volume: number): Promise<void> {
    const clamped = Math.max(0, Math.min(1, volume));
    const rc = this.lib.fns.setPropertyString(this.ctx, 'volume', String(Math.round(clamped * 100)));
    if (rc < 0) {
      throw toPlayerError(rc, '设置音量失败');
    }
    await delay(10);
  }

  getSpeed(): PlaybackSpeed {
    const value = this.getNumber('speed');
    if (value !== null) return normalizePlaybackSpeed(value);
    const cached = this.properties.get('speed');
    return normalizePlaybackSpeed(typeof cached === 'number' ? cached : 1);
  }

  async setSpeed(rate: number): Promise<void> {
    const normalized = normalizePlaybackSpeed(rate);
    const rc = this.lib.fns.setPropertyString(this.ctx, 'speed', String(normalized));
    if (rc < 0) {
      throw toPlayerError(rc, '设置播放速度失败');
    }
    await delay(10);
  }

  isPaused(): boolean {
    return this.getFlag('pause') ?? true;
  }

  isEnded(): boolean {
    return this.getFlag('eof-reached') ?? false;
  }

  stop(): void {
    this.lib.fns.commandString(this.ctx, 'stop');
    this.fileLoaded = false;
    this.loadedPath = null;
    this.loadInfo = { width: 0, height: 0, fps: 0, durationMs: 0 };
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    for (const waiter of this.waiters) clearTimeout(waiter.timer);
    this.waiters.clear();
    if (this.loadWaiter) {
      this.loadWaiter.reject(new PlayerError('PLAYER_CLOSED', '播放器已关闭'));
      this.loadWaiter = null;
    }
    try {
      this.lib.fns.terminateDestroy(this.ctx);
    } catch {
      // 退出阶段的清理失败不应阻塞窗口关闭
    }
    this.properties.clear();
  }

  // ---------- 内部实现 ----------

  private async setPaused(paused: boolean): Promise<void> {
    const rc = this.lib.fns.setPropertyString(this.ctx, 'pause', paused ? 'yes' : 'no');
    if (rc < 0) {
      throw toPlayerError(rc, '设置播放/暂停失败');
    }
    await this.waitForProperty('pause', (value) => Boolean(value) === paused, 1000).catch(() => undefined);
  }

  private async waitForProperty(
    name: string,
    predicate: (value: PropertyValue) => boolean,
    timeoutMs = PROPERTY_WAIT_TIMEOUT_MS,
  ): Promise<void> {
    const cached = this.properties.get(name);
    if (cached !== undefined && predicate(cached)) return;
    await new Promise<void>((resolve, reject) => {
      const waiter: Waiter = {
        name,
        predicate,
        resolve: () => {
          clearTimeout(timer);
          this.waiters.delete(waiter);
          resolve();
        },
        timer: setTimeout(() => {
          this.waiters.delete(waiter);
          reject(new PlayerError('PROPERTY_TIMEOUT', `等待属性 ${name} 超时`));
        }, timeoutMs),
      };
      const timer = waiter.timer;
      this.waiters.add(waiter);
    });
  }

  private pollEvents(): void {
    if (this.destroyed) return;
    const { fns, structs, koffi } = this.lib;

    let processed = 0;
    while (processed < 32) {
      processed += 1;
      const pointer = fns.waitEvent(this.ctx, 0);
      if (!pointer || koffi.address(pointer) === 0n) return;
      const event = koffi.decode(pointer, structs.event) as {
        event_id: number;
        error: number;
        reply_userdata: bigint;
        data: unknown;
      };
      if (event.event_id === MPV_EVENT.NONE) return;

      switch (event.event_id) {
        case MPV_EVENT.FILE_LOADED:
          this.onFileLoaded?.();
          this.loadWaiter?.resolve();
          break;
        case MPV_EVENT.END_FILE: {
          const endFile = koffi.decode(event.data, structs.eventEndFile) as { reason: number; error: number };
          if (endFile.reason === MPV_END_FILE_REASON.ERROR) {
            const error = toPlayerError(endFile.error, '播放失败');
            if (this.loadWaiter) {
              this.loadWaiter.reject(error);
            } else {
              this.onPlaybackError?.(error);
            }
          } else if (endFile.reason === MPV_END_FILE_REASON.EOF) {
            this.onEnded?.();
          }
          break;
        }
        case MPV_EVENT.PROPERTY_CHANGE: {
          const property = koffi.decode(event.data, structs.eventProperty) as {
            name: string;
            format: number;
            data: unknown;
          };
          this.handlePropertyChange(property.name, property.format, property.data, event.reply_userdata);
          break;
        }
        case MPV_EVENT.LOG_MESSAGE: {
          const log = koffi.decode(event.data, structs.eventLogMessage) as {
            prefix: string;
            level: string;
            text: string;
          };
          if ((log.level === 'error' || log.level === 'fatal') && this.fileLoaded) {
            this.onLogError?.(`${log.prefix}${log.text}`);
          }
          break;
        }
        case MPV_EVENT.PLAYBACK_RESTART:
          this.resolveRestartWaiters();
          break;
        default:
          break;
      }
    }
  }

  private handlePropertyChange(name: string, format: number, data: unknown, _userdata: bigint): void {
    const { koffi } = this.lib;
    let value: PropertyValue | null = null;

    if (format === MPV_FORMAT.DOUBLE) {
      value = koffi.decode(data, 'double') as number;
    } else if (format === MPV_FORMAT.INT64) {
      value = Number(koffi.decode(data, 'int64') as bigint);
    } else if (format === MPV_FORMAT.FLAG) {
      value = Boolean(koffi.decode(data, 'int'));
    }

    if (value === null) {
      this.properties.delete(name);
    } else {
      this.properties.set(name, value);
    }

    for (const waiter of Array.from(this.waiters)) {
      if (waiter.name !== name) continue;
      if (waiter.predicate((this.properties.get(name) ?? value) as PropertyValue)) {
        waiter.resolve();
      }
    }
  }

  private waitForPlaybackRestart(timeoutMs = PROPERTY_WAIT_TIMEOUT_MS): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const waiter = (): void => {
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(() => {
        const index = this.restartWaiters.indexOf(waiter);
        if (index >= 0) this.restartWaiters.splice(index, 1);
        reject(new PlayerError('PLAYBACK_RESTART_TIMEOUT', '等待播放重启超时'));
      }, timeoutMs);
      this.restartWaiters.push(waiter);
    });
  }

  private resolveRestartWaiters(): void {
    const waiters = this.restartWaiters.splice(0);
    for (const waiter of waiters) waiter();
  }

  /** 轮询 time-pos，直到连续两次采样一致（最多 timeoutMs） */
  private async waitForStableTime(timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    let last = this.getTimeMs();
    while (Date.now() < deadline) {
      await delay(12);
      const current = this.getTimeMs();
      if (current === last) return;
      last = current;
    }
  }

  private getNumber(name: string): number | null {
    const buffer = Buffer.alloc(8);
    if (this.lib.fns.getProperty(this.ctx, name, MPV_FORMAT.DOUBLE, buffer) < 0) return null;
    const value = buffer.readDoubleLE(0);
    return Number.isFinite(value) ? value : null;
  }

  private getInt(name: string): number | null {
    const buffer = Buffer.alloc(8);
    if (this.lib.fns.getProperty(this.ctx, name, MPV_FORMAT.INT64, buffer) < 0) return null;
    return Number(buffer.readBigInt64LE(0));
  }

  private getFlag(name: string): boolean | null {
    const buffer = Buffer.alloc(4);
    if (this.lib.fns.getProperty(this.ctx, name, MPV_FORMAT.FLAG, buffer) < 0) return null;
    return buffer.readInt32LE(0) !== 0;
  }
}

function escapeMpvPath(filePath: string): string {
  return filePath.replace(/\\/g, '/').replace(/"/g, '\\"');
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
