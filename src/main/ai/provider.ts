import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname } from 'node:path';
import { net } from 'electron';
import type {
  AiListModelsResult,
  AiProviderProbeResult,
  AiProviderConfig,
  AiSettings,
  ShotDetectionResult,
  ShotDetectionSegment,
  ShotDetectionUsage,
} from '../../shared/types';
import { shotDetectionResultSchema } from '../../shared/schemas';
import { decryptApiKey } from './credential-store';

export class ProviderError extends Error {
  readonly code: string;
  readonly details?: Record<string, unknown>;

  constructor(code: string, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = 'ProviderError';
    this.code = code;
    this.details = details;
  }
}

export interface ShotDetectionProvider {
  readonly id: string;
  /** 为 true 时 runner 会先把本地视频切成低码率时间片。 */
  readonly requiresVideoBytes?: boolean;
  probeCapability(): Promise<AiProviderProbeResult>;
  listModels(): Promise<AiListModelsResult>;
  analyzeSegment(input: ShotDetectionSegment, signal: AbortSignal): Promise<ShotDetectionResult>;
  cancel(): void;
  getUsage(): ShotDetectionUsage;
}

interface OpenAiCompatOptions {
  baseUrl: string;
  apiKey: string;
  model?: string;
  timeoutMs?: number;
}

const VIDEO_MODEL_PATTERN =
  /(video|omni|gpt-4o|gpt-4\.1|gemini|qwen[-_.]?vl|qwen[-_.]?omni|claude-3|claude-4|vision|doubao[-_.]?seed|doubao)/iu;
const MAX_INLINE_VIDEO_BYTES = 64 * 1024 * 1024;

/** S36-7：显式模型/探测共用原生视频能力判定（含豆包）。 */
export function isNativeVideoModel(model: string): boolean {
  return VIDEO_MODEL_PATTERN.test(model);
}
const CONTRACT_PROMPT = [
  '你是影视镜头切分助手。直接观看输入的原生视频（不要依赖本地抽帧）。',
  '只输出 JSON 对象，不要 Markdown。结构必须是：',
  '{"segment":{"startMs":number,"endMs":number},',
  '"shots":[{"id":string,"startMs":number,"endMs":number,"representativeTimeMs":number,',
  '"note":string,"tags":{"景别":string[],"机位":string[],"运镜":string[],"光线":string[],"声音":string[],"剪辑":string[]},',
  '"confidence":0..1}],',
  '"usage":{"seconds":number,"tokens":number,"cost":number},"generatedAt":ISO8601}',
  '要求：shots 按 startMs 严格递增、无重叠；note = 景别+机位+主体+光线+运动；',
  'tags 必须包含上述六类键（可为空数组）；每个 shot 的六个必填字段不得缺失。',
  'time 单位均为毫秒，且相对整条视频。只分析 segment.startMs..segment.endMs 范围。',
].join('\n');

export class OpenAiCompatProvider implements ShotDetectionProvider {
  readonly id = 'openai-compatible';
  readonly requiresVideoBytes = true;
  private usage: ShotDetectionUsage = { seconds: 0, tokens: 0, cost: 0 };
  private aborted = false;
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly timeoutMs: number;
  private model: string | null;

  constructor(options: OpenAiCompatOptions) {
    this.baseUrl = options.baseUrl.trim().replace(/\/+$/u, '');
    this.apiKey = options.apiKey.trim();
    this.model = options.model?.trim() || null;
    this.timeoutMs = options.timeoutMs ?? 900_000;
  }

  async probeCapability(): Promise<AiProviderProbeResult> {
    if (!this.baseUrl) {
      return {
        ok: false,
        supportsNativeVideo: false,
        provider: this.id,
        model: this.model,
        error: { code: 'PROVIDER_BASE_URL_MISSING', message: '未配置 API 端点 baseUrl' },
      };
    }
    if (!this.apiKey) {
      return {
        ok: false,
        supportsNativeVideo: false,
        provider: this.id,
        model: this.model,
        error: { code: 'PROVIDER_API_KEY_MISSING', message: '未配置 API Key' },
      };
    }
    try {
      const response = await net.fetch(`${this.baseUrl}/models`, {
        method: 'GET',
        headers: { authorization: `Bearer ${this.apiKey}` },
        signal: AbortSignal.timeout(Math.min(this.timeoutMs, 20_000)),
      });
      if (!response.ok) {
        return {
          ok: false,
          supportsNativeVideo: false,
          provider: this.id,
          model: this.model,
          error: {
            code: 'PROVIDER_PROBE_HTTP',
            message: `能力探测失败：HTTP ${response.status}`,
          },
        };
      }
      const payload = (await response.json()) as { data?: Array<{ id?: unknown }> };
      const models = Array.isArray(payload.data)
        ? payload.data
            .map((item) => (typeof item.id === 'string' ? item.id : ''))
            .filter(Boolean)
        : [];
      if (!this.model) {
        this.model = models.find((id) => isNativeVideoModel(id)) ?? models[0] ?? null;
      }
      const supportsNativeVideo = Boolean(this.model && isNativeVideoModel(this.model));
      return {
        ok: true,
        supportsNativeVideo,
        provider: this.id,
        model: this.model,
        error: supportsNativeVideo
          ? null
          : {
              code: 'PROVIDER_NO_NATIVE_VIDEO',
              message: `模型 ${this.model ?? '(未知)'} 未声明原生视频输入能力，请更换支持视频的端点`,
            },
      };
    } catch (error) {
      return {
        ok: false,
        supportsNativeVideo: false,
        provider: this.id,
        model: this.model,
        error: {
          code: 'PROVIDER_PROBE_FAILED',
          message: describeFetchError(error),
        },
      };
    }
  }

  async listModels(): Promise<AiListModelsResult> {
    if (!this.baseUrl) {
      return {
        ok: false,
        error: { code: 'PROVIDER_BASE_URL_MISSING', message: '未配置 API 端点 baseUrl' },
      };
    }
    if (!this.apiKey) {
      return {
        ok: false,
        error: { code: 'PROVIDER_API_KEY_MISSING', message: '未配置 API Key' },
      };
    }
    try {
      const response = await net.fetch(`${this.baseUrl}/models`, {
        method: 'GET',
        headers: { authorization: `Bearer ${this.apiKey}` },
        signal: AbortSignal.timeout(Math.min(this.timeoutMs, 20_000)),
      });
      if (!response.ok) {
        const code =
          response.status === 401 || response.status === 403
            ? 'PROVIDER_AUTH_FAILED'
            : response.status === 404
              ? 'PROVIDER_MODELS_NOT_FOUND'
              : 'PROVIDER_MODELS_HTTP';
        return { ok: false, error: { code, message: `获取模型列表失败：HTTP ${response.status}` } };
      }
      const payload = (await response.json()) as { data?: Array<{ id?: unknown }> };
      const models = Array.isArray(payload.data)
        ? [
            ...new Set(
              payload.data
                .map((item) => (typeof item.id === 'string' ? item.id.trim() : ''))
                .filter(Boolean),
            ),
          ]
        : [];
      return { ok: true, models };
    } catch (error) {
      return {
        ok: false,
        error: {
          code: 'PROVIDER_MODELS_FAILED',
          message: describeFetchError(error),
        },
      };
    }
  }

  async analyzeSegment(input: ShotDetectionSegment, signal: AbortSignal): Promise<ShotDetectionResult> {
    if (this.aborted) throw new ProviderError('PROVIDER_CANCELLED', 'AI 识别已取消');
    if (!this.baseUrl) throw new ProviderError('PROVIDER_BASE_URL_MISSING', '未配置 API 端点 baseUrl');
    if (!this.apiKey) throw new ProviderError('PROVIDER_API_KEY_MISSING', '未配置 API Key');
    const model = this.model ?? (await this.probeCapability()).model;
    if (!model) throw new ProviderError('PROVIDER_MODEL_MISSING', '没有可用的视频模型');

    const videoUrl = buildVideoDataUrl(input.videoPath);
    const body = {
      model,
      temperature: 0.1,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: CONTRACT_PROMPT },
        {
          role: 'user',
          content: [
            { type: 'text', text: `segment.startMs=${input.startMs}; segment.endMs=${input.endMs}` },
            { type: 'video_url', video_url: { url: videoUrl } },
          ],
        },
      ],
    };
    let response: Response;
    try {
      response = await net.fetch(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.apiKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(body),
        signal: combinedSignal(signal, this.timeoutMs),
      });
    } catch (error) {
      if (this.aborted || signal.aborted) {
        throw new ProviderError('PROVIDER_CANCELLED', 'AI 识别已取消');
      }
      if (error instanceof Error && error.name === 'TimeoutError') {
        throw new ProviderError(
          'PROVIDER_REQUEST_TIMEOUT',
          `模型请求超时（${Math.round(this.timeoutMs / 1000)} 秒）`,
        );
      }
      throw new ProviderError('PROVIDER_REQUEST_FAILED', `模型请求失败：${describeFetchError(error)}`);
    }
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new ProviderError('PROVIDER_HTTP', `识别请求失败：HTTP ${response.status} ${text.slice(0, 300)}`);
    }
    const payload = (await response.json()) as {
      choices?: Array<{ message?: { content?: string | Array<{ type?: string; text?: string }> } }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number; cost?: number };
    };
    const content = extractMessageText(payload.choices?.[0]?.message?.content);
    if (!content) throw new ProviderError('CONTRACT_EMPTY', '模型未返回 JSON 内容');
    let parsed: unknown;
    try {
      parsed = JSON.parse(stripCodeFence(content));
    } catch (error) {
      throw new ProviderError('CONTRACT_JSON_INVALID', `模型返回不是合法 JSON：${(error as Error).message}`);
    }
    const normalized = normalizeRelativeSegmentTimes(parsed, input.startMs);
    const result = shotDetectionResultSchema.safeParse(normalized);
    if (!result.success) {
      throw new ProviderError('CONTRACT_INVALID', '模型返回未通过 shot-detection 契约校验', {
        issues: result.error.issues.slice(0, 10),
      });
    }
    const usage: ShotDetectionUsage = {
      seconds: result.data.usage.seconds,
      tokens:
        result.data.usage.tokens ||
        (payload.usage?.prompt_tokens ?? 0) + (payload.usage?.completion_tokens ?? 0),
      cost: result.data.usage.cost ?? payload.usage?.cost ?? 0,
    };
    this.usage = {
      seconds: this.usage.seconds + usage.seconds,
      tokens: this.usage.tokens + usage.tokens,
      cost: (this.usage.cost ?? 0) + (usage.cost ?? 0),
    };
    return { ...result.data, usage };
  }

  cancel(): void {
    this.aborted = true;
  }

  getUsage(): ShotDetectionUsage {
    return { ...this.usage };
  }
}

interface MockProviderOptions {
  shotsPerSegment?: number;
  failFirstAttempt?: boolean;
  delayMs?: number;
}

/** 确定性 mock provider：供 SMOKE_AI 与无网络自测使用。 */
export class MockProvider implements ShotDetectionProvider {
  readonly id = 'mock-video';
  readonly requiresVideoBytes = false;
  private usage: ShotDetectionUsage = { seconds: 0, tokens: 0, cost: 0 };
  private aborted = false;
  private failedOnce = false;
  private readonly shotsPerSegment: number;
  private readonly failFirstAttempt: boolean;
  private readonly delayMs: number;

  constructor(options: MockProviderOptions = {}) {
    this.shotsPerSegment = Math.max(1, options.shotsPerSegment ?? 2);
    this.failFirstAttempt = options.failFirstAttempt ?? false;
    this.delayMs = Math.max(0, options.delayMs ?? 0);
  }

  async probeCapability(): Promise<AiProviderProbeResult> {
    return {
      ok: true,
      supportsNativeVideo: true,
      provider: this.id,
      model: 'mock-video-v1',
      error: null,
    };
  }

  async listModels(): Promise<AiListModelsResult> {
    return { ok: true, models: ['mock-video-v1', 'mock-video-v2'] };
  }

  async analyzeSegment(input: ShotDetectionSegment, signal: AbortSignal): Promise<ShotDetectionResult> {
    if (this.aborted || signal.aborted) throw new ProviderError('PROVIDER_CANCELLED', 'AI 识别已取消');
    if (this.delayMs > 0) {
      await new Promise<void>((resolve) => setTimeout(resolve, this.delayMs));
      if (this.aborted || signal.aborted) throw new ProviderError('PROVIDER_CANCELLED', 'AI 识别已取消');
    }
    if (this.failFirstAttempt && !this.failedOnce) {
      this.failedOnce = true;
      throw new ProviderError('CONTRACT_INVALID', 'mock：首次返回缺字段，触发单段重发');
    }
    const start = Math.max(0, Math.round(input.startMs));
    const end = Math.max(start + 2, Math.round(input.endMs));
    const span = end - start;
    const count = Math.max(1, Math.min(this.shotsPerSegment, Math.floor(span / 2)));
    const shots = Array.from({ length: count }, (_, index) => {
      const shotStart = start + Math.round((span * index) / count);
      const shotEnd = index === count - 1 ? end : start + Math.round((span * (index + 1)) / count);
      return {
        id: `mock-${start}-${index + 1}`,
        startMs: shotStart,
        endMs: shotEnd,
        representativeTimeMs: Math.round((shotStart + shotEnd) / 2),
        note: `中景 · 固定 · mock 主体 · 自然光 · 静止（段 ${index + 1}）`,
        tags: {
          景别: ['中景'],
          机位: ['正面'],
          运镜: ['固定'],
          光线: ['自然光'],
          声音: ['环境'],
          剪辑: ['硬切'],
        },
        confidence: 0.82,
      };
    });
    const usage: ShotDetectionUsage = {
      seconds: Math.round(span / 10) / 100,
      tokens: 120 + count * 40,
      cost: 0.001 * count,
    };
    this.usage = {
      seconds: this.usage.seconds + usage.seconds,
      tokens: this.usage.tokens + usage.tokens,
      cost: (this.usage.cost ?? 0) + (usage.cost ?? 0),
    };
    return {
      segment: { startMs: start, endMs: end },
      shots,
      usage,
      generatedAt: new Date().toISOString(),
    };
  }

  cancel(): void {
    this.aborted = true;
  }

  getUsage(): ShotDetectionUsage {
    return { ...this.usage };
  }
}

export function createProviderFromSettings(
  settings: AiSettings | undefined,
  options: { forceMock?: boolean } = {},
): ShotDetectionProvider {
  if (options.forceMock || settings?.provider === 'mock') {
    return new MockProvider({
      failFirstAttempt: false,
      delayMs: Math.max(0, Number(process.env['SMOKE_DETECT_BG_DELAY_MS'] ?? '0') || 0),
    });
  }
  const active = resolveActiveProvider(settings);
  return new OpenAiCompatProvider({
    baseUrl: active?.baseUrl ?? settings?.baseUrl ?? '',
    apiKey: decryptApiKey(active?.apiKey ?? settings?.apiKey),
    model: active?.model ?? undefined,
    timeoutMs: Math.max(30, settings?.timeoutSeconds ?? 900) * 1000,
  });
}

/** S36-7：解析当前激活供应商；未命中回落到第一个；无列表回落 legacy。 */
export function resolveActiveProvider(settings: AiSettings | undefined): AiProviderConfig | null {
  const providers = settings?.providers ?? [];
  return providers.find((item) => item.id === settings?.activeProviderId) ?? providers[0] ?? null;
}

function buildVideoDataUrl(videoPath: string): string {
  if (/^https?:\/\//iu.test(videoPath)) return videoPath;
  if (!existsSync(videoPath)) {
    throw new ProviderError('PROVIDER_VIDEO_NOT_FOUND', `AI 视频时间片不存在：${videoPath}`);
  }
  const size = statSync(videoPath).size;
  if (size > MAX_INLINE_VIDEO_BYTES) {
    throw new ProviderError(
      'PROVIDER_VIDEO_TOO_LARGE',
      `AI 视频时间片过大（${(size / 1024 / 1024).toFixed(1)} MB），上限 ${MAX_INLINE_VIDEO_BYTES / 1024 / 1024} MB`,
    );
  }
  const buffer = readFileSync(videoPath);
  const ext = extname(videoPath).toLowerCase();
  const mime =
    ext === '.mov' ? 'video/quicktime' : ext === '.webm' ? 'video/webm' : ext === '.mkv' ? 'video/x-matroska' : 'video/mp4';
  return `data:${mime};base64,${buffer.toString('base64')}`;
}

/**
 * 多数兼容接口会对“仅包含当前分段的视频”返回从 0 开始的相对时间。
 * 若检测到相对时间，统一平移到整部影片的绝对时间轴。
 */
function normalizeRelativeSegmentTimes(value: unknown, segmentStartMs: number): unknown {
  if (!value || typeof value !== 'object') return value;
  const result = value as {
    segment?: { startMs?: unknown; endMs?: unknown };
    shots?: Array<{ startMs?: unknown; endMs?: unknown; representativeTimeMs?: unknown }>;
  };
  if (!Array.isArray(result.shots) || result.shots.length === 0 || segmentStartMs <= 0) return value;
  const starts = result.shots
    .map((shot) => Number(shot.startMs))
    .filter((start) => Number.isFinite(start));
  if (starts.length === 0) return value;
  const firstStart = Math.min(...starts);
  if (firstStart >= segmentStartMs - 1000) return value;
  const offset = segmentStartMs;
  for (const shot of result.shots) {
    for (const key of ['startMs', 'endMs', 'representativeTimeMs'] as const) {
      const current = Number(shot[key]);
      if (Number.isFinite(current)) shot[key] = current + offset;
    }
  }
  if (result.segment) {
    const start = Number(result.segment.startMs);
    const end = Number(result.segment.endMs);
    if (Number.isFinite(start)) result.segment.startMs = start + offset;
    if (Number.isFinite(end)) result.segment.endMs = end + offset;
  }
  return result;
}

function extractMessageText(content: string | Array<{ type?: string; text?: string }> | undefined): string {
  if (typeof content === 'string') return content.trim();
  if (Array.isArray(content)) {
    return content
      .map((item) => (item.type === 'text' ? item.text ?? '' : ''))
      .join('')
      .trim();
  }
  return '';
}

function stripCodeFence(text: string): string {
  const trimmed = text.trim();
  const match = /^```(?:json)?\s*([\s\S]*?)\s*```$/iu.exec(trimmed);
  return match ? match[1].trim() : trimmed;
}

function combinedSignal(signal: AbortSignal, timeoutMs: number): AbortSignal {
  const timeout = AbortSignal.timeout(Math.max(1, timeoutMs));
  if (typeof AbortSignal.any === 'function') return AbortSignal.any([signal, timeout]);
  return signal.aborted ? signal : timeout;
}

function describeFetchError(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const cause = (error as Error & { cause?: unknown }).cause;
  if (cause instanceof Error) {
    const code = (cause as Error & { code?: unknown }).code;
    return [error.message, typeof code === 'string' ? code : '', cause.message]
      .filter(Boolean)
      .join(' · ');
  }
  return error.message;
}
