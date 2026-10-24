import { randomUUID } from 'node:crypto';
import { mkdirSync, readdirSync, statSync, unlinkSync, existsSync } from 'node:fs';
import { basename, dirname, extname, isAbsolute, join, resolve } from 'node:path';
import { app, type BrowserWindow } from 'electron';
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
  TranscodeProxyArgs,
  TranscodeProxyResult,
} from '../../shared/types';
import { resolveFfmpegBinaries, type FfmpegBinaries } from './ffmpeg-binaries';
import { MediaError, diagnosticsOf, tailText } from './media-error';
import { formatCommand, runProcess } from './process-runner';

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

const DEFAULT_PROBE_TIMEOUT_MS = 30_000;
const DEFAULT_FRAME_TIMEOUT_MS = 60_000;
const DEFAULT_FRAMES_TIMEOUT_MS = 30 * 60_000;
const DEFAULT_TRANSCODE_TIMEOUT_MS = 60 * 60_000;
const MAX_STDERR_FOR_DIAGNOSTICS = 4000;

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
      : join(app.getPath('userData'), 'lapian', 'frames', `${basename(inputPath, extname(inputPath))}-${Math.round(args.timeMs)}ms-${Date.now()}.${format}`);

    this.assertNotSameFile(inputPath, outputPath);
    mkdirSync(dirname(outputPath), { recursive: true });

    const { ffmpeg } = await this.ensureReady();
    const seconds = (Math.max(0, args.timeMs) / 1000).toFixed(3);
    const ffArgs = [
      '-hide_banner',
      '-loglevel',
      'error',
      '-nostdin',
      '-ss',
      seconds,
      '-i',
      inputPath,
      '-frames:v',
      '1',
      '-an',
      '-sn',
      ...(format === 'png' ? ['-compression_level', '6'] : ['-q:v', String(quality)]),
      '-y',
      outputPath,
    ];

    const result = await runProcess({
      command: ffmpeg,
      args: ffArgs,
      timeoutMs: args.timeoutMs ?? DEFAULT_FRAME_TIMEOUT_MS,
    });

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

  async extractFrames(args: ExtractFramesArgs): Promise<ExtractFramesResult> {
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
    const jobId = `extract-${randomUUID()}`;
    const controller = new AbortController();
    this.jobs.set(jobId, { controller, stage: 'extractFrames', startedAt: Date.now() });
    this.emitProgress({ jobId, stage: 'extractFrames', percent: 0, message: '开始抽帧' });

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
            this.emitProgress({
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

      this.emitProgress({ jobId, stage: 'extractFrames', percent: 100, message: `抽帧完成，共 ${frames.length} 帧` });
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

  async transcodeProxy(args: TranscodeProxyArgs): Promise<TranscodeProxyResult> {
    const sourcePath = this.validateInput(args.sourcePath);
    const sourceStat = this.statOrThrow(sourcePath, 'INPUT_NOT_FOUND', '源文件不可读');
    const outputPath = args.outputPath
      ? this.validateOutputPath(args.outputPath)
      : join(
          app.getPath('userData'),
          'lapian',
          'proxies',
          `${basename(sourcePath, extname(sourcePath))}-proxy.mp4`,
        );

    this.assertNotSameFile(sourcePath, outputPath);
    mkdirSync(dirname(outputPath), { recursive: true });

    const { ffmpeg } = await this.ensureReady();
    const meta = await this.runProbe(sourcePath, DEFAULT_PROBE_TIMEOUT_MS);
    if (!meta.hasVideo) {
      throw new MediaError('NO_VIDEO_STREAM', '该文件没有视频轨道，无法生成代理');
    }
    if (meta.durationMs <= 0) {
      throw new MediaError('PROBE_INCOMPLETE', '无法获取源文件时长，代理转码进度不可用');
    }

    const targetHeight = Math.min(
      clampInt(args.maxHeight ?? 720, 120, 4320),
      meta.height > 0 ? meta.height : 720,
    );
    const sourceWidth = meta.width > 0 ? meta.width : Math.round((targetHeight * 16) / 9);
    const targetWidth = Math.max(2, Math.round((sourceWidth * targetHeight) / (meta.height || targetHeight) / 2) * 2);
    const evenHeight = Math.max(2, Math.round(targetHeight / 2) * 2);
    const crf = clampInt(args.crf ?? 26, 1, 51);
    const preset = args.preset ?? 'veryfast';
    const timeoutMs = args.timeoutMs ?? DEFAULT_TRANSCODE_TIMEOUT_MS;

    const jobId = `transcode-${randomUUID()}`;
    const controller = new AbortController();
    this.jobs.set(jobId, { controller, stage: 'transcode', startedAt: Date.now() });
    this.emitProgress({ jobId, stage: 'transcode', percent: 0, message: '开始转码代理' });

    const ffArgs = [
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
      '-c:v',
      'libx264',
      '-preset',
      preset,
      '-crf',
      String(crf),
      '-pix_fmt',
      'yuv420p',
      '-c:a',
      'aac',
      '-b:a',
      '128k',
      '-movflags',
      '+faststart',
      '-max_muxing_queue_size',
      '2048',
      outputPath,
    ];

    let lastPercent = 0;
    let lastEmitAt = 0;
    const startedAt = Date.now();

    try {
      const result = await runProcess({
        command: ffmpeg,
        args: ffArgs,
        timeoutMs,
        signal: controller.signal,
        onStdoutLine: (line) => {
          const match = /^out_time_us=(\d+)$/u.exec(line.trim());
          if (!match) return;
          const percent = clampInt(Math.floor((Number(match[1]) / 1000 / meta.durationMs) * 100), 0, 99);
          const now = Date.now();
          if (percent > lastPercent && (percent - lastPercent >= 1 || now - lastEmitAt > 250)) {
            lastPercent = percent;
            lastEmitAt = now;
            this.emitProgress({
              jobId,
              stage: 'transcode',
              percent,
              message: `代理转码中 ${percent}%`,
            });
          }
        },
      });

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
      this.emitProgress({ jobId, stage: 'transcode', percent: 100, message: '代理转码完成' });

      return {
        sourcePath,
        outputPath,
        sourceSizeBytes: sourceStat.size,
        sizeBytes: outputStat.size,
        durationMs: outputInfo?.durationMs ?? meta.durationMs,
        width: outputInfo?.width ?? targetWidth,
        height: outputInfo?.height ?? evenHeight,
        elapsedMs: Date.now() - startedAt,
      };
    } finally {
      this.jobs.delete(jobId);
    }
  }

  cancelJob(jobId: string): CancelJobResult {
    const job = this.jobs.get(jobId);
    if (!job) return { jobId, cancelled: false };
    job.controller.abort();
    return { jobId, cancelled: true };
  }

  /** 退出/窗口关闭时中止所有长任务 */
  dispose(): void {
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