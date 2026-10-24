import { spawn, type ChildProcess, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, rmSync, statSync, type Stats } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { app } from 'electron';
import type {
  AudioWaveform,
  AudioWaveformBucket,
  ScopeAnalysis,
  ScopeAnalyzeFrameArgs,
  ScopeExtractAudioWaveformArgs,
} from '../../shared/types';
import { resolveFfmpegBinaries } from '../media/ffmpeg-binaries';
import type { MediaService } from '../media/media-service';
import { ScopeError } from './scope-error';

interface CachedAnalysis {
  timeMs: number;
  result: ScopeAnalysis;
}

interface PendingRpc {
  resolve: (result: ScopeAnalysis) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

const ANALYSIS_CACHE_TOLERANCE_MS = 500;
const ANALYSIS_CACHE_LIMIT = 64;
const AUDIO_SAMPLE_RATE = 8000;
const AUDIO_TIMEOUT_MS = 10 * 60_000;
const RPC_TIMEOUT_MS = 30_000;
const MAX_STDERR_CHARS = 4000;

export class ScopeService {
  private readonly analysisCache = new Map<string, CachedAnalysis[]>();
  private readonly audioCache = new Map<string, AudioWaveform>();
  private readonly audioJobs = new Map<string, Promise<AudioWaveform>>();
  private readonly waveformChildren = new Set<ChildProcess>();
  private python: ChildProcessWithoutNullStreams | null = null;
  private stdoutBuffer = '';
  private stderrTail = '';
  private nextRequestId = 1;
  private readonly pending = new Map<number, PendingRpc>();

  constructor(private readonly media: MediaService) {}

  async analyzeFrame(args: ScopeAnalyzeFrameArgs): Promise<ScopeAnalysis> {
    const path = resolve(String(args.path));
    const timeMs = Math.max(0, Math.round(Number(args.timeMs)));
    if (!Number.isFinite(timeMs)) {
      throw new ScopeError('SCOPE_INVALID_TIME', '分析时间必须是有效毫秒值');
    }

    const cached = this.findCachedAnalysis(path, timeMs);
    if (cached) return cached;

    const frameDir = join(app.getPath('userData'), 'lapian', 'scopes', 'frames');
    mkdirSync(frameDir, { recursive: true });
    const pathHash = createHash('sha1').update(path).digest('hex').slice(0, 12);
    const framePath = join(frameDir, `${pathHash}-${timeMs}-${randomUUID().slice(0, 8)}.png`);

    try {
      await this.media.extractFrame({
        path,
        timeMs,
        outputPath: framePath,
        format: 'png',
        maxWidth: 640,
        timeoutMs: RPC_TIMEOUT_MS,
      });
      const result = await this.runPython(framePath);
      this.storeCachedAnalysis(path, timeMs, result);
      return result;
    } catch (error) {
      if (error instanceof ScopeError) throw error;
      const cause = error as { code?: string; message?: string; details?: Record<string, unknown> };
      throw new ScopeError(
        cause.code === 'INPUT_NOT_FOUND' ? 'SCOPE_INPUT_NOT_FOUND' : 'SCOPE_FRAME_EXTRACT_FAILED',
        cause.message ?? String(error),
        { ...cause.details, causeCode: cause.code ?? null, path, timeMs },
      );
    } finally {
      rmSync(framePath, { force: true });
    }
  }

  async extractAudioWaveform(args: ScopeExtractAudioWaveformArgs): Promise<AudioWaveform> {
    const path = resolve(String(args.path));
    const bucketMs = clampInteger(args.bucketMs ?? 100, 20, 5000);
    const stat = this.validateMedia(path);
    const cacheKey = `${path.toLowerCase()}|${stat.size}|${Math.round(stat.mtimeMs)}|${bucketMs}`;
    const cached = this.audioCache.get(cacheKey);
    if (cached) return cached;

    const active = this.audioJobs.get(cacheKey);
    if (active) return active;

    const job = this.buildAudioWaveform(path, bucketMs)
      .then((result) => {
        this.audioCache.set(cacheKey, result);
        return result;
      })
      .finally(() => {
        this.audioJobs.delete(cacheKey);
      });
    this.audioJobs.set(cacheKey, job);
    return job;
  }

  dispose(): void {
    this.python?.kill();
    this.python = null;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new ScopeError('SCOPE_DISPOSED', '示波器服务已关闭'));
    }
    this.pending.clear();
    for (const child of this.waveformChildren) {
      child.kill();
    }
    this.waveformChildren.clear();
  }

  private findCachedAnalysis(path: string, timeMs: number): ScopeAnalysis | null {
    const entries = this.analysisCache.get(path.toLowerCase());
    if (!entries) return null;
    let nearest: CachedAnalysis | null = null;
    let nearestDistance = Number.POSITIVE_INFINITY;
    for (const entry of entries) {
      const distance = Math.abs(entry.timeMs - timeMs);
      if (distance <= ANALYSIS_CACHE_TOLERANCE_MS && distance < nearestDistance) {
        nearest = entry;
        nearestDistance = distance;
      }
    }
    return nearest?.result ?? null;
  }

  private storeCachedAnalysis(path: string, timeMs: number, result: ScopeAnalysis): void {
    const key = path.toLowerCase();
    const entries = this.analysisCache.get(key) ?? [];
    entries.push({ timeMs, result });
    entries.sort((left, right) => Math.abs(left.timeMs - timeMs) - Math.abs(right.timeMs - timeMs));
    this.analysisCache.set(key, entries.slice(0, ANALYSIS_CACHE_LIMIT));
  }

  private runPython(framePath: string): Promise<ScopeAnalysis> {
    const child = this.ensurePython();
    const id = this.nextRequestId++;
    return new Promise<ScopeAnalysis>((resolvePromise, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new ScopeError('SCOPE_ANALYZE_TIMEOUT', '示波器分析超时', { id }));
      }, RPC_TIMEOUT_MS);
      this.pending.set(id, { resolve: resolvePromise, reject, timer });
      child.stdin.write(
        `${JSON.stringify({
          jsonrpc: '2.0',
          id,
          method: 'analyze',
          params: { framePath },
        })}\n`,
        (error) => {
          if (!error) return;
          const pending = this.pending.get(id);
          if (!pending) return;
          clearTimeout(pending.timer);
          this.pending.delete(id);
          pending.reject(
            new ScopeError('SCOPE_RPC_WRITE_FAILED', `无法写入分析进程：${error.message}`, { id }),
          );
        },
      );
    });
  }

  private ensurePython(): ChildProcessWithoutNullStreams {
    if (this.python && !this.python.killed) return this.python;

    const python = resolvePythonExecutable();
    const script = resolveServerScript();
    if (!existsSync(script)) {
      throw new ScopeError('SCOPE_SERVER_NOT_FOUND', `示波器分析服务不存在：${script}`, { script });
    }

    const child = spawn(python, [script], {
      cwd: dirname(script),
      windowsHide: true,
      env: {
        ...process.env,
        PYTHONIOENCODING: 'utf-8',
        PYTHONUNBUFFERED: '1',
      },
    });
    this.python = child;
    this.stdoutBuffer = '';
    this.stderrTail = '';

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => this.consumeStdout(chunk));
    child.stderr.on('data', (chunk: string) => {
      this.stderrTail = `${this.stderrTail}${chunk}`.slice(-MAX_STDERR_CHARS);
    });
    child.on('error', (error) => this.failPython(new ScopeError('SCOPE_SPAWN_FAILED', error.message)));
    child.on('exit', (code) => {
      if (this.python !== child) return;
      const details = { code, python, script, stderr: this.stderrTail };
      this.failPython(
        new ScopeError('SCOPE_PROCESS_EXITED', `示波器分析进程退出（${code}）`, details),
      );
    });
    return child;
  }

  private consumeStdout(chunk: string): void {
    this.stdoutBuffer += chunk;
    let newline = this.stdoutBuffer.indexOf('\n');
    while (newline >= 0) {
      const line = this.stdoutBuffer.slice(0, newline).trim();
      this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1);
      newline = this.stdoutBuffer.indexOf('\n');
      if (!line) continue;

      let response: {
        id?: number;
        result?: ScopeAnalysis;
        error?: { message?: string; data?: Record<string, unknown> };
      };
      try {
        response = JSON.parse(line) as typeof response;
      } catch (error) {
        this.failPython(
          new ScopeError('SCOPE_PROTOCOL_ERROR', `示波器响应解析失败：${(error as Error).message}`, {
            line,
          }),
        );
        return;
      }
      if (typeof response.id !== 'number') continue;
      const pending = this.pending.get(response.id);
      if (!pending) continue;
      clearTimeout(pending.timer);
      this.pending.delete(response.id);
      if (response.error || !response.result) {
        pending.reject(
          new ScopeError(
            'SCOPE_ANALYZE_FAILED',
            response.error?.message ?? '示波器分析没有返回结果',
            response.error?.data,
          ),
        );
      } else {
        pending.resolve(response.result);
      }
    }
  }

  private failPython(error: ScopeError): void {
    if (this.python) {
      this.python = null;
    }
    this.stdoutBuffer = '';
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  private async buildAudioWaveform(path: string, bucketMs: number): Promise<AudioWaveform> {
    const { ffmpeg } = await resolveFfmpegBinaries().catch((error: unknown) => {
      throw new ScopeError(
        'SCOPE_FFMPEG_UNAVAILABLE',
        error instanceof Error ? error.message : String(error),
      );
    });
    const args = [
      '-hide_banner',
      '-loglevel',
      'error',
      '-nostdin',
      '-i',
      path,
      '-vn',
      '-ac',
      '1',
      '-ar',
      String(AUDIO_SAMPLE_RATE),
      '-f',
      'f32le',
      'pipe:1',
    ];
    const samplesPerBucket = Math.max(1, Math.round((AUDIO_SAMPLE_RATE * bucketMs) / 1000));

    return new Promise<AudioWaveform>((resolvePromise, reject) => {
      const child = spawn(ffmpeg, args, {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      this.waveformChildren.add(child);
      const buckets: AudioWaveformBucket[] = [];
      let stderr = '';
      let carry = Buffer.alloc(0);
      let bucketPeak = 0;
      let bucketSquareSum = 0;
      let bucketSamples = 0;
      let totalSamples = 0;
      let settled = false;

      const finishBucket = (): void => {
        if (bucketSamples === 0) return;
        buckets.push({
          startMs: buckets.length * bucketMs,
          peak: roundAudio(Math.sqrt(bucketPeak)),
          rms: roundAudio(Math.sqrt(bucketSquareSum / bucketSamples)),
        });
        bucketPeak = 0;
        bucketSquareSum = 0;
        bucketSamples = 0;
      };

      const fail = (error: ScopeError): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        this.waveformChildren.delete(child);
        reject(error);
      };

      const timeout = setTimeout(() => {
        child.kill();
        fail(new ScopeError('SCOPE_AUDIO_TIMEOUT', '音频波形提取超时', { path, bucketMs }));
      }, AUDIO_TIMEOUT_MS);

      child.stdout.on('data', (chunk: Buffer) => {
        const data = carry.length > 0 ? Buffer.concat([carry, chunk]) : chunk;
        const completeBytes = data.length - (data.length % 4);
        for (let offset = 0; offset < completeBytes; offset += 4) {
          const sample = data.readFloatLE(offset);
          const absolute = Math.abs(sample);
          bucketPeak = Math.max(bucketPeak, absolute * absolute);
          bucketSquareSum += absolute * absolute;
          bucketSamples += 1;
          totalSamples += 1;
          if (bucketSamples >= samplesPerBucket) finishBucket();
        }
        carry = completeBytes < data.length ? Buffer.from(data.subarray(completeBytes)) : Buffer.alloc(0);
      });
      child.stderr.on('data', (chunk: Buffer) => {
        stderr = `${stderr}${chunk.toString('utf8')}`.slice(-MAX_STDERR_CHARS);
      });
      child.on('error', (error) => {
        fail(new ScopeError('SCOPE_AUDIO_SPAWN_FAILED', error.message, { path, ffmpeg }));
      });
      child.on('close', (code) => {
        this.waveformChildren.delete(child);
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        finishBucket();
        if (totalSamples === 0 || buckets.length === 0) {
          reject(
            new ScopeError(
              code === 0 ? 'SCOPE_AUDIO_EMPTY' : 'SCOPE_AUDIO_STREAM_MISSING',
              code === 0 ? '影片没有可分析的音频数据' : '无法提取音频轨道',
              { path, code, stderr },
            ),
          );
          return;
        }
        resolvePromise({
          buckets,
          bucketMs,
          totalMs: Math.round((totalSamples / AUDIO_SAMPLE_RATE) * 1000),
        });
      });
    });
  }

  private validateMedia(path: string): Stats {
    if (!existsSync(path)) {
      throw new ScopeError('SCOPE_INPUT_NOT_FOUND', `媒体文件不存在：${path}`, { path });
    }
    const stat = statSync(path, { bigint: false });
    if (!stat.isFile() || stat.size === 0) {
      throw new ScopeError('SCOPE_INPUT_INVALID', `媒体文件不可读：${path}`, { path });
    }
    return stat;
  }
}

function resolvePythonExecutable(): string {
  return process.env['DSH_PYTHON'] || process.env['PYTHON'] || 'python';
}

function resolveServerScript(): string {
  const development = join(__dirname, '..', '..', 'src', 'main', 'scope', 'python', 'server.py');
  if (existsSync(development)) return development;
  return join(process.resourcesPath, 'scope', 'python', 'server.py');
}

function clampInteger(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, Math.round(value)));
}

function roundAudio(value: number): number {
  return Number.isFinite(value) ? Math.round(value * 1_000_000) / 1_000_000 : 0;
}
