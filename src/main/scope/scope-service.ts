import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync, type Stats } from 'node:fs';
import { join, resolve } from 'node:path';
import type {
  AudioWaveform,
  AudioWaveformBucket,
  ScopeExtractAudioWaveformArgs,
} from '../../shared/types';
import { resolveFfmpegBinaries } from '../media/ffmpeg-binaries';
import { resolveAudioWaveformCacheDir } from '../paths';
import { ScopeError } from './scope-error';

const AUDIO_SAMPLE_RATE = 8000;
const AUDIO_TIMEOUT_MS = 10 * 60_000;
const MAX_STDERR_CHARS = 4000;

export class ScopeService {
  private readonly audioCache = new Map<string, AudioWaveform>();
  private readonly audioJobs = new Map<string, Promise<AudioWaveform>>();
  private readonly waveformChildren = new Set<ChildProcess>();

  async extractAudioWaveform(args: ScopeExtractAudioWaveformArgs): Promise<AudioWaveform> {
    const path = resolve(String(args.path));
    const inputPath = this.resolveWaveformInput(
      path,
      args.proxyPath ? resolve(args.proxyPath) : null,
    );
    const bucketMs = clampInteger(args.bucketMs ?? 100, 20, 5000);
    const stat = this.validateMedia(path);
    const cacheKey = `${path.toLowerCase()}|${stat.size}|${Math.round(stat.mtimeMs)}|${bucketMs}`;
    const cached = this.audioCache.get(cacheKey);
    if (cached) return cached;
    const diskCached = this.readDiskCache(cacheKey);
    if (diskCached) {
      this.audioCache.set(cacheKey, diskCached);
      return diskCached;
    }

    const active = this.audioJobs.get(cacheKey);
    if (active) return active;

    const job = this.buildAudioWaveform(inputPath, path, bucketMs)
      .then((result) => {
        this.audioCache.set(cacheKey, result);
        this.writeDiskCache(cacheKey, result);
        return result;
      })
      .finally(() => {
        this.audioJobs.delete(cacheKey);
      });
    this.audioJobs.set(cacheKey, job);
    return job;
  }

  dispose(): void {
    for (const child of this.waveformChildren) {
      child.kill();
    }
    this.waveformChildren.clear();
  }

  private async buildAudioWaveform(
    path: string,
    sourcePath: string,
    bucketMs: number,
  ): Promise<AudioWaveform> {
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
      '-threads',
      '1',
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
    console.info(`[scope] waveform input=${path === sourcePath ? 'source' : 'proxy'} path=${path}`);
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
        fail(new ScopeError('SCOPE_AUDIO_TIMEOUT', '音频包络提取超时', { path, bucketMs }));
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
        carry =
          completeBytes < data.length
            ? Buffer.from(data.subarray(completeBytes))
            : Buffer.alloc(0);
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

  private resolveWaveformInput(sourcePath: string, proxyPath: string | null): string {
    if (!proxyPath) return sourcePath;
    try {
      const proxyStat = statSync(proxyPath, { bigint: false });
      if (proxyStat.isFile() && proxyStat.size > 0) return proxyPath;
    } catch {
      // A missing or stale proxy must not prevent waveform extraction.
    }
    return sourcePath;
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

  private diskCachePath(cacheKey: string): string {
    const hash = createHash('sha1').update(cacheKey).digest('hex');
    return join(resolveAudioWaveformCacheDir(), `${hash}.json`);
  }

  private readDiskCache(cacheKey: string): AudioWaveform | null {
    try {
      const parsed = JSON.parse(readFileSync(this.diskCachePath(cacheKey), 'utf8')) as AudioWaveform;
      if (
        Number.isInteger(parsed.bucketMs) &&
        parsed.bucketMs > 0 &&
        Array.isArray(parsed.buckets) &&
        Number.isFinite(parsed.totalMs)
      ) {
        return parsed;
      }
    } catch {
      // 缓存损坏时重建
    }
    return null;
  }

  private writeDiskCache(cacheKey: string, result: AudioWaveform): void {
    try {
      const dir = resolveAudioWaveformCacheDir();
      mkdirSync(dir, { recursive: true });
      writeFileSync(this.diskCachePath(cacheKey), JSON.stringify(result), 'utf8');
    } catch {
      // 磁盘缓存写入失败不影响本次结果
    }
  }
}

function clampInteger(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, Math.round(value)));
}

function roundAudio(value: number): number {
  return Number.isFinite(value) ? Math.round(value * 1_000_000) / 1_000_000 : 0;
}
