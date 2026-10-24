import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { DataLayer } from '../../data/db';
import { ensureProjectDirs } from '../../data/paths';
import type {
  DetectApplyArgs,
  DetectApplyResult,
  DetectDoneEvent,
  DetectJobSnapshot,
  DetectJobStatus,
  DetectOptions,
  DetectProgressEvent,
  DetectResult,
  DetectRunArgs,
  DetectRunResult,
  DetectWeights,
  Scene,
  ShotPreview,
} from '../../shared/types';
import type { MediaService } from '../media/media-service';
import { DetectError } from './detect-error';

const DEFAULT_WEIGHTS: DetectWeights = { s: 0.3, c: 0.3, h: 0.4 };
const ANALYSIS_TIMEOUT_MS = 10 * 60_000;

interface InternalDetectJob {
  jobId: string;
  projectId: string;
  status: DetectJobStatus;
  progress: number;
  error: string | null;
  controller: AbortController;
  child: ChildProcessWithoutNullStreams | null;
  result: DetectResult | null;
}

interface PythonShotRange {
  startFrame: number;
  endFrame: number;
}

interface PythonAnalyzeResult {
  intervalMs: number;
  cutFrames: number[];
  shotRanges: PythonShotRange[];
  sceneRanges: PythonShotRange[];
}

interface ResolvedDetectOptions extends DetectOptions {
  weights: DetectWeights;
}

/**
 * DetectService（S01 §5.4 / §8.2）：
 * MediaService 抽帧 → Python JSON-RPC 分析 → 预览结果缓存 → 用户确认后写库。
 */
export class DetectService {
  private readonly jobs = new Map<string, InternalDetectJob>();
  private readonly latestByProject = new Map<string, DetectResult>();

  constructor(
    private readonly data: DataLayer,
    private readonly media: MediaService,
    private readonly emitProgress: (event: DetectProgressEvent) => void,
    private readonly emitDone: (event: DetectDoneEvent) => void,
  ) {}

  run(args: DetectRunArgs): DetectRunResult {
    this.data.projects.get(args.projectId);
    const options = normalizeOptions(args.options);
    for (const job of this.jobs.values()) {
      if (job.projectId === args.projectId && job.status === 'running') {
        throw new DetectError('DETECT_ALREADY_RUNNING', '该项目已有检测任务正在运行', {
          jobId: job.jobId,
        });
      }
    }

    const jobId = `detect-${randomUUID()}`;
    const job: InternalDetectJob = {
      jobId,
      projectId: args.projectId,
      status: 'queued',
      progress: 0,
      error: null,
      controller: new AbortController(),
      child: null,
      result: null,
    };
    this.jobs.set(jobId, job);
    void this.runJob(job, options, Boolean(args.dryRun));
    return { jobId };
  }

  cancel(jobId: string): void {
    const job = this.jobs.get(jobId);
    if (!job) throw new DetectError('DETECT_JOB_NOT_FOUND', `检测任务不存在：${jobId}`, { jobId });
    if (job.status !== 'running' && job.status !== 'queued') return;
    job.controller.abort();
    this.media.cancelJob(jobId);
    job.child?.kill();
    job.status = 'cancelled';
    job.progress = 0;
  }

  getJob(jobId: string): DetectJobSnapshot {
    const job = this.jobs.get(jobId);
    if (!job) throw new DetectError('DETECT_JOB_NOT_FOUND', `检测任务不存在：${jobId}`, { jobId });
    return {
      jobId: job.jobId,
      projectId: job.projectId,
      status: job.status,
      progress: job.progress,
      error: job.error,
    };
  }

  apply(args: DetectApplyArgs): DetectApplyResult {
    this.data.projects.get(args.projectId);
    const preview = this.latestByProject.get(args.projectId);
    if (!preview) {
      throw new DetectError('DETECT_PREVIEW_NOT_FOUND', '没有可应用的检测预览', {
        projectId: args.projectId,
      });
    }
    const selectedShotIds = new Set(args.shotIds);
    const selectedShots = preview.shots.filter((shot) => selectedShotIds.has(shot.id));
    if (selectedShots.length !== selectedShotIds.size) {
      throw new DetectError('DETECT_PREVIEW_STALE', '部分预览镜头已失效，请重新检测', {
        missing: [...selectedShotIds].filter((id) => !preview.shots.some((shot) => shot.id === id)),
      });
    }
    const selectedSceneIds = args.sceneIds ? new Set(args.sceneIds) : null;
    const selectedScenes = selectedSceneIds
      ? preview.scenes.filter((scene) => selectedSceneIds.has(scene.id))
      : preview.scenes;
    if (selectedSceneIds && selectedScenes.length !== selectedSceneIds.size) {
      throw new DetectError('DETECT_PREVIEW_STALE', '部分预览场景已失效，请重新检测');
    }
    const applied = this.data.shots.applyDetected(args.projectId, selectedShots);
    this.data.scenes.replace(
      args.projectId,
      selectedScenes.map((scene, index) => ({ ...scene, index: index + 1 })),
    );
    return { applied };
  }

  dispose(): void {
    for (const job of this.jobs.values()) {
      job.controller.abort();
      job.child?.kill();
    }
    this.jobs.clear();
  }

  private async runJob(
    job: InternalDetectJob,
    options: ResolvedDetectOptions,
    dryRun: boolean,
  ): Promise<void> {
    try {
      job.status = 'running';
      const project = this.data.projects.get(job.projectId);
      const sourcePath = project.source.path || project.media.proxyPath;
      if (!sourcePath) {
        throw new DetectError('DETECT_SOURCE_MISSING', '项目没有可读取的视频路径', {
          projectId: job.projectId,
        });
      }

      const projectDir = ensureProjectDirs(this.data.dataRoot, project.id);
      const framesDir = join(projectDir, 'frames', 'detect');
      const fps = project.media.fps && project.media.fps > 0 ? project.media.fps : 25;
      const intervalMs = resolveIntervalMs(options, fps, project.media.durationMs);
      this.setProgress(job, 1, 'extractFrames');
      const extraction = await this.media.extractFrames(
        {
          path: sourcePath,
          outputDir: framesDir,
          intervalMs,
          startMs: 0,
          endMs: project.media.durationMs > 0 ? project.media.durationMs : undefined,
          format: 'jpg',
          prefix: 'detect',
          quality: 4,
          maxFrames: 20_000,
          timeoutMs: 30 * 60_000,
        },
        {
          jobId: job.jobId,
          onProgress: (event) => {
            if (job.controller.signal.aborted) return;
            this.setProgress(job, Math.min(55, Math.round(event.percent * 0.55)), 'extractFrames');
          },
        },
      );
      this.assertActive(job);

      const analysis = await this.runPython(
        job,
        extraction.frames.map((frame) => frame.path),
        intervalMs,
        options,
      );
      this.assertActive(job);
      const result = this.toPreview(job, project.id, analysis, project.media.durationMs);
      job.status = 'done';
      job.progress = 100;
      job.result = result;
      this.latestByProject.set(project.id, result);
      this.emitProgress({ jobId: job.jobId, stage: 'analyze', percent: 100 });
      this.emitDone({ jobId: job.jobId, result });
      if (dryRun) {
        // 预览仍缓存在内存，供确认后 detect:apply 使用。
      }
    } catch (error) {
      if (job.status === 'cancelled' || job.controller.signal.aborted) {
        job.status = 'cancelled';
        return;
      }
      job.status = 'error';
      job.error = error instanceof Error ? error.message : String(error);
    }
  }

  private async runPython(
    job: InternalDetectJob,
    framePaths: string[],
    intervalMs: number,
    options: ResolvedDetectOptions,
  ): Promise<PythonAnalyzeResult> {
    const python = resolvePythonExecutable();
    const script = resolveServerScript();
    if (!existsSync(script)) {
      throw new DetectError('DETECT_SERVER_NOT_FOUND', `检测服务不存在：${script}`, { script });
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
    job.child = child;
    this.setProgress(job, 58, 'analyze');

    let buffer = '';
    let stderr = '';
    const result = new Promise<PythonAnalyzeResult>((resolve, reject) => {
      const timeout = setTimeout(() => {
        child.kill();
        reject(new DetectError('DETECT_TIMEOUT', '检测分析超时', { jobId: job.jobId }));
      }, ANALYSIS_TIMEOUT_MS);

      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => {
        buffer += chunk;
        let newline = buffer.indexOf('\n');
        while (newline >= 0) {
          const line = buffer.slice(0, newline).trim();
          buffer = buffer.slice(newline + 1);
          newline = buffer.indexOf('\n');
          if (!line) continue;
          try {
            const message = JSON.parse(line) as {
              method?: string;
              params?: { percent?: number };
              result?: PythonAnalyzeResult;
              error?: { message?: string };
            };
            if (message.method === 'progress') {
              const percent = Number(message.params?.percent ?? 0);
              this.setProgress(job, 58 + Math.round(Math.max(0, Math.min(100, percent)) * 0.39), 'analyze');
            } else if (message.result) {
              clearTimeout(timeout);
              resolve(message.result);
            } else if (message.error) {
              clearTimeout(timeout);
              reject(new DetectError('DETECT_ANALYZE_FAILED', message.error.message ?? 'Python 检测失败'));
            }
          } catch (error) {
            clearTimeout(timeout);
            reject(new DetectError('DETECT_PROTOCOL_ERROR', `检测服务响应解析失败：${(error as Error).message}`, { line }));
          }
        }
      });
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (chunk: string) => {
        stderr = `${stderr}${chunk}`.slice(-4000);
      });
      child.on('error', (error) => {
        clearTimeout(timeout);
        reject(new DetectError('DETECT_SPAWN_FAILED', `无法启动 Python：${error.message}`, { python }));
      });
      child.on('exit', (code) => {
        if (job.status === 'cancelled' || job.controller.signal.aborted) {
          reject(new DetectError('DETECT_CANCELLED', '检测已取消'));
          return;
        }
        if (code !== 0) {
          clearTimeout(timeout);
          reject(new DetectError('DETECT_PROCESS_FAILED', `Python 检测进程退出（${code}）：${stderr}`, {
            code,
            stderr,
          }));
        }
      });
    });

    child.stdin.write(
      `${JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'analyze',
        params: {
          frames: framePaths,
          intervalMs,
          options,
        },
      })}\n`,
    );
    try {
      return await result;
    } finally {
      job.child = null;
      if (!child.killed) child.stdin.end();
    }
  }

  private toPreview(
    job: InternalDetectJob,
    projectId: string,
    result: PythonAnalyzeResult,
    durationMs: number,
  ): DetectResult {
    const intervalMs = result.intervalMs;
    const shotRanges = result.shotRanges.length
      ? result.shotRanges
      : [{ startFrame: 0, endFrame: Math.max(1, Math.round(durationMs / intervalMs)) }];
    const shots: ShotPreview[] = shotRanges.map((range, index) => {
      const startMs = Math.round(range.startFrame * intervalMs);
      let endMs = Math.round(range.endFrame * intervalMs);
      if (index === shotRanges.length - 1 && durationMs > endMs) endMs = durationMs;
      return {
        id: `preview-shot-${job.jobId}-${index + 1}`,
        index: index + 1,
        startMs,
        endMs,
        durationMs: Math.max(0, endMs - startMs),
      };
    });
    const now = new Date().toISOString();
    const scenes: Scene[] = result.sceneRanges.map((range, index) => ({
      id: `preview-scene-${job.jobId}-${index + 1}`,
      projectId,
      index: index + 1,
      label: `场景 ${String(index + 1).padStart(2, '0')}`,
      startMs: Math.round(range.startFrame * intervalMs),
      endMs:
        index === result.sceneRanges.length - 1 && durationMs > 0
          ? Math.max(Math.round(range.endFrame * intervalMs), durationMs)
          : Math.round(range.endFrame * intervalMs),
      createdAt: now,
      updatedAt: now,
    }));
    return { shots, scenes };
  }

  private setProgress(
    job: InternalDetectJob,
    percent: number,
    stage: DetectProgressEvent['stage'],
  ): void {
    if (job.status === 'cancelled') return;
    job.progress = Math.max(job.progress, Math.min(100, Math.round(percent)));
    this.emitProgress({ jobId: job.jobId, stage, percent: job.progress });
  }

  private assertActive(job: InternalDetectJob): void {
    if (job.controller.signal.aborted || job.status === 'cancelled') {
      throw new DetectError('DETECT_CANCELLED', '检测已取消');
    }
  }
}

function normalizeOptions(options: DetectOptions): ResolvedDetectOptions {
  const weights = {
    s: Number(options.weights?.s ?? DEFAULT_WEIGHTS.s),
    c: Number(options.weights?.c ?? DEFAULT_WEIGHTS.c),
    h: Number(options.weights?.h ?? DEFAULT_WEIGHTS.h),
  };
  const total = weights.s + weights.c + weights.h;
  if (![weights.s, weights.c, weights.h].every(Number.isFinite) || total <= 0) {
    throw new DetectError('INVALID_OPTIONS', '检测权重无效');
  }
  if (!Number.isFinite(options.sensitivity) || options.sensitivity < 0 || options.sensitivity > 1) {
    throw new DetectError('INVALID_OPTIONS', 'sensitivity 必须在 0~1 之间');
  }
  if (!Number.isFinite(options.minShotSeconds) || options.minShotSeconds <= 0) {
    throw new DetectError('INVALID_OPTIONS', 'minShotSeconds 必须大于 0');
  }
  if (options.frameInterval !== undefined && (!Number.isInteger(options.frameInterval) || options.frameInterval < 1)) {
    throw new DetectError('INVALID_OPTIONS', 'frameInterval 必须是正整数');
  }
  if (options.intervalMs !== undefined && (!Number.isFinite(options.intervalMs) || options.intervalMs < 50)) {
    throw new DetectError('INVALID_OPTIONS', 'intervalMs 不能小于 50ms');
  }
  return {
    ...options,
    weights: { s: weights.s / total, c: weights.c / total, h: weights.h / total },
  };
}

function resolveIntervalMs(options: ResolvedDetectOptions, fps: number, durationMs: number): number {
  if (options.intervalMs) return Math.max(50, Math.round(options.intervalMs));
  const frameStep = Math.max(1, options.frameInterval ?? 1);
  const requested = Math.round((1000 / Math.max(1, fps)) * frameStep * 6);
  const limitSafe = durationMs > 0 ? Math.ceil(durationMs / 20_000) : 50;
  return Math.max(250, requested, limitSafe);
}

function resolvePythonExecutable(): string {
  return process.env['DSH_PYTHON'] || process.env['PYTHON'] || 'python';
}

function resolveServerScript(): string {
  const development = join(__dirname, '..', '..', 'src', 'main', 'detect', 'python', 'server.py');
  if (existsSync(development)) return development;
  return join(process.resourcesPath, 'detect', 'python', 'server.py');
}
