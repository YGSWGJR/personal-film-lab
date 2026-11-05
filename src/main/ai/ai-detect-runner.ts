import { randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { DataLayer } from '../../data/db';
import { ensureProjectDirs } from '../../data/paths';
import type {
  DetectJobStatus,
  DetectResult,
  Project,
  Scene,
  ShotDetectionResult,
  ShotDetectionShot,
  ShotDetectionUsage,
  ShotPreview,
} from '../../shared/types';
import { shotDetectionResultSchema } from '../../shared/schemas';
import type { MediaService } from '../media/media-service';
import { resolveFrameCacheDir, resolveThumbCacheDir } from '../paths';
import type { ShotDetectionProvider } from './provider';
import { ProviderError } from './provider';

export class AiDetectError extends Error {
  readonly code: string;
  readonly details?: Record<string, unknown>;

  constructor(code: string, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = 'AiDetectError';
    this.code = code;
    this.details = details;
  }
}

export interface AiSegmentSpec {
  index: number;
  videoPath: string;
  startMs: number;
  endMs: number;
}

export interface AiRunnerOptions {
  segmentSeconds?: number;
  segmentOverlapSeconds?: number;
  maxRetriesPerSegment?: number;
}

export interface AiRunnerCallbacks {
  onProgress?: (percent: number, currentSegment: number, segmentsTotal: number) => void;
  onSegmentDone?: (segment: number, segmentsTotal: number, usage: ShotDetectionUsage) => void;
}

interface PersistedAiJob {
  jobId: string;
  projectId: string;
  videoPath: string;
  durationMs: number;
  segmentSeconds: number;
  segmentOverlapSeconds: number;
  status: DetectJobStatus;
  currentSegment: number;
  segmentsTotal: number;
  completed: Array<{ index: number; result: ShotDetectionResult }>;
  errors: Array<{ index: number; message: string }>;
  usage: ShotDetectionUsage;
  error: string | null;
  updatedAt: string;
}

export interface AiRunResult {
  jobId: string;
  result: DetectResult;
  usage: ShotDetectionUsage;
  status: DetectJobStatus;
  currentSegment: number;
  segmentsTotal: number;
  error: string | null;
}

export interface AiRunInput {
  project: Project;
  provider: ShotDetectionProvider;
  signal: AbortSignal;
  options?: AiRunnerOptions;
  callbacks?: AiRunnerCallbacks;
  resume?: boolean;
}

const DEFAULTS: Required<AiRunnerOptions> = {
  segmentSeconds: 600,
  segmentOverlapSeconds: 30,
  maxRetriesPerSegment: 3,
};

/** 按 600s/段 + 30s 重叠切段（纯函数，smoke 可机检）。 */
export function buildSegments(
  durationMs: number,
  videoPath: string,
  options: AiRunnerOptions = {},
): AiSegmentSpec[] {
  const segmentSeconds = Math.max(30, options.segmentSeconds ?? DEFAULTS.segmentSeconds);
  const overlapSeconds = Math.max(
    0,
    Math.min(segmentSeconds - 1, options.segmentOverlapSeconds ?? DEFAULTS.segmentOverlapSeconds),
  );
  const segmentMs = segmentSeconds * 1000;
  const duration = Math.max(1, Math.round(durationMs));
  const segments: AiSegmentSpec[] = [];
  let start = 0;
  let index = 1;
  while (start < duration) {
    const end = Math.min(duration, start + segmentMs);
    segments.push({ index, videoPath, startMs: start, endMs: end });
    if (end >= duration) break;
    start = Math.max(start + 1, end - overlapSeconds * 1000);
    index += 1;
    if (segments.length > 10_000) break;
  }
  return segments;
}

/**
 * 跨段去重 + 时间戳规范化：重叠区切点差 ≤2s 视为同一镜头；
 * 结果按 startMs 严格递增、首尾覆盖全片、无缺口。
 */
export function dedupeSegmentShots(
  completed: Array<{ index: number; result: ShotDetectionResult }>,
  durationMs: number,
): ShotDetectionShot[] {
  const sorted = [...completed]
    .sort((left, right) => left.index - right.index)
    .flatMap((item) => item.result.shots);
  sorted.sort((left, right) => left.startMs - right.startMs || left.endMs - right.endMs);
  const accepted: ShotDetectionShot[] = [];
  for (const shot of sorted) {
    const startMs = Math.max(0, Math.round(shot.startMs));
    const endMs = Math.max(startMs + 1, Math.round(shot.endMs));
    const previous = accepted.at(-1);
    if (previous) {
      // 同一段重叠区里的重复切点：起点差 ≤2s 视为同一镜头；
      // 任何与前一镜头重叠的候选都合并到前一镜头（取更早时间戳、扩展尾端）。
      const sameCut = Math.abs(startMs - previous.startMs) <= 2000;
      const overlaps = startMs < previous.endMs;
      if (sameCut || overlaps) {
        previous.endMs = Math.max(previous.endMs, endMs);
        continue;
      }
    }
    accepted.push({ ...shot, startMs, endMs });
  }
  if (accepted.length === 0) {
    accepted.push({
      id: `ai-full-${randomUUID()}`,
      startMs: 0,
      endMs: Math.max(1, Math.round(durationMs)),
      representativeTimeMs: Math.round(Math.max(1, durationMs) / 2),
      note: 'AI 未返回有效镜头，整片回退为单镜头',
      tags: { 景别: [], 机位: [], 运镜: [], 光线: [], 声音: [], 剪辑: [] },
      confidence: 0,
    });
  }
  const total = Math.max(1, Math.round(durationMs));
  accepted[0].startMs = 0;
  for (let index = 0; index < accepted.length; index += 1) {
    const next = accepted[index + 1];
    accepted[index].endMs = next ? next.startMs : Math.max(accepted[index].startMs + 1, total);
  }
  return accepted;
}

export class AiDetectRunner {
  constructor(
    private readonly data: DataLayer,
    private readonly media: MediaService,
  ) {}

  async run(input: AiRunInput): Promise<AiRunResult> {
    const { project, provider, signal } = input;
    const options: Required<AiRunnerOptions> = {
      segmentSeconds: Math.max(30, input.options?.segmentSeconds ?? DEFAULTS.segmentSeconds),
      segmentOverlapSeconds: Math.max(
        0,
        Math.min(
          Math.max(30, input.options?.segmentSeconds ?? DEFAULTS.segmentSeconds) - 1,
          input.options?.segmentOverlapSeconds ?? DEFAULTS.segmentOverlapSeconds,
        ),
      ),
      maxRetriesPerSegment: Math.max(
        0,
        Math.min(10, input.options?.maxRetriesPerSegment ?? DEFAULTS.maxRetriesPerSegment),
      ),
    };
    const durationMs = Math.max(1, Math.round(project.media.durationMs));
    const proxyPath = project.media.proxyPath;
    const videoPath =
      proxyPath && (/^https?:\/\//iu.test(proxyPath) || existsSync(proxyPath))
        ? proxyPath
        : project.source.path ?? '';
    if (!videoPath) {
      throw new AiDetectError('AI_SOURCE_MISSING', '项目没有可读取的视频路径');
    }
    const segments = buildSegments(durationMs, videoPath, options);
    const jobId = `ai-${randomUUID()}`;
    let state = input.resume
      ? this.loadResumable(project, videoPath, durationMs, segments.length)
      : null;
    if (!state) {
      state = {
        jobId,
        projectId: project.id,
        videoPath,
        durationMs,
        segmentSeconds: options.segmentSeconds,
        segmentOverlapSeconds: options.segmentOverlapSeconds,
        status: 'running',
        currentSegment: 0,
        segmentsTotal: segments.length,
        completed: [],
        errors: [],
        usage: { seconds: 0, tokens: 0, cost: 0 },
        error: null,
        updatedAt: new Date().toISOString(),
      };
    }
    state.status = 'running';
    state.error = null;
    this.saveState(state);

    const resumeFrom = input.resume ? nextSegmentOffset(state) : 0;
    input.callbacks?.onProgress?.(
      Math.round((state.completed.length / segments.length) * 100),
      resumeFrom,
      segments.length,
    );

    const aiSegmentDir = join(resolveFrameCacheDir(), 'ai-segments', project.id, state.jobId);
    try {
      for (const segment of segments.slice(resumeFrom)) {
        if (signal.aborted) {
          state.status = 'cancelled';
          state.error = null;
          this.saveState(state);
          throw new AiDetectError('AI_CANCELLED', 'AI 识别已取消', { jobId: state.jobId });
        }
        state.currentSegment = segment.index;
        this.saveState(state);
        let temporaryClip = '';
        try {
          let providerSegment = segment;
          if (provider.requiresVideoBytes && !/^https?:\/\//iu.test(segment.videoPath)) {
            const clipPath = join(
              aiSegmentDir,
              `segment-${String(segment.index).padStart(3, '0')}.mp4`,
            );
            await this.media.createAiSegment({
              path: segment.videoPath,
              startMs: segment.startMs,
              endMs: segment.endMs,
              outputPath: clipPath,
              signal,
            });
            temporaryClip = clipPath;
            providerSegment = { ...segment, videoPath: clipPath };
          }
          const result = await this.analyzeWithRetry(
            provider,
            providerSegment,
            options.maxRetriesPerSegment,
            signal,
          );
          state.completed = [...state.completed.filter((item) => item.index !== segment.index), {
            index: segment.index,
            result,
          }].sort((left, right) => left.index - right.index);
          state.errors = state.errors.filter((item) => item.index !== segment.index);
          state.usage = accumulateUsage(state.usage, result.usage);
          this.appendUsageLog(state, segment.index, result.usage, result.shots.length);
          input.callbacks?.onSegmentDone?.(segment.index, segments.length, result.usage);
        } catch (error) {
          if (signal.aborted || (error instanceof ProviderError && error.code === 'PROVIDER_CANCELLED')) {
            state.status = 'cancelled';
            this.saveState(state);
            throw new AiDetectError('AI_CANCELLED', 'AI 识别已取消', { jobId: state.jobId });
          }
          const message = error instanceof Error ? error.message : String(error);
          state.errors = [...state.errors.filter((item) => item.index !== segment.index), {
            index: segment.index,
            message,
          }].sort((left, right) => left.index - right.index);
        } finally {
          if (temporaryClip) rmSync(temporaryClip, { force: true });
        }
        this.saveState(state);
        input.callbacks?.onProgress?.(
          Math.round(((state.completed.length + state.errors.length) / segments.length) * 100),
          segment.index,
          segments.length,
        );
      }
    } finally {
      rmSync(aiSegmentDir, { recursive: true, force: true });
    }

    const deduped = dedupeSegmentShots(state.completed, durationMs);
    const shots: ShotPreview[] = deduped.map((shot, index) => ({
      id: `preview-ai-${state!.jobId}-${index + 1}`,
      index: index + 1,
      startMs: shot.startMs,
      endMs: shot.endMs,
      durationMs: shot.endMs - shot.startMs,
    }));
    await this.attachThumbnails(project, deduped, shots, signal);
    const scenes: Scene[] = [];
    state.status = state.errors.length > 0 ? 'error' : 'done';
    state.error = state.errors.length > 0
      ? `${state.errors.length} 个分段识别失败：${state.errors.map((item) => `#${item.index} ${item.message}`).join('；').slice(0, 1000)}`
      : null;
    state.currentSegment = segments.length;
    this.saveState(state);
    input.callbacks?.onProgress?.(100, segments.length, segments.length);
    return {
      jobId: state.jobId,
      result: { shots, scenes },
      usage: state.usage,
      status: state.status,
      currentSegment: state.currentSegment,
      segmentsTotal: segments.length,
      error: state.error,
    };
  }

  getPersisted(projectId: string): PersistedAiJob | null {
    return readJson<PersistedAiJob>(statePath(this.data.dataRoot, projectId));
  }

  private async analyzeWithRetry(
    provider: ShotDetectionProvider,
    segment: AiSegmentSpec,
    maxRetries: number,
    signal: AbortSignal,
  ): Promise<ShotDetectionResult> {
    let lastError: unknown = null;
    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      if (signal.aborted) throw new AiDetectError('AI_CANCELLED', 'AI 识别已取消');
      try {
        const result = await provider.analyzeSegment(
          { videoPath: segment.videoPath, startMs: segment.startMs, endMs: segment.endMs },
          signal,
        );
        const validated = shotDetectionResultSchema.safeParse(result);
        if (!validated.success) {
          throw new ProviderError('CONTRACT_INVALID', '单段结果未通过 shot-detection 契约校验', {
            issues: validated.error.issues.slice(0, 10),
          });
        }
        return validated.data as ShotDetectionResult;
      } catch (error) {
        lastError = error;
        if (signal.aborted) throw error;
        if (error instanceof ProviderError && error.code === 'PROVIDER_CANCELLED') throw error;
      }
    }
    throw lastError instanceof Error
      ? lastError
      : new ProviderError('CONTRACT_INVALID', '单段识别在重发后仍未通过契约校验');
  }

  private async attachThumbnails(
    project: Project,
    deduped: ShotDetectionShot[],
    previews: ShotPreview[],
    signal: AbortSignal,
  ): Promise<void> {
    const sourcePath = project.media.proxyPath || project.source.path || '';
    if (!sourcePath) return;
    try {
      ensureProjectDirs(this.data.dataRoot, project.id);
      const thumbsDir = join(resolveThumbCacheDir(), project.id);
      rmSync(thumbsDir, { recursive: true, force: true });
      mkdirSync(thumbsDir, { recursive: true });
      for (let index = 0; index < previews.length; index += 1) {
        if (signal.aborted) return;
        const preview = previews[index];
        const shot = deduped[index];
        const sourceFrame = join(thumbsDir, `.source-${index}.jpg`);
        const target = join(thumbsDir, `shot-${String(preview.index).padStart(4, '0')}-${shot.representativeTimeMs}ms.jpg`);
        try {
          await this.media.extractFrame({
            path: sourcePath,
            timeMs: shot.representativeTimeMs,
            outputPath: sourceFrame,
            format: 'jpg',
            quality: 6,
            timeoutMs: 60_000,
          });
          await this.media.createThumbnail(sourceFrame, target, 160, 8);
          preview.thumbnail = target;
          preview.thumbPath = target;
        } catch (error) {
          console.warn(`[ai] thumbnail failed for shot ${preview.index}: ${(error as Error).message}`);
        } finally {
          try {
            rmSync(sourceFrame, { force: true });
          } catch {
            // ignore cleanup failures
          }
        }
      }
    } catch (error) {
      console.warn(`[ai] thumbnail stage skipped: ${(error as Error).message}`);
    }
  }

  private loadResumable(
    project: Project,
    videoPath: string,
    durationMs: number,
    segmentsTotal: number,
  ): PersistedAiJob | null {
    const state = readJson<PersistedAiJob>(statePath(this.data.dataRoot, project.id));
    if (!state || state.status === 'done') return null;
    if (state.videoPath !== videoPath || state.durationMs !== durationMs) return null;
    if (state.segmentsTotal !== segmentsTotal) return null;
    return state;
  }

  private saveState(state: PersistedAiJob): void {
    state.updatedAt = new Date().toISOString();
    const path = statePath(this.data.dataRoot, state.projectId);
    mkdirSync(dirname(path), { recursive: true });
    const temporary = `${path}.${randomUUID()}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
    try {
      renameSync(temporary, path);
    } catch (error) {
      rmSync(temporary, { force: true });
      throw error;
    }
  }

  private appendUsageLog(
    state: PersistedAiJob,
    segment: number,
    usage: ShotDetectionUsage,
    shotCount: number,
  ): void {
    try {
      const path = logPath(this.data.dataRoot, state.projectId);
      mkdirSync(dirname(path), { recursive: true });
      appendFileSync(
        path,
        `${JSON.stringify({
          at: new Date().toISOString(),
          jobId: state.jobId,
          segment,
          seconds: usage.seconds,
          tokens: usage.tokens,
          cost: usage.cost ?? 0,
          shotCount,
        })}\n`,
        'utf8',
      );
    } catch (error) {
      console.warn(`[ai] usage log failed: ${(error as Error).message}`);
    }
  }
}

/** 已连续完成的段数（0-based 数组偏移；段号本身是 1-based）。 */
function nextSegmentOffset(state: PersistedAiJob): number {
  const indexes = new Set(state.completed.map((item) => item.index));
  let offset = 0;
  while (indexes.has(offset + 1)) offset += 1;
  return offset;
}

function accumulateUsage(left: ShotDetectionUsage, right: ShotDetectionUsage): ShotDetectionUsage {
  return {
    seconds: left.seconds + right.seconds,
    tokens: left.tokens + right.tokens,
    cost: (left.cost ?? 0) + (right.cost ?? 0),
  };
}

function statePath(dataRoot: string, projectId: string): string {
  return join(dataRoot, '.ai-jobs', `${projectId}.json`);
}

function logPath(dataRoot: string, projectId: string): string {
  return join(dataRoot, '.ai-jobs', `${projectId}.log`);
}

function readJson<T>(path: string): T | null {
  try {
    if (!existsSync(path)) return null;
    return JSON.parse(readFileSync(path, 'utf8')) as T;
  } catch {
    return null;
  }
}
