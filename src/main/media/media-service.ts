import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readdirSync, statSync, unlinkSync, existsSync } from 'node:fs';
import { basename, dirname, extname, isAbsolute, join, resolve } from 'node:path';
import type { BrowserWindow } from 'electron';
import { IPC } from '../../shared/ipc-channels';
import type {
  CancelJobResult,
  ExtractedFrameInfo,
  ExtractFrameArgs,
  ExtractFramesArgs,
  ExtractFramesResult,
  ExtractFrameResult,
  FrameFormat,
  MediaProbeArgs,
  MediaProbeResult,
  MediaProgressEvent,
  ProxyTier,
  TranscodeProxyArgs,
  TranscodeProxyResult,
  TranscodeQueueItem,
} from '../../shared/types';
import { isHardwareEncoder, resolveAvailableEncoders, selectBestEncoder } from './encoders';
import { resolveFfmpegBinaries, type FfmpegBinaries } from './ffmpeg-binaries';
import { resolveAvailableHwaccels, selectHwaccel } from './hwaccel';
import { MediaError, diagnosticsOf, tailText } from './media-error';
import { formatCommand, runProcess } from './process-runner';
import { resolveFrameCacheDir, resolveProxyCacheDir } from '../paths';

interface FfprobeStream {
  index?: number;
  codec_name?: string;
  codec_type?: string;
  width?: number;
  height?: number;
  avg_frame_rate?: string;
  r_frame_rate?: string;
  duration?: string;
  bit_rate?: string;
}

interface FfprobeFormat {
  format_name?: string;
  duration?: string;
  size?: string;
  bit_rate?: string;
}

interface FfprobeResult {
  streams?: FfprobeStream[];
  format?: FfprobeFormat;
}

interface ActiveJob {
  controller: AbortController;
  stage: MediaProgressEvent['stage'];
  startedAt: number;
}

interface TranscodeQueueEntry extends TranscodeQueueItem {
  args: TranscodeProxyArgs;
  outputPath: string;
  sourceSizeBytes: number;
  controller: AbortController;
  promise: Promise<TranscodeProxyResult>;
  resolve: (result: TranscodeProxyResult) => void;
  reject: (reason?: unknown) => void;
}

const DEFAULT_PROBE_TIMEOUT_MS = 30_000;
const DEFAULT_FRAME_TIMEOUT_MS = 60_000;
const DEFAULT_FRAMES_TIMEOUT_MS = 30 * 60_000;
const DEFAULT_TRANSCODE_TIMEOUT_MS = 60 * 60_000;
const MAX_STDERR_FOR_DIAGNOSTICS = 4000;
const HARDWARE_ENCODER_FAILURE_RE = /encoder|not supported|Cannot load|No capable|initialization failed/i;
const AUDIO_COPY_CODECS = new Set(['aac', 'mp3', 'ac3', 'eac3', 'opus', 'flac']);

type ProxyMode = 'fast' | 'balanced' | 'quality';
type ProxyResolution = 'auto' | 'p240' | 'p360' | 'p540' | 'p720' | 'p1080';

export interface ProxySizeOptions {
  srcWidth: number;
  srcHeight: number;
  mode: ProxyMode;
  resolution?: ProxyResolution;
  /** 兼容旧调用：仅覆盖 auto 分辨率模式的目标高度上限 */
  maxHeight?: number;
}

/**
 * MediaService（docs/S01 §5.2）：
 * - probe：ffprobe JSON 元信息（时长 / 分辨率 / 帧率 / 编码 / 大小 / 音轨）；
 * - extractFrame：按时间点精确抽单帧（JPG/PNG），供静帧截图与分镜本缩略图；
 * - extractFrames：按固定间隔批量抽帧（镜头检测采样），带进度事件；
 * - transcodeProxy：生成低码率代理文件（H.264 720p + AAC），保留原文件，带进度事件。
 *
 * 统一 Promise 接口；每个任务带超时、失败诊断（stderr 尾部 / 退出码 / 命令 / 耗时），
 * 长任务可通过 cancelJob 取消。
 */
export class MediaService {
  private readonly jobs = new Map<string, ActiveJob>();
  private readonly transcodeQueue: TranscodeQueueEntry[] = [];
  private transcodeActive: TranscodeQueueEntry[] = [];
  private transcodeConcurrency = 2;
  private readonly transcodeRecent: TranscodeQueueEntry[] = [];

  constructor(private readonly getWindow: () => BrowserWindow | null) {}

  async probe(args: MediaProbeArgs): Promise<MediaProbeResult> {
    const filePath = this.validateInput(args.path);
    return this.runProbe(filePath, args.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS);
  }

  async extractFrame(args: ExtractFrameArgs): Promise<ExtractFrameResult> {
    const inputPath = this.validateInput(args.path);
    const format = normalizeFormat(args.format);
    const quality = clampInt(args.quality ?? 2, 1, 31);
    const outputPath = args.outputPath
      ? this.validateOutputPath(args.outputPath)
      : join(resolveFrameCacheDir(), `${basename(inputPath, extname(inputPath))}-${Math.round(args.timeMs)}ms-${Date.now()}.${format}`);

    this.assertNotSameFile(inputPath, outputPath);
    mkdirSync(dirname(outputPath), { recursive: true });

    const { ffmpeg } = await this.ensureReady();
    const seconds = (Math.max(0, args.timeMs) / 1000).toFixed(3);
    const hwaccel =
      args.hwaccel === 'auto' || args.hwaccel === undefined
        ? selectHwaccel(await resolveAvailableHwaccels())
        : args.hwaccel;
    const buildArgs = (accel: ExtractFrameArgs['hwaccel']): string[] => [
      '-hide_banner',
      '-loglevel',
      'error',
      '-nostdin',
      ...(accel === 'cuda' ? ['-hwaccel', 'cuda', '-hwaccel_output_format', 'cuda'] : []),
      ...(accel === 'd3d11va' ? ['-hwaccel', 'd3d11va'] : []),
      '-ss',
      seconds,
      '-i',
      inputPath,
      '-frames:v',
      '1',
      '-an',
      '-sn',
      ...(accel === 'cuda' ? ['-vf', 'hwdownload,format=nv12'] : []),
      ...(format === 'png' ? ['-compression_level', '6'] : ['-q:v', String(quality)]),
      '-y',
      outputPath,
    ];
    let ffArgs = buildArgs(hwaccel);

    let result = await runProcess({
      command: ffmpeg,
      args: ffArgs,
      timeoutMs: args.timeoutMs ?? DEFAULT_FRAME_TIMEOUT_MS,
    });

    if (!result.timedOut && result.exitCode !== 0 && hwaccel !== 'none') {
      const fallbackReason = tailText(result.stderr, 500);
      console.info(`[hwaccel] fallback to software: ${fallbackReason || 'hardware decode failed'}`);
      this.removeQuietly(outputPath);
      ffArgs = buildArgs('none');
      result = await runProcess({
        command: ffmpeg,
        args: ffArgs,
        timeoutMs: args.timeoutMs ?? DEFAULT_FRAME_TIMEOUT_MS,
      });
    }

    if (result.timedOut) {
      this.removeQuietly(outputPath);
      throw new MediaError('EXTRACT_FRAME_TIMEOUT', `抽帧超时（${args.timeoutMs ?? DEFAULT_FRAME_TIMEOUT_MS}ms）`, {
        ...diagnosticsOf(formatCommand(ffmpeg, ffArgs), result),
        inputPath,
      });
    }
    if (result.exitCode !== 0) {
      this.removeQuietly(outputPath);
      throw new MediaError('EXTRACT_FRAME_FAILED', `抽帧失败：${this.stderrSummary(result.stderr)}`, {
        ...diagnosticsOf(formatCommand(ffmpeg, ffArgs), result),
        inputPath,
      });
    }

    const stat = this.statOrThrow(outputPath, 'EXTRACT_FRAME_FAILED', '未能写出帧文件');
    const frameInfo = await this.runProbe(outputPath, 15_000).catch(() => null);
    return {
      path: outputPath,
      requestedTimeMs: args.timeMs,
      width: frameInfo?.width ?? 0,
      height: frameInfo?.height ?? 0,
      sizeBytes: stat.size,
      elapsedMs: result.elapsedMs,
    };
  }

  /** 由已抽出的原图生成 JPEG 缩略图，供静帧列表和分镜本使用。 */
  async createThumbnail(inputPath: string, outputPath: string, maxWidth = 480): Promise<string> {
    const sourcePath = this.validateInput(inputPath);
    const targetPath = this.validateOutputPath(outputPath);
    this.assertNotSameFile(sourcePath, targetPath);
    mkdirSync(dirname(targetPath), { recursive: true });

    const { ffmpeg } = await this.ensureReady();
    const width = clampInt(maxWidth, 64, 1920);
    const ffArgs = [
      '-hide_banner',
      '-loglevel',
      'error',
      '-nostdin',
      '-i',
      sourcePath,
      '-frames:v',
      '1',
      '-vf',
      `scale=${width}:-2:force_original_aspect_ratio=decrease`,
      '-q:v',
      '4',
      '-y',
      targetPath,
    ];
    const result = await runProcess({
      command: ffmpeg,
      args: ffArgs,
      timeoutMs: DEFAULT_FRAME_TIMEOUT_MS,
    });
    if (result.exitCode !== 0 || result.timedOut) {
      this.removeQuietly(targetPath);
      throw new MediaError(
        result.timedOut ? 'THUMBNAIL_TIMEOUT' : 'THUMBNAIL_FAILED',
        `生成缩略图失败：${this.stderrSummary(result.stderr)}`,
        {
          ...diagnosticsOf(formatCommand(ffmpeg, ffArgs), result),
          inputPath: sourcePath,
          outputPath: targetPath,
        },
      );
    }
    this.statOrThrow(targetPath, 'THUMBNAIL_FAILED', '缩略图未生成');
    return targetPath;
  }

  async extractFrames(
    args: ExtractFramesArgs,
    controls?: {
      jobId?: string;
      onProgress?: (event: MediaProgressEvent) => void;
    },
  ): Promise<ExtractFramesResult> {
    const inputPath = this.validateInput(args.path);
    const intervalMs = Math.round(args.intervalMs);
    if (!Number.isFinite(intervalMs) || intervalMs < 50) {
      throw new MediaError('INVALID_ARGUMENT', 'intervalMs 不能小于 50ms');
    }
    const maxFrames = clampInt(args.maxFrames ?? 5000, 1, 20000);
    const format = normalizeFormat(args.format);
    const quality = clampInt(args.quality ?? 3, 1, 31);
    const outputDir = resolve(args.outputDir);
    const prefix = args.prefix ?? 'frame';
    if (!/^[A-Za-z0-9_-]+$/u.test(prefix)) {
      throw new MediaError('INVALID_ARGUMENT', 'prefix 只允许字母/数字/下划线/短横线');
    }
    mkdirSync(outputDir, { recursive: true });

    const { ffmpeg } = await this.ensureReady();
    const meta = await this.runProbe(inputPath, DEFAULT_PROBE_TIMEOUT_MS);
    if (!meta.hasVideo) {
      throw new MediaError('NO_VIDEO_STREAM', '该文件没有视频轨道，无法抽帧');
    }

    const startMs = Math.max(0, Math.min(args.startMs ?? 0, Math.max(0, meta.durationMs - 1)));
    const endMs = args.endMs !== undefined ? Math.min(args.endMs, meta.durationMs || args.endMs) : meta.durationMs;
    if (endMs <= startMs) {
      throw new MediaError('INVALID_ARGUMENT', `抽帧区间无效：startMs=${startMs} endMs=${endMs}`);
    }
    const spanMs = endMs - startMs;
    const fpsFilter = `fps=${1000}/${intervalMs}`;
    const pattern = join(outputDir, `${prefix}%06d.${format}`);

    this.cleanOldFrames(outputDir, prefix, format);
    const jobId = controls?.jobId ?? `extract-${randomUUID()}`;
    const controller = new AbortController();
    this.jobs.set(jobId, { controller, stage: 'extractFrames', startedAt: Date.now() });
    const reportProgress = (event: MediaProgressEvent): void => {
      this.emitProgress(event);
      controls?.onProgress?.(event);
    };
    reportProgress({ jobId, stage: 'extractFrames', percent: 0, message: '开始抽帧' });

    const ffArgs = [
      '-hide_banner',
      '-loglevel',
      'error',
      '-nostdin',
      '-progress',
      'pipe:1',
      '-ss',
      (startMs / 1000).toFixed(3),
      '-i',
      inputPath,
      '-t',
      (spanMs / 1000).toFixed(3),
      '-an',
      '-sn',
      '-vf',
      fpsFilter,
      '-frames:v',
      String(maxFrames),
      ...(format === 'png' ? ['-compression_level', '6'] : ['-q:v', String(quality)]),
      '-y',
      pattern,
    ];

    let lastPercent = 0;
    let lastEmitAt = 0;
    const startedAt = Date.now();

    try {
      const result = await runProcess({
        command: ffmpeg,
        args: ffArgs,
        timeoutMs: args.timeoutMs ?? DEFAULT_FRAMES_TIMEOUT_MS,
        signal: controller.signal,
        onStdoutLine: (line) => {
          const match = /^out_time_us=(\d+)$/u.exec(line.trim());
          if (!match) return;
          const outMs = Number(match[1]) / 1000;
          const percent = clampInt(Math.floor((outMs / spanMs) * 100), 0, 99);
          const now = Date.now();
          if (percent > lastPercent && (percent - lastPercent >= 1 || now - lastEmitAt > 250)) {
            lastPercent = percent;
            lastEmitAt = now;
            reportProgress({
              jobId,
              stage: 'extractFrames',
              percent,
              message: `抽帧中 ${percent}%（已处理 ${(outMs / 1000).toFixed(1)}s）`,
            });
          }
        },
      });

      if (result.timedOut) {
        throw new MediaError(
          'EXTRACT_FRAMES_TIMEOUT',
          `批量抽帧超时（${args.timeoutMs ?? DEFAULT_FRAMES_TIMEOUT_MS}ms）`,
          { ...diagnosticsOf(formatCommand(ffmpeg, ffArgs), result), inputPath, jobId },
        );
      }
      if (result.aborted) {
        throw new MediaError('CANCELLED', '批量抽帧已取消', {
          ...diagnosticsOf(formatCommand(ffmpeg, ffArgs), result),
          jobId,
        });
      }
      if (result.exitCode !== 0) {
        throw new MediaError('EXTRACT_FRAMES_FAILED', `批量抽帧失败：${this.stderrSummary(result.stderr)}`, {
          ...diagnosticsOf(formatCommand(ffmpeg, ffArgs), result),
          inputPath,
          jobId,
        });
      }

      const frames = this.collectFrames(outputDir, prefix, format, intervalMs, startMs);
      if (frames.length === 0) {
        throw new MediaError('EXTRACT_FRAMES_EMPTY', '抽帧完成但没有生成文件（时间区间可能超出影片范围）', {
          inputPath,
          outputDir,
          startMs,
          endMs,
        });
      }

      reportProgress({ jobId, stage: 'extractFrames', percent: 100, message: `抽帧完成，共 ${frames.length} 帧` });
      return {
        outputDir,
        frames,
        count: frames.length,
        intervalMs,
        startMs,
        endMs,
        elapsedMs: Date.now() - startedAt,
      };
    } catch (error) {
      // 失败/取消时清理本次可能产生的半成品帧，避免检测服务读到残缺序列
      this.cleanOldFrames(outputDir, prefix, format);
      throw error;
    } finally {
      this.jobs.delete(jobId);
    }
  }

  transcodeProxy(args: TranscodeProxyArgs): Promise<TranscodeProxyResult> {
    try {
      const sourcePath = this.validateInput(args.sourcePath);
      const sourceStat = this.statOrThrow(sourcePath, 'INPUT_NOT_FOUND', '源文件不可读');
      const tier = args.tier ?? '540p';
      const hash = proxyKey(sourcePath, sourceStat.size, sourceStat.mtimeMs, tier);
      const outputPath = args.outputPath
        ? this.validateOutputPath(args.outputPath)
        : join(resolveProxyCacheDir(), `${hash}-proxy.mp4`);

      this.assertNotSameFile(sourcePath, outputPath);
      mkdirSync(dirname(outputPath), { recursive: true });

      const pending = this.findPendingTranscode(hash);
      if (pending) return pending.promise;

      if (!existsSync(outputPath)) {
        return this.enqueueTranscode(args, sourcePath, sourceStat.size, hash, outputPath);
      }
      return this.resolveCachedTranscodeOrEnqueue(args, sourcePath, sourceStat.size, hash, outputPath);
    } catch (error) {
      return Promise.reject(error);
    }
  }

  private async resolveCachedTranscodeOrEnqueue(
    args: TranscodeProxyArgs,
    sourcePath: string,
    sourceSizeBytes: number,
    hash: string,
    outputPath: string,
  ): Promise<TranscodeProxyResult> {
    const cachedResult = await this.getCachedTranscodeResult(sourcePath, sourceSizeBytes, outputPath, hash);
    if (cachedResult) return cachedResult;

    const pending = this.findPendingTranscode(hash);
    if (pending) return pending.promise;
    return this.enqueueTranscode(args, sourcePath, sourceSizeBytes, hash, outputPath);
  }

  private enqueueTranscode(
    args: TranscodeProxyArgs,
    sourcePath: string,
    sourceSizeBytes: number,
    hash: string,
    outputPath: string,
  ): Promise<TranscodeProxyResult> {
    const jobId = `transcode-${randomUUID()}`;
    const controller = new AbortController();
    let resolve!: (result: TranscodeProxyResult) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<TranscodeProxyResult>((resolvePromise, rejectPromise) => {
      resolve = resolvePromise;
      reject = rejectPromise;
    });
    const item: TranscodeQueueEntry = {
      jobId,
      sourcePath,
      hash,
      outputPath,
      sourceSizeBytes,
      args: { ...args },
      controller,
      state: 'waiting',
      percent: 0,
      message: '等待转码',
      promise,
      resolve,
      reject,
    };

    this.transcodeQueue.push(item);
    this.emitProgress({
      jobId,
      stage: 'transcode',
      percent: 0,
      message: '等待转码',
      queueState: 'waiting',
    });
    this.pump();
    return promise;
  }

  queueList(): TranscodeQueueItem[] {
    const items = [
      ...this.transcodeQueue,
      ...this.transcodeActive,
      ...this.transcodeRecent,
    ];
    return items.map(({ jobId, sourcePath, hash, state, percent, message, encoderUsed, startedAt }) => ({
      jobId,
      sourcePath,
      hash,
      state,
      percent,
      message,
      encoderUsed,
      startedAt,
    }));
  }

  setTranscodeConcurrency(concurrency: 1 | 2): void {
    this.transcodeConcurrency = concurrency;
    if (this.transcodeActive.length < this.transcodeConcurrency) this.pump();
  }

  private async getCachedTranscodeResult(
    sourcePath: string,
    sourceSizeBytes: number,
    outputPath: string,
    hash: string,
  ): Promise<TranscodeProxyResult | null> {
    if (!existsSync(outputPath)) return null;

    let cachedStat: ReturnType<typeof statSync>;
    try {
      cachedStat = statSync(outputPath);
    } catch {
      this.removeQuietly(outputPath);
      return null;
    }
    if (!cachedStat.isFile() || cachedStat.size <= 0) {
      this.removeQuietly(outputPath);
      return null;
    }

    const startedAt = Date.now();
    const outputInfo = await this.runProbe(outputPath, 15_000).catch(() => null);
    if (!outputInfo?.hasVideo || outputInfo.durationMs <= 0) {
      this.removeQuietly(outputPath);
      return null;
    }

    const elapsedMs = Date.now() - startedAt;
    console.info(`[transcode] cache hit: ${hash} (${elapsedMs}ms)`);
    return {
      sourcePath,
      outputPath,
      sourceSizeBytes,
      sizeBytes: cachedStat.size,
      durationMs: outputInfo.durationMs,
      width: outputInfo.width,
      height: outputInfo.height,
      elapsedMs,
      encoderUsed: 'cache',
      hardwareAccelerated: false,
      audioCopied: false,
      cached: true,
    };
  }

  private findPendingTranscode(hash: string): TranscodeQueueEntry | null {
    const active = this.transcodeActive.find((item) => item.hash === hash);
    if (active) return active;
    return this.transcodeQueue.find((item) => item.hash === hash) ?? null;
  }

  private pump(): void {
    while (this.transcodeActive.length < this.transcodeConcurrency && this.transcodeQueue.length > 0) {
      const item = this.transcodeQueue.shift();
      if (!item) break;
      this.transcodeActive.push(item);
      item.state = 'running';
      item.percent = 0;
      item.message = '开始转码代理';
      item.startedAt = Date.now();
      this.jobs.set(item.jobId, { controller: item.controller, stage: 'transcode', startedAt: item.startedAt });
      this.emitProgress({
        jobId: item.jobId,
        stage: 'transcode',
        percent: 0,
        message: item.message,
        queueState: 'running',
      });
      void this.processQueuedTranscode(item);
    }
  }

  private async processQueuedTranscode(item: TranscodeQueueEntry): Promise<void> {
    try {
      const result = await this.runQueuedTranscode(item);
      item.state = 'done';
      item.percent = 100;
      item.message = '代理转码完成';
      item.encoderUsed = result.encoderUsed;
      this.finalizeQueueEntry(item);
      this.emitProgress({
        jobId: item.jobId,
        stage: 'transcode',
        percent: 100,
        message: item.message,
        queueState: 'done',
      });
      item.resolve(result);
    } catch (error) {
      const cancelled =
        item.controller.signal.aborted || (error instanceof MediaError && error.code === 'CANCELLED');
      item.state = cancelled ? 'cancelled' : 'failed';
      item.message = error instanceof Error ? error.message : String(error);
      this.finalizeQueueEntry(item);
      this.emitProgress({
        jobId: item.jobId,
        stage: 'transcode',
        percent: item.percent,
        message: item.message,
        queueState: item.state,
      });
      item.reject(error);
    } finally {
      this.pump();
    }
  }

  private finalizeQueueEntry(item: TranscodeQueueEntry): void {
    this.transcodeActive = this.transcodeActive.filter((active) => active !== item);
    this.jobs.delete(item.jobId);
    this.transcodeRecent.push(item);
    if (this.transcodeRecent.length > 20) this.transcodeRecent.shift();
  }

  private async runQueuedTranscode(item: TranscodeQueueEntry): Promise<TranscodeProxyResult> {
    const { args, sourcePath, outputPath, jobId, controller } = item;
    const { ffmpeg } = await this.ensureReady();
    const meta = await this.runProbe(sourcePath, DEFAULT_PROBE_TIMEOUT_MS);
    if (!meta.hasVideo) {
      throw new MediaError('NO_VIDEO_STREAM', '该文件没有视频轨道，无法生成代理');
    }
    if (meta.durationMs <= 0) {
      throw new MediaError('PROBE_INCOMPLETE', '无法获取源文件时长，代理转码进度不可用');
    }

    const encoder = args.encoder
      ? { name: args.encoder }
      : selectBestEncoder(await resolveAvailableEncoders());
    item.encoderUsed = encoder.name;
    const proxyMode = args.proxyMode ?? 'balanced';
    const tier = args.tier ?? '540p';
    const tierResolution = resolutionForTier(tier);
    const effectiveResolution =
      args.proxyResolution && args.proxyResolution !== 'auto' ? args.proxyResolution : tierResolution;
    const effectiveCrf = args.crf ?? (tier === '360p' ? 28 : 26);
    const audioCopied = Boolean(meta.hasAudio && AUDIO_COPY_CODECS.has(meta.audioCodec ?? ''));
    const proxySize = computeProxySize({
      srcWidth: meta.width,
      srcHeight: meta.height,
      mode: proxyMode,
      resolution: effectiveResolution,
      maxHeight: args.maxHeight,
    });
    const targetWidth = proxySize.width;
    const evenHeight = proxySize.height;
    const timeoutMs = args.timeoutMs ?? DEFAULT_TRANSCODE_TIMEOUT_MS;
    const gopFrames = Math.max(1, Math.round((meta.fps > 0 ? meta.fps : 30) * 2));

    const buildTranscodeArgs = (encoderName: string): string[] => [
      '-hide_banner',
      '-loglevel',
      'error',
      '-nostdin',
      '-progress',
      'pipe:1',
      '-y',
      '-i',
      sourcePath,
      '-map',
      '0:v:0',
      '-map',
      '0:a:0?',
      '-vf',
      `scale=${targetWidth}:${evenHeight}`,
      ...buildVideoEncoderArgs(encoderName, proxyMode, effectiveCrf),
      '-g',
      String(gopFrames),
      '-keyint_min',
      String(gopFrames),
      ...(encoderName === 'libx264' ? ['-sc_threshold', '0'] : []),
      '-pix_fmt',
      'yuv420p',
      ...(audioCopied ? ['-c:a', 'copy'] : ['-c:a', 'aac', '-b:a', '128k']),
      '-movflags',
      '+faststart',
      '-max_muxing_queue_size',
      '2048',
      outputPath,
    ];

    let lastPercent = 0;
    let lastEmitAt = 0;
    const startedAt = Date.now();
    let encoderUsed = encoder.name;
    let fallbackReason: string | undefined;
    let ffArgs = buildTranscodeArgs(encoderUsed);

    const onStdoutLine = (line: string): void => {
      const match = /^out_time_us=(\d+)$/u.exec(line.trim());
      if (!match) return;
      const percent = clampInt(Math.floor((Number(match[1]) / 1000 / meta.durationMs) * 100), 0, 99);
      const now = Date.now();
      if (percent > lastPercent && (percent - lastPercent >= 1 || now - lastEmitAt > 250)) {
        lastPercent = percent;
        lastEmitAt = now;
        item.percent = percent;
        item.message = `代理转码中 ${percent}%`;
        this.emitProgress({
          jobId,
          stage: 'transcode',
          percent,
          message: item.message,
          queueState: 'running',
        });
      }
    };

    let result = await runProcess({
      command: ffmpeg,
      args: ffArgs,
      timeoutMs,
      signal: controller.signal,
      onStdoutLine,
      lowPriority: true,
    });

    if (
      !result.timedOut &&
      !result.aborted &&
      result.exitCode !== 0 &&
      encoderUsed !== 'libx264' &&
      HARDWARE_ENCODER_FAILURE_RE.test(result.stderr)
    ) {
      fallbackReason = `${encoderUsed}: ${tailText(result.stderr, 1000).trim() || '硬件编码器启动失败'}`;
      this.removeQuietly(outputPath);
      encoderUsed = 'libx264';
      ffArgs = buildTranscodeArgs(encoderUsed);
      lastPercent = 0;
      lastEmitAt = 0;
      item.percent = 0;
      item.message = '硬件编码不可用，正在回退 libx264';
      this.emitProgress({
        jobId,
        stage: 'transcode',
        percent: 0,
        message: item.message,
        queueState: 'running',
      });
      result = await runProcess({
        command: ffmpeg,
        args: ffArgs,
        timeoutMs,
        signal: controller.signal,
        onStdoutLine,
        lowPriority: true,
      });
    }

    if (result.timedOut) {
      this.removeQuietly(outputPath);
      throw new MediaError('TRANSCODE_TIMEOUT', `代理转码超时（${timeoutMs}ms）`, {
        ...diagnosticsOf(formatCommand(ffmpeg, ffArgs), result),
        sourcePath,
        jobId,
      });
    }
    if (result.aborted) {
      this.removeQuietly(outputPath);
      throw new MediaError('CANCELLED', '代理转码已取消', {
        ...diagnosticsOf(formatCommand(ffmpeg, ffArgs), result),
        jobId,
      });
    }
    if (result.exitCode !== 0) {
      this.removeQuietly(outputPath);
      throw new MediaError('TRANSCODE_FAILED', `代理转码失败：${this.stderrSummary(result.stderr)}`, {
        ...diagnosticsOf(formatCommand(ffmpeg, ffArgs), result),
        sourcePath,
        jobId,
      });
    }

    const outputStat = this.statOrThrow(outputPath, 'TRANSCODE_FAILED', '代理文件未生成');
    const outputInfo = await this.runProbe(outputPath, 30_000).catch(() => null);
    const elapsedMs = Date.now() - startedAt;
    const hardwareAccelerated = isHardwareEncoder(encoderUsed);
    const finalWidth = outputInfo?.width ?? targetWidth;
    const finalHeight = outputInfo?.height ?? evenHeight;
    console.info(
      `[transcode] complete: mode=${proxyMode} encoderUsed=${encoderUsed} width=${finalWidth} height=${finalHeight} elapsedMs=${elapsedMs} hardwareAccelerated=${hardwareAccelerated} audio=${audioCopied ? 'copy' : 'aac'}`,
    );

    return {
      sourcePath,
      outputPath,
      sourceSizeBytes: item.sourceSizeBytes,
      sizeBytes: outputStat.size,
      durationMs: outputInfo?.durationMs ?? meta.durationMs,
      width: finalWidth,
      height: finalHeight,
      elapsedMs,
      encoderUsed,
      hardwareAccelerated,
      fallbackReason,
      audioCopied,
      cached: false,
    };
  }

  cancelJob(jobId: string): CancelJobResult {
    const waitingIndex = this.transcodeQueue.findIndex((item) => item.jobId === jobId);
    if (waitingIndex >= 0) {
      const [item] = this.transcodeQueue.splice(waitingIndex, 1);
      item.state = 'cancelled';
      item.message = '排队转码已取消';
      this.finalizeQueueEntry(item);
      this.emitProgress({
        jobId,
        stage: 'transcode',
        percent: item.percent,
        message: item.message,
        queueState: 'cancelled',
      });
      item.reject(new MediaError('CANCELLED', item.message, { jobId }));
      this.pump();
      return { jobId, cancelled: true };
    }

    const active = this.transcodeActive.find((item) => item.jobId === jobId);
    if (active) {
      active.controller.abort();
      return { jobId, cancelled: true };
    }

    const job = this.jobs.get(jobId);
    if (!job) return { jobId, cancelled: false };
    job.controller.abort();
    return { jobId, cancelled: true };
  }

  /** 退出/窗口关闭时中止所有长任务 */
  dispose(): void {
    for (const item of this.transcodeQueue.splice(0)) {
      item.state = 'cancelled';
      item.message = '媒体服务已关闭';
      this.finalizeQueueEntry(item);
      item.reject(new MediaError('CANCELLED', item.message, { jobId: item.jobId }));
    }
    for (const job of this.jobs.values()) {
      job.controller.abort();
    }
    this.jobs.clear();
  }

  // ---------- 内部实现 ----------

  private async ensureReady(): Promise<FfmpegBinaries> {
    return resolveFfmpegBinaries();
  }

  private async runProbe(filePath: string, timeoutMs: number): Promise<MediaProbeResult> {
    const { ffprobe } = await this.ensureReady();
    const args = [
      '-v',
      'error',
      '-print_format',
      'json',
      '-show_format',
      '-show_streams',
      filePath,
    ];
    const result = await runProcess({ command: ffprobe, args, timeoutMs });

    if (result.timedOut) {
      throw new MediaError('PROBE_TIMEOUT', `媒体探测超时（${timeoutMs}ms）`, {
        ...diagnosticsOf(formatCommand(ffprobe, args), result),
        path: filePath,
      });
    }
    if (result.exitCode !== 0) {
      throw new MediaError('PROBE_FAILED', `媒体探测失败：${this.stderrSummary(result.stderr)}`, {
        ...diagnosticsOf(formatCommand(ffprobe, args), result),
        path: filePath,
      });
    }

    let parsed: FfprobeResult;
    try {
      parsed = JSON.parse(result.stdout) as FfprobeResult;
    } catch (error) {
      throw new MediaError('PROBE_PARSE_FAILED', `ffprobe 输出解析失败：${(error as Error).message}`, {
        path: filePath,
        stdoutTail: tailText(result.stdout, 1000),
      });
    }

    const streams = parsed.streams ?? [];
    const video = streams.find((stream) => stream.codec_type === 'video');
    const audio = streams.find((stream) => stream.codec_type === 'audio');
    const format = parsed.format ?? {};
    const stat = this.statOrThrow(filePath, 'INPUT_NOT_FOUND', '媒体文件不可读');

    const durationSec = firstFinite([format.duration, video?.duration]);
    const fps = parseRate(video?.avg_frame_rate) || parseRate(video?.r_frame_rate);
    const sizeBytes = firstFinite([format.size]) ?? stat.size;
    const bitrate = firstFinite([format.bit_rate, video?.bit_rate]);

    return {
      path: filePath,
      filename: basename(filePath),
      container: format.format_name ?? '',
      durationMs: durationSec && durationSec > 0 ? Math.round(durationSec * 1000) : 0,
      width: Number(video?.width) || 0,
      height: Number(video?.height) || 0,
      fps,
      videoCodec: video?.codec_name ?? null,
      audioCodec: audio?.codec_name ?? null,
      bitrate: bitrate ?? null,
      sizeBytes: Math.round(sizeBytes),
      hasVideo: Boolean(video),
      hasAudio: Boolean(audio),
    };
  }

  private validateInput(rawPath: string): string {
    if (typeof rawPath !== 'string' || rawPath.trim().length === 0) {
      throw new MediaError('INPUT_INVALID', '缺少输入文件路径');
    }
    const filePath = isAbsolute(rawPath) ? rawPath : resolve(rawPath);
    if (!existsSync(filePath)) {
      throw new MediaError('INPUT_NOT_FOUND', `文件不存在：${filePath}`, { path: filePath });
    }
    const stat = this.statOrThrow(filePath, 'INPUT_NOT_FOUND', '文件不可读');
    if (!stat.isFile()) {
      throw new MediaError('INPUT_NOT_FILE', `路径不是文件：${filePath}`, { path: filePath });
    }
    if (stat.size === 0) {
      throw new MediaError('INPUT_EMPTY', `文件为空：${filePath}`, { path: filePath });
    }
    return filePath;
  }

  private validateOutputPath(rawPath: string): string {
    if (typeof rawPath !== 'string' || rawPath.trim().length === 0) {
      throw new MediaError('OUTPUT_INVALID', '输出路径为空');
    }
    return isAbsolute(rawPath) ? rawPath : resolve(rawPath);
  }

  private assertNotSameFile(inputPath: string, outputPath: string): void {
    if (resolve(inputPath).toLowerCase() === resolve(outputPath).toLowerCase()) {
      throw new MediaError('OUTPUT_INVALID', '输出路径不能与输入文件相同');
    }
  }

  private statOrThrow(filePath: string, code: string, message: string) {
    try {
      return statSync(filePath);
    } catch {
      throw new MediaError(code, `${message}：${filePath}`, { path: filePath });
    }
  }

  private stderrSummary(stderr: string): string {
    const text = tailText(stderr, MAX_STDERR_FOR_DIAGNOSTICS);
    return text.length > 0 ? text : '无 stderr 输出';
  }

  private removeQuietly(filePath: string): void {
    try {
      if (existsSync(filePath)) unlinkSync(filePath);
    } catch {
      // ignore cleanup failures
    }
  }

  private cleanOldFrames(outputDir: string, prefix: string, format: FrameFormat): void {
    try {
      const matcher = new RegExp(`^${prefix}\\d{6}\\.${format}$`, 'u');
      for (const entry of readdirSync(outputDir)) {
        if (matcher.test(entry)) this.removeQuietly(join(outputDir, entry));
      }
    } catch {
      // ignore
    }
  }

  private collectFrames(
    outputDir: string,
    prefix: string,
    format: FrameFormat,
    intervalMs: number,
    startMs: number,
  ): ExtractedFrameInfo[] {
    const matcher = new RegExp(`^${prefix}(\\d{6})\\.${format}$`, 'u');
    const frames: ExtractedFrameInfo[] = [];
    for (const entry of readdirSync(outputDir)) {
      const match = matcher.exec(entry);
      if (!match) continue;
      const index = Number(match[1]);
      const filePath = join(outputDir, entry);
      const stat = this.statOrThrow(filePath, 'EXTRACT_FRAMES_FAILED', '抽帧文件不可读');
      frames.push({
        index,
        timeMs: Math.round(startMs + (index - 1) * intervalMs),
        path: filePath,
        sizeBytes: stat.size,
      });
    }
    frames.sort((a, b) => a.index - b.index);
    return frames;
  }

  private emitProgress(event: MediaProgressEvent): void {
    const win = this.getWindow();
    if (!win || win.isDestroyed()) return;
    win.webContents.send(IPC.MEDIA_EVENT_PROGRESS, event);
  }
}

function normalizeFormat(format: FrameFormat | undefined): FrameFormat {
  if (!format) return 'jpg';
  return format === 'jpeg' ? 'jpg' : format;
}

function clampInt(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, Math.round(value)));
}

function proxyKey(sourcePath: string, size: number, mtimeMs: number, tier?: ProxyTier): string {
  const identity = tier
    ? `${resolve(sourcePath)}|${size}|${mtimeMs}|${tier}`
    : `${resolve(sourcePath)}|${size}|${mtimeMs}`;
  const digest = createHash('sha256').update(identity).digest('hex');
  return digest.slice(0, 24);
}

export function computeProxySize(opts: ProxySizeOptions): { width: number; height: number } {
  const srcWidth = Number.isFinite(opts.srcWidth) && opts.srcWidth > 0 ? opts.srcWidth : 16;
  const srcHeight = Number.isFinite(opts.srcHeight) && opts.srcHeight > 0 ? opts.srcHeight : 9;
  const sourceEvenHeight = Math.max(2, Math.floor(srcHeight / 2) * 2);
  const explicitHeight = explicitResolutionHeight(opts.resolution);
  let targetHeight: number;

  if (explicitHeight !== null) {
    targetHeight = Math.min(sourceEvenHeight, explicitHeight, opts.maxHeight ?? explicitHeight);
  } else {
    const maxHeight = opts.mode === 'quality' ? 1080 : 540;
    targetHeight = Math.max(240, Math.min(srcHeight / 2, maxHeight));
    if (opts.maxHeight !== undefined && Number.isFinite(opts.maxHeight)) {
      targetHeight = Math.min(targetHeight, Math.max(2, opts.maxHeight));
    }
    targetHeight = Math.min(sourceEvenHeight, targetHeight);
  }

  targetHeight = Math.max(2, Math.floor(targetHeight / 2) * 2);
  const width = Math.max(2, Math.round((srcWidth * targetHeight) / srcHeight / 2) * 2);
  return { width, height: targetHeight };
}

function explicitResolutionHeight(resolution: ProxyResolution | undefined): number | null {
  switch (resolution) {
    case 'p240':
      return 240;
    case 'p360':
      return 360;
    case 'p540':
      return 540;
    case 'p720':
      return 720;
    case 'p1080':
      return 1080;
    default:
      return null;
  }
}

function resolutionForTier(tier: ProxyTier): ProxyResolution {
  if (tier === '360p') return 'p360';
  if (tier === '720p') return 'p720';
  return 'p540';
}

function buildVideoEncoderArgs(encoderName: string, mode: ProxyMode, crf?: number): string[] {
  switch (encoderName) {
    case 'h264_nvenc': {
      const preset = mode === 'fast' ? 'p6' : mode === 'quality' ? 'p4' : 'p5';
      const cq = String(crf ?? (mode === 'fast' ? 30 : mode === 'quality' ? 24 : 28));
      const maxrate = mode === 'quality' ? '6M' : '4M';
      const bufsize = mode === 'quality' ? '8M' : '6M';
      return [
        '-c:v', 'h264_nvenc',
        '-preset', preset,
        '-tune', 'hq',
        '-rc', 'vbr',
        '-cq', cq,
        '-b:v', '0',
        '-maxrate', maxrate,
        '-bufsize', bufsize,
      ];
    }
    case 'hevc_nvenc': {
      const preset = mode === 'fast' ? 'p6' : mode === 'quality' ? 'p4' : 'p5';
      const cq = String(crf ?? (mode === 'fast' ? 30 : mode === 'quality' ? 24 : 30));
      const maxrate = mode === 'quality' ? '6M' : '3M';
      const bufsize = mode === 'quality' ? '8M' : '4M';
      return [
        '-c:v', 'hevc_nvenc',
        '-preset', preset,
        '-tune', 'hq',
        '-rc', 'vbr',
        '-cq', cq,
        '-b:v', '0',
        '-maxrate', maxrate,
        '-bufsize', bufsize,
      ];
    }
    case 'h264_qsv':
      return ['-c:v', 'h264_qsv', '-global_quality', String(crf ?? qsvQuality(mode, '28'))];
    case 'hevc_qsv':
      return ['-c:v', 'hevc_qsv', '-global_quality', String(crf ?? qsvQuality(mode, '30'))];
    case 'h264_amf':
      return [
        '-c:v', 'h264_amf',
        '-quality', 'balanced',
        '-qp_i', String(crf ?? amfQuality(mode, '26')),
        '-qp_p', String(crf ?? amfQuality(mode, '26')),
      ];
    case 'hevc_amf':
      return [
        '-c:v', 'hevc_amf',
        '-quality', 'balanced',
        '-qp_i', String(crf ?? amfQuality(mode, '28')),
        '-qp_p', String(crf ?? amfQuality(mode, '28')),
      ];
    case 'libx264':
      return x264Args(mode, crf);
    default:
      return ['-c:v', encoderName];
  }
}

function qsvQuality(mode: ProxyMode, balancedQuality: string): string {
  return mode === 'fast' ? '30' : mode === 'quality' ? '24' : balancedQuality;
}

function amfQuality(mode: ProxyMode, balancedQuality: string): string {
  return mode === 'fast' ? '30' : mode === 'quality' ? '22' : balancedQuality;
}

function x264Args(mode: ProxyMode, crf?: number): string[] {
  const tune = ['-tune', 'fastdecode'];
  if (mode === 'fast') return ['-c:v', 'libx264', '-preset', 'ultrafast', '-crf', String(crf ?? 30), ...tune];
  if (mode === 'quality') return ['-c:v', 'libx264', '-preset', 'medium', '-crf', String(crf ?? 24), ...tune];
  return ['-c:v', 'libx264', '-preset', 'ultrafast', '-crf', String(crf ?? 28), ...tune];
}

function firstFinite(values: Array<string | number | undefined | null>): number | null {
  for (const value of values) {
    if (value === undefined || value === null || value === '') continue;
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function parseRate(rate: string | undefined): number {
  if (!rate) return 0;
  const [numerator, denominator] = rate.split('/');
  const num = Number(numerator);
  const den = Number(denominator ?? '1');
  if (!Number.isFinite(num) || !Number.isFinite(den) || den === 0 || num === 0) return 0;
  const value = num / den;
  return Number.isFinite(value) ? Math.round(value * 1000) / 1000 : 0;
}
