import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, rmSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { DataLayer } from '../../data/db';
import { ensureProjectDirs } from '../../data/paths';
import type {
  DetectApplyArgs,
  DetectApplyResult,
  DetectDoneEvent,
  DetectEnvCheck,
  DetectJobSnapshot,
  DetectJobStatus,
  DetectOptions,
  DetectProgressEvent,
  DetectResult,
  DetectRunArgs,
  DetectRunResult,
  DetectWeights,
  Project,
  RecognitionEngine,
  Scene,
  Settings,
  ShotDetectionUsage,
  ShotPreview,
} from '../../shared/types';
import type { AiDetectRunner } from '../ai/ai-detect-runner';
import type { ShotDetectionProvider } from '../ai/provider';
import type { MediaService } from '../media/media-service';
import { resolveDetectFramesDir, resolveThumbCacheDir } from '../paths';
import { DetectError } from './detect-error';

const DEFAULT_WEIGHTS = { s: 0.15, c: 0.15, h: 0.25, hv: 0.2, edge: 0.1, grid: 0.15 };
const ANALYSIS_TIMEOUT_MS = 10 * 60_000;
const ENV_CHECK_TIMEOUT_MS = 8_000;
const ENV_CACHE_TTL_MS = 10_000;
const EMBEDDED_PYTHON_BOOTSTRAP =
  "import runpy,sys; sys.path.insert(0,sys.argv[1]); runpy.run_path(sys.argv[2],run_name='__main__')";
const environmentCache = new Map<string, { expiresAt: number; result: DetectEnvCheck }>();

interface InternalDetectJob {
  jobId: string;
  projectId: string;
  engine: RecognitionEngine;
  status: DetectJobStatus;
  progress: number;
  error: string | null;
  controller: AbortController;
  child: ChildProcessWithoutNullStreams | null;
  result: DetectResult | null;
  currentSegment: number;
  segmentsTotal: number;
  usage: ShotDetectionUsage | null;
  provider: ShotDetectionProvider | null;
}

interface AiDetectDeps {
  runner: AiDetectRunner;
  getSettings: () => Settings;
  getProvider: () => ShotDetectionProvider;
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
    private readonly ai?: AiDetectDeps,
  ) {}

  run(args: DetectRunArgs): DetectRunResult {
    const project = getDetectProject(this.data, args.projectId);
    for (const job of this.jobs.values()) {
      if (job.projectId === args.projectId && job.status === 'running') {
        throw new DetectError('DETECT_ALREADY_RUNNING', '该项目已有检测任务正在运行', {
          jobId: job.jobId,
        });
      }
    }
    const engine: RecognitionEngine =
      args.options.engine ?? this.ai?.getSettings().recognition?.engine ?? 'ai';
    if (engine === 'ai') {
      if (!this.ai) {
        throw new DetectError('AI_NOT_READY', 'AI 识别服务尚未初始化');
      }
      if (this.ai.getSettings().ai?.enabled === false) {
        throw new DetectError('AI_DISABLED', 'AI 识别已在设置中关闭');
      }
    } else {
      resolveDetectSource(project);
    }
    const options = normalizeOptions(args.options);

    const jobId = `detect-${randomUUID()}`;
    const job: InternalDetectJob = {
      jobId,
      projectId: args.projectId,
      engine,
      status: 'queued',
      progress: 0,
      error: null,
      controller: new AbortController(),
      child: null,
      result: null,
      currentSegment: 0,
      segmentsTotal: 0,
      usage: null,
      provider: null,
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
    job.provider?.cancel();
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
      engine: job.engine,
      currentSegment: job.currentSegment,
      segmentsTotal: job.segmentsTotal,
      usage: job.usage ?? undefined,
    };
  }

  apply(args: DetectApplyArgs): DetectApplyResult {
    const preview = this.latestByProject.get(args.projectId);
    if (!preview) {
      throw new DetectError('DETECT_PREVIEW_NOT_FOUND', '没有可应用的检测预览', {
        projectId: args.projectId,
      });
    }
    return this.applyPreview(args.projectId, preview, args.shotIds, args.sceneIds);
  }

  /** S36-2b：MCP 按 jobId 应用识别预览。 */
  getJobResult(jobId: string): DetectResult {
    const job = this.jobs.get(jobId);
    if (!job || !job.result) {
      throw new DetectError('DETECT_PREVIEW_NOT_FOUND', `任务没有可应用的预览：${jobId}`, { jobId });
    }
    return job.result;
  }

  applyByJob(jobId: string, shotIds?: string[], sceneIds?: string[]): DetectApplyResult {
    const job = this.jobs.get(jobId);
    if (!job || !job.result) {
      throw new DetectError('DETECT_PREVIEW_NOT_FOUND', `任务没有可应用的预览：${jobId}`, { jobId });
    }
    const ids = shotIds && shotIds.length > 0 ? shotIds : job.result.shots.map((shot) => shot.id);
    return this.applyPreview(job.projectId, job.result, ids, sceneIds);
  }

  private applyPreview(
    projectId: string,
    preview: DetectResult,
    shotIds: string[],
    sceneIds?: string[],
  ): DetectApplyResult {
    this.data.projects.get(projectId);
    const selectedShotIds = new Set(shotIds);
    const selectedShots = preview.shots.filter((shot) => selectedShotIds.has(shot.id));
    if (selectedShots.length !== selectedShotIds.size) {
      throw new DetectError('DETECT_PREVIEW_STALE', '部分预览镜头已失效，请重新检测', {
        missing: [...selectedShotIds].filter((id) => !preview.shots.some((shot) => shot.id === id)),
      });
    }
    const selectedSceneIds = sceneIds ? new Set(sceneIds) : null;
    const selectedScenes = selectedSceneIds
      ? preview.scenes.filter((scene) => selectedSceneIds.has(scene.id))
      : preview.scenes;
    if (selectedSceneIds && selectedScenes.length !== selectedSceneIds.size) {
      throw new DetectError('DETECT_PREVIEW_STALE', '部分预览场景已失效，请重新检测');
    }
    const applied = this.data.shots.applyDetected(projectId, selectedShots);
    this.data.scenes.replace(
      projectId,
      selectedScenes.map((scene, index) => ({ ...scene, index: index + 1 })),
    );
    return { applied };
  }

  async checkEnvironment(): Promise<DetectEnvCheck> {
    const pythonPath = resolvePythonExecutable();
    const cacheKey = `${pythonPath}|${process.resourcesPath}`;
    const cached = environmentCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      console.info('[env] cache hit');
      return cached.result;
    }

    const result = probePythonEnvironment(pythonPath);
    environmentCache.set(cacheKey, {
      expiresAt: Date.now() + ENV_CACHE_TTL_MS,
      result,
    });
    if (result.ok) {
      console.info(
        `[env] Python ${result.pythonVersion}, OpenCV ${result.cv2Version}, NumPy ${result.numpyVersion}`,
      );
    } else {
      console.warn(`[env] ${result.error?.code}: ${result.error?.message}`);
    }
    return result;
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
    if (job.engine === 'ai') {
      await this.runAiJob(job, options);
      return;
    }
    await this.runOpenCvJob(job, options, dryRun);
  }

  private async runAiJob(
    job: InternalDetectJob,
    _options: ResolvedDetectOptions,
  ): Promise<void> {
    const ai = this.ai;
    if (!ai) {
      job.status = 'error';
      job.error = 'AI 识别服务尚未初始化';
      return;
    }
    try {
      job.status = 'running';
      const project = getDetectProject(this.data, job.projectId);
      const settings = ai.getSettings();
      const provider = ai.getProvider();
      job.provider = provider;
      const result = await ai.runner.run({
        project,
        provider,
        signal: job.controller.signal,
        resume: true,
        options: {
          segmentSeconds: settings.ai?.segmentSeconds,
          segmentOverlapSeconds: settings.ai?.segmentOverlapSeconds,
          maxRetriesPerSegment: settings.ai?.maxRetriesPerSegment,
        },
        callbacks: {
          onProgress: (percent, current, total) => {
            job.currentSegment = current;
            job.segmentsTotal = total;
            this.setProgress(job, percent, 'analyze');
          },
        },
      });
      job.currentSegment = result.currentSegment;
      job.segmentsTotal = result.segmentsTotal;
      job.usage = result.usage;
      job.progress = 100;
      job.error = result.error;
      job.status = result.status;
      job.result = result.result;
      this.latestByProject.set(project.id, result.result);
      this.emitProgress({ jobId: job.jobId, stage: 'analyze', percent: 100 });
      this.emitDone({ jobId: job.jobId, result: result.result });
    } catch (error) {
      if (job.status === 'cancelled' || job.controller.signal.aborted) {
        job.status = 'cancelled';
        return;
      }
      job.status = 'error';
      job.error = error instanceof Error ? error.message : String(error);
    }
  }

  private async runOpenCvJob(
    job: InternalDetectJob,
    options: ResolvedDetectOptions,
    dryRun: boolean,
  ): Promise<void> {
    let framesDir: string | null = null;
    try {
      job.status = 'running';
      const environment = await this.checkEnvironment();
      if (!environment.ok && environment.error) {
        throw new DetectError(environment.error.code, `${environment.error.message}。${environment.error.guide}`, {
          guide: environment.error.guide,
        });
      }
      const project = getDetectProject(this.data, job.projectId);
      const sourcePath = resolveDetectSource(project);
      const extractionPath = this.resolveExtractionPath(project, sourcePath);
      console.info(
        `[detect] extraction input=${extractionPath === sourcePath ? 'source' : 'proxy'} path=${extractionPath}`,
      );

      ensureProjectDirs(this.data.dataRoot, project.id);
      // S37：每个检测 job 独立帧目录，避免旧任务失败/取消后的异步 cleanup
      // 删掉新任务刚抽出的帧（detect000001.jpg 丢失）。
      framesDir = join(resolveDetectFramesDir(project.id), job.jobId);
      const thumbsDir = join(resolveThumbCacheDir(), project.id);
      const fps = project.media.fps && project.media.fps > 0 ? project.media.fps : 25;
      const durationMs = project.media.durationMs;
      const intervalMs = resolveIntervalMs(options, fps, durationMs);
      const estimatedFrames = durationMs > 0 ? Math.ceil(durationMs / intervalMs) + 32 : 50_000;
      const maxFrames = Math.min(50_000, estimatedFrames);
      if (estimatedFrames > 50_000) {
        console.warn(`[detect] estimated ${estimatedFrames} frames exceeds cap; using maxFrames=50000`);
      }
      this.setProgress(job, 1, 'extractFrames');
      const extraction = await this.media.extractFrames(
        {
          path: extractionPath,
          outputDir: framesDir,
          intervalMs,
          startMs: 0,
          endMs: durationMs > 0 ? durationMs : undefined,
          format: 'jpg',
          prefix: 'detect',
          quality: 4,
          maxFrames,
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
      if (extraction.frames.length === 0) {
        throw new DetectError('DETECT_FRAMES_MISSING', '抽帧完成但没有可用帧，请重新检测', {
          jobId: job.jobId,
          framesDir,
        });
      }
      const missingFrame = extraction.frames.find((frame) => !existsSync(frame.path));
      if (missingFrame) {
        throw new DetectError('DETECT_FRAMES_MISSING', '检测帧文件在分析前被清理，请重新检测', {
          jobId: job.jobId,
          framesDir,
          missingPath: missingFrame.path,
        });
      }

      const analysis = await this.runPython(
        job,
        extraction.frames.map((frame) => frame.path),
        intervalMs,
        options,
      );
      this.assertActive(job);
      const result = this.toPreview(job, project.id, analysis, project.media.durationMs);
      await this.createShotThumbnails(job, project, result.shots, sourcePath, thumbsDir, extraction.frames);
      this.assertActive(job);
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
    } finally {
      this.cleanupDetectFrames(framesDir);
    }
  }

  private async createShotThumbnails(
    job: InternalDetectJob,
    project: Project,
    shots: ShotPreview[],
    sourcePath: string,
    thumbsDir: string,
    extractedFrames: Array<{ timeMs: number; path: string }>,
  ): Promise<void> {
    try {
      rmSync(thumbsDir, { recursive: true, force: true });
      mkdirSync(thumbsDir, { recursive: true });
    } catch (error) {
      console.warn(`[detect] thumbnail directory unavailable: ${(error as Error).message}`);
      return;
    }

    for (const shot of shots) {
      this.assertActive(job);
      const index = String(shot.index).padStart(4, '0');
      const timestamp = Date.now();
      const filename = `shot-${index}-${shot.startMs}ms-${timestamp}.jpg`;
      const thumbnailPath = join(thumbsDir, filename);
      const sourceFramePath = join(thumbsDir, `.${filename}.source.jpg`);
      let inputFramePath: string | null = null;
      let removeInputFrame = false;
      try {
        const nearestFrame = extractedFrames.reduce<(typeof extractedFrames)[number] | null>(
          (nearest, frame) =>
            !nearest || Math.abs(frame.timeMs - shot.startMs) < Math.abs(nearest.timeMs - shot.startMs)
              ? frame
              : nearest,
          null,
        );
        if (nearestFrame && Math.abs(nearestFrame.timeMs - shot.startMs) <= Math.max(1, shot.durationMs)) {
          inputFramePath = nearestFrame.path;
        } else {
          await this.media.extractFrame({
            path: sourcePath,
            timeMs: shot.startMs,
            outputPath: sourceFramePath,
            format: 'jpg',
            quality: 8,
          });
          inputFramePath = sourceFramePath;
          removeInputFrame = true;
        }
        await this.createThumbnailImage(inputFramePath, thumbnailPath, 160, 8);
        shot.thumbnail = thumbnailPath;
        shot.thumbPath = thumbnailPath;
      } catch (error) {
        console.warn(`[detect] shot ${project.id}#${shot.index} thumbnail failed: ${(error as Error).message}`);
        try {
          rmSync(thumbnailPath, { force: true });
        } catch (cleanupError) {
          // A partial thumbnail must not fail the detection job.
          console.warn(
            `[detect] 临时缩略图清理失败: ${thumbnailPath}: ${(cleanupError as Error).message}`,
          );
        }
      } finally {
        if (removeInputFrame) {
          try {
            rmSync(sourceFramePath, { force: true });
          } catch (cleanupError) {
            // A stale source frame must not fail the detection job.
            console.warn(
              `[detect] 临时抽帧清理失败: ${sourceFramePath}: ${(cleanupError as Error).message}`,
            );
          }
        }
      }
    }
  }

  private resolveExtractionPath(project: Project, sourcePath: string): string {
    const configured = project.media.proxyPath;
    if (configured && isNonEmptyFile(configured)) return configured;
    return this.media.findProxyForSource(sourcePath) ?? sourcePath;
  }

  private async createThumbnailImage(
    inputFramePath: string,
    thumbnailPath: string,
    width: number,
    quality: number,
  ): Promise<void> {
    await this.media.createThumbnail(inputFramePath, thumbnailPath, width, quality);
  }

  private cleanupDetectFrames(framesDir: string | null): void {
    if (!framesDir) return;
    try {
      rmSync(framesDir, { recursive: true, force: true });
    } catch (error) {
      console.warn(`[detect] detect frame cleanup failed: ${(error as Error).message}`);
    }
  }

  private async runPython(
    job: InternalDetectJob,
    framePaths: string[],
    intervalMs: number,
    options: ResolvedDetectOptions,
  ): Promise<PythonAnalyzeResult> {
    const python = resolvePythonExecutable();
    const embeddedPython = embeddedPythonExecutable();
    const embedded = embeddedPython !== null && python === embeddedPython;
    console.info(`[detect] python runtime: ${embedded ? 'embedded' : 'external'} (${python})`);
    const script = resolveServerScript();
    if (!existsSync(script)) {
      throw new DetectError('DETECT_SERVER_NOT_FOUND', `检测服务不存在：${script}`, { script });
    }
    const scriptDir = dirname(script);
    const pythonArgs = embedded ? ['-c', EMBEDDED_PYTHON_BOOTSTRAP, scriptDir, script] : [script];
    const child = spawn(python, pythonArgs, {
      cwd: scriptDir,
      windowsHide: true,
      env: {
        ...buildPythonEnvironment(python),
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
    hv: Number(options.weights?.hv ?? DEFAULT_WEIGHTS.hv),
    edge: Number(options.weights?.edge ?? DEFAULT_WEIGHTS.edge),
    grid: Number(options.weights?.grid ?? DEFAULT_WEIGHTS.grid),
  };
  const values = [weights.s, weights.c, weights.h, weights.hv, weights.edge, weights.grid];
  const total = values.reduce((sum, value) => sum + value, 0);
  if (!values.every(Number.isFinite) || total <= 0) {
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
    weights: {
      s: weights.s / total,
      c: weights.c / total,
      h: weights.h / total,
      hv: weights.hv / total,
      edge: weights.edge / total,
      grid: weights.grid / total,
    },
  };
}

export function resolveIntervalMs(
  options: Pick<DetectOptions, 'intervalMs' | 'frameInterval'>,
  fps: number,
  _durationMs: number,
): number {
  if (options.intervalMs) return Math.max(50, Math.round(options.intervalMs));
  const frameStep = Math.max(1, options.frameInterval ?? 12);
  return Math.max(50, Math.round((1000 / Math.max(1, fps)) * frameStep));
}

function embeddedPythonExecutable(resourcesPath = process.resourcesPath): string | null {
  const executable = join(resourcesPath, 'python', 'python.exe');
  return existsSync(executable) ? executable : null;
}

export function resolvePythonExecutable(resourcesPath = process.resourcesPath): string {
  const embedded = embeddedPythonExecutable(resourcesPath);
  if (embedded) return embedded;
  return process.env['DSH_PYTHON'] || process.env['PYTHON'] || 'python';
}

function buildPythonEnvironment(pythonPath: string): NodeJS.ProcessEnv {
  const embedded =
    embeddedPythonExecutable() !== null && pythonPath === embeddedPythonExecutable();
  return {
    ...process.env,
    PYTHONIOENCODING: 'utf-8',
    PYTHONUNBUFFERED: '1',
    ...(embedded ? { PYTHONPATH: join(process.resourcesPath, 'python', 'Lib', 'site-packages') } : {}),
  };
}

function probePythonEnvironment(pythonPath: string): DetectEnvCheck {
  const installed = embeddedPythonExecutable() !== null;
  const probe = spawnSync(
    pythonPath,
    [
      '-c',
      'import sys, cv2, numpy; print(sys.version.split()[0]); print(cv2.__version__); print(numpy.__version__)',
    ],
    {
      windowsHide: true,
      encoding: 'utf8',
      timeout: ENV_CHECK_TIMEOUT_MS,
      maxBuffer: 1024 * 1024,
      env: buildPythonEnvironment(pythonPath),
    },
  );
  const errorCode = (probe.error as NodeJS.ErrnoException | undefined)?.code;
  if (errorCode === 'ETIMEDOUT' || probe.signal === 'SIGTERM') {
    return environmentFailure(
      'ENV_PROBE_TIMEOUT',
      'Python 检测环境响应超时',
      '检测环境响应超时，请检查 Python 安装状态后重试',
      pythonPath,
    );
  }
  if (errorCode === 'ENOENT' || probe.error) {
    return environmentFailure(
      'PYTHON_NOT_FOUND',
      '未找到可用的 Python 检测引擎',
      environmentGuide('PYTHON_NOT_FOUND', installed),
      pythonPath,
    );
  }

  const stderr = String(probe.stderr || '').trim();
  if (probe.status !== 0) {
    let code = 'ENV_PROBE_FAILED';
    let message = 'Python 检测环境无法启动';
    if (/no module named ['"]?cv2|opencv/i.test(stderr)) {
      code = 'OPENCV_NOT_FOUND';
      message = '检测依赖 OpenCV 无法加载';
    } else if (/no module named ['"]?numpy|numpy/i.test(stderr)) {
      code = 'NUMPY_NOT_FOUND';
      message = '检测依赖 NumPy 无法加载';
    }
    return environmentFailure(code, message, environmentGuide(code, installed), pythonPath);
  }

  const lines = String(probe.stdout || '')
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length < 3) {
    return environmentFailure(
      'ENV_PROBE_FAILED',
      'Python 检测环境返回了无效结果',
      environmentGuide('ENV_PROBE_FAILED', installed),
      pythonPath,
    );
  }
  return {
    ok: true,
    pythonPath,
    pythonVersion: lines[0],
    cv2Version: lines[1],
    numpyVersion: lines[2],
    error: null,
  };
}

function environmentFailure(code: string, message: string, guide: string, pythonPath: string): DetectEnvCheck {
  return {
    ok: false,
    pythonPath,
    pythonVersion: null,
    cv2Version: null,
    numpyVersion: null,
    error: { code, message, guide },
  };
}

function environmentGuide(code: string, installed: boolean): string {
  if (code === 'PYTHON_NOT_FOUND') {
    return installed
      ? '检测引擎未随程序安装，请重新安装本软件或联系维护者'
      : '未找到 Python，请安装 Python 3.12+ 或设置 DSH_PYTHON 环境变量指向 python.exe';
  }
  if (code === 'OPENCV_NOT_FOUND') {
    return installed ? '检测依赖（OpenCV）缺失，请重新安装本软件' : '请执行 pip install opencv-python 后重试';
  }
  if (code === 'NUMPY_NOT_FOUND') {
    return installed ? '检测依赖（NumPy）缺失，请重新安装本软件' : '请执行 pip install numpy 后重试';
  }
  if (code === 'ENV_PROBE_TIMEOUT') {
    return '检测环境响应超时，请检查 Python 安装状态后重试';
  }
  return installed ? '检测引擎异常，请重新安装本软件' : '请检查 Python 与 OpenCV/NumPy 安装后重试';
}

function getDetectProject(data: DataLayer, projectId: string): Project {
  try {
    return data.projects.get(projectId);
  } catch (error) {
    if (error instanceof Error && (error as { code?: string }).code === 'PROJECT_NOT_FOUND') {
      throw new DetectError(
        'PROJECT_NOT_FOUND',
        '找不到该项目：可能已删除，或数据目录已变更。请通过启动导入向导恢复项目，或重新导入素材',
        { guide: '请通过启动导入向导恢复项目，或重新导入素材' },
      );
    }
    throw error;
  }
}

function resolveDetectSource(project: Project): string {
  const sourcePath =
    (project.source.path && isNonEmptyFile(project.source.path) ? project.source.path : null) ||
    (project.media.proxyPath && isNonEmptyFile(project.media.proxyPath) ? project.media.proxyPath : null) ||
    project.source.path ||
    project.media.proxyPath;
  if (!sourcePath) {
    throw new DetectError('DETECT_SOURCE_MISSING', '项目没有可读取的视频路径', {
      projectId: project.id,
      guide: '请在导入向导中重新导入该素材',
    });
  }
  if (project.source.type !== 'url' && !existsSync(sourcePath)) {
    throw new DetectError('DETECT_SOURCE_MISSING', `视频源文件不存在或已被移动/删除：${sourcePath}`, {
      projectId: project.id,
      sourcePath,
      guide: `请在导入向导中重新导入该素材（原路径：${sourcePath}）`,
    });
  }
  return sourcePath;
}

function isNonEmptyFile(path: string): boolean {
  try {
    const stat = statSync(path);
    return stat.isFile() && stat.size > 0;
  } catch {
    return false;
  }
}

function resolveServerScript(): string {
  const development = join(__dirname, '..', '..', 'src', 'main', 'detect', 'python', 'server.py');
  if (existsSync(development)) return development;
  return join(process.resourcesPath, 'detect', 'python', 'server.py');
}
