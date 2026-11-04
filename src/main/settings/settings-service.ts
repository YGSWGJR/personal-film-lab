import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { app, dialog, type BrowserWindow } from 'electron';
import { settingsSetArgsSchema } from '../../shared/schemas';
import type {
  AiProviderConfig,
  AiSettings,
  RecognitionSettings,
  Settings,
  SettingsChooseDirectoryArgs,
  SettingsSetArgs,
  TimelineSettings,
} from '../../shared/types';
import {
  PX_PER_SEC_LEVELS,
  TRACK_HEIGHT_LEVELS,
  snapToLevel,
} from '../../shared/types';
import {
  defaultAiSettings,
  defaultRecognitionSettings,
  defaultSettings,
  defaultTimelineSettings,
  environmentDataRoot,
} from '../paths';
import { encryptApiKey } from '../ai/credential-store';

const SETTINGS_PATH_FIELDS = [
  'dataRoot',
  'cacheDir',
  'exportDir',
  'stillDir',
  'proxyCacheDir',
  'frameCacheDir',
  'waveformCacheDir',
  'thumbCacheDir',
  'exportSubDir',
  'stillSubDir',
] as const satisfies ReadonlyArray<keyof SettingsSetArgs>;

export class SettingsError extends Error {
  readonly code: string;
  readonly details?: Record<string, unknown>;

  constructor(code: string, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = 'SettingsError';
    this.code = code;
    this.details = details;
  }
}

export class SettingsService {
  private readonly settingsPath: string;
  private stored: SettingsSetArgs | null;

  constructor(
    private readonly getWindow: () => BrowserWindow | null,
    private readonly onChange?: (next: Settings, previous: Settings) => void,
    private readonly beforeVerify?: (settingsPath: string) => void,
  ) {
    this.settingsPath = join(app.getPath('userData'), 'settings.json');
    this.stored = this.loadStored();
  }

  get(): Settings {
    const envRoot = environmentDataRoot();
    if (envRoot) {
      return {
        dataRoot: envRoot,
        cacheDir: envRoot,
        exportDir: join(envRoot, 'projects'),
        stillDir: join(envRoot, 'projects'),
        proxyTier: '540p',
        confirmUserContent: this.stored?.confirmUserContent ?? true,
        timeline: this.stored?.timeline ?? defaultTimelineSettings(),
        recognition: this.stored?.recognition ?? defaultRecognitionSettings(),
        ai: this.stored?.ai ?? defaultAiSettings(),
        settingsPath: this.settingsPath,
        environmentOverride: true,
      };
    }
    return {
      ...(this.stored ?? defaultSettings()),
      settingsPath: this.settingsPath,
      environmentOverride: false,
    };
  }

  set(args: SettingsSetArgs): Settings {
    if (environmentDataRoot()) {
      throw new SettingsError(
        'SETTINGS_ENV_LOCKED',
        'DSH_DATA_ROOT 环境变量正在覆盖路径设置，请移除该变量后重启应用。',
      );
    }
    const current = this.get();
    // 设置面板可能只提交部分键（如仅路径）；用当前已存值兜底，
    // 避免保存设置时把 timeline / recognition / ai 重置为默认。
    const normalized = normalizeSettings(args, this.stored ?? undefined, true);
    for (const key of SETTINGS_PATH_FIELDS) {
      const path = normalized[key];
      if (path) mkdirSync(path, { recursive: true });
    }

    const previousStored = this.stored;
    const next: Settings = {
      ...normalized,
      settingsPath: this.settingsPath,
      environmentOverride: false,
    };
    this.stored = normalized;
    try {
      this.writeStored(normalized);
      this.beforeVerify?.(this.settingsPath);
      if (!verifyStoredSettings(this.settingsPath, normalized)) {
        throw new SettingsError('SETTINGS_VERIFY_FAILED', '设置写入后校验不一致，请重试', {
          settingsPath: this.settingsPath,
        });
      }
      this.onChange?.(next, current);
    } catch (error) {
      this.stored = previousStored;
      try {
        if (previousStored) this.writeStored(previousStored);
        else rmSync(this.settingsPath, { force: true });
      } catch {
        // 保留原始失败
      }
      throw error;
    }
    return next;
  }

  /** 恢复已确认的旧设置，不触发目录切换回调（用于取消待确认迁移）。 */
  restore(settings: Settings): Settings {
    if (environmentDataRoot()) {
      throw new SettingsError(
        'SETTINGS_ENV_LOCKED',
        'DSH_DATA_ROOT 环境变量正在覆盖路径设置，无法恢复目录设置。',
      );
    }
    const normalized = normalizeSettings(settings);
    const previousStored = this.stored;
    this.stored = normalized;
    try {
      this.writeStored(normalized);
    } catch (error) {
      this.stored = previousStored;
      throw error;
    }
    return this.get();
  }

  async chooseDirectory(args: SettingsChooseDirectoryArgs): Promise<string | null> {
    const win = this.getWindow();
    if (!win) throw new SettingsError('WINDOW_UNAVAILABLE', '主窗口尚未就绪');
    const result = await dialog.showOpenDialog(win, {
      title: args.title ?? '选择目录',
      defaultPath: args.defaultPath,
      properties: ['openDirectory', 'createDirectory'],
    });
    return result.canceled ? null : result.filePaths[0] ?? null;
  }

  private loadStored(): SettingsSetArgs | null {
    try {
      const parsed = JSON.parse(readFileSync(this.settingsPath, 'utf8')) as unknown;
      const result = settingsSetArgsSchema.safeParse(parsed);
      return result.success ? normalizeSettings(result.data) : null;
    } catch {
      return null;
    }
  }

  private writeStored(settings: SettingsSetArgs): void {
    mkdirSync(dirname(this.settingsPath), { recursive: true });
    writeFileSync(this.settingsPath, `${JSON.stringify(settings, null, 2)}\n`, 'utf8');
  }
}

export function verifyStoredSettings(
  settingsPath: string,
  expected: SettingsSetArgs,
): boolean {
  try {
    const parsed = settingsSetArgsSchema.safeParse(
      JSON.parse(readFileSync(settingsPath, 'utf8')) as unknown,
    );
    if (!parsed.success) return false;
    const stored = normalizeSettings(parsed.data);
    return (
      SETTINGS_PATH_FIELDS.every((key) => stored[key] === expected[key]) &&
      stored.proxyTier === expected.proxyTier &&
      stored.confirmUserContent === expected.confirmUserContent &&
      stored.timeline?.trackHeight === expected.timeline?.trackHeight &&
      stored.timeline?.pxPerSecond === expected.timeline?.pxPerSecond &&
      stored.recognition?.engine === expected.recognition?.engine &&
      stored.ai?.provider === expected.ai?.provider &&
      stored.ai?.activeProviderId === expected.ai?.activeProviderId &&
      JSON.stringify(stored.ai?.providers ?? []) === JSON.stringify(expected.ai?.providers ?? []) &&
      stored.ai?.baseUrl === expected.ai?.baseUrl &&
      stored.ai?.apiKey === expected.ai?.apiKey &&
      stored.ai?.agentEndpoint === expected.ai?.agentEndpoint &&
      stored.ai?.segmentSeconds === expected.ai?.segmentSeconds &&
      stored.ai?.segmentOverlapSeconds === expected.ai?.segmentOverlapSeconds &&
      stored.ai?.timeoutSeconds === expected.ai?.timeoutSeconds &&
      stored.ai?.maxRetriesPerSegment === expected.ai?.maxRetriesPerSegment &&
      stored.ai?.enabled === expected.ai?.enabled
    );
  } catch {
    return false;
  }
}

function normalizeSettings(
  args: SettingsSetArgs,
  fallback?: SettingsSetArgs,
  forWrite = false,
): SettingsSetArgs {
  return {
    dataRoot: normalizePath(args.dataRoot),
    cacheDir: normalizePath(args.cacheDir),
    exportDir: normalizePath(args.exportDir),
    stillDir: normalizePath(args.stillDir),
    proxyCacheDir: normalizeOptionalPath(args.proxyCacheDir),
    frameCacheDir: normalizeOptionalPath(args.frameCacheDir),
    waveformCacheDir: normalizeOptionalPath(args.waveformCacheDir),
    thumbCacheDir: normalizeOptionalPath(args.thumbCacheDir),
    exportSubDir: normalizeOptionalPath(args.exportSubDir),
    stillSubDir: normalizeOptionalPath(args.stillSubDir),
    proxyTier: args.proxyTier ?? '540p',
    confirmUserContent: args.confirmUserContent ?? true,
    timeline: normalizeTimeline(args.timeline ?? fallback?.timeline),
    recognition: normalizeRecognition(args.recognition ?? fallback?.recognition),
    ai: normalizeAi(args.ai, fallback?.ai, forWrite),
  };
}

function normalizeTimeline(value: TimelineSettings | undefined): TimelineSettings {
  const source = value ?? defaultTimelineSettings();
  const trackHeight = Number.isFinite(source.trackHeight) && source.trackHeight > 0
    ? snapToLevel(source.trackHeight, TRACK_HEIGHT_LEVELS)
    : defaultTimelineSettings().trackHeight;
  const pxPerSecond = Number.isFinite(source.pxPerSecond) && source.pxPerSecond > 0
    ? snapToLevel(source.pxPerSecond, PX_PER_SEC_LEVELS)
    : defaultTimelineSettings().pxPerSecond;
  return { trackHeight, pxPerSecond };
}

function normalizeRecognition(value: RecognitionSettings | undefined): RecognitionSettings {
  return { engine: value?.engine === 'opencv' ? 'opencv' : 'ai' };
}

/**
 * 读取时把旧扁平配置迁移为 legacy provider（纯函数，不写回；smoke 复用）。
 */
export function migrateLegacyAiSettings(value: AiSettings | undefined): AiSettings {
  return normalizeAi(value, undefined, false);
}

function normalizeAi(
  value: AiSettings | undefined,
  fallback: AiSettings | undefined,
  forWrite = false,
): AiSettings {
  const defaults = defaultAiSettings();
  const fallbackProviders = fallback?.providers ?? [];
  const hasProvidersField = Array.isArray(value?.providers);
  const providers = hasProvidersField
    ? normalizeProviders(value?.providers ?? [], fallbackProviders)
    : normalizeProviders(fallbackProviders, []);
  const legacyBaseUrl = (value?.baseUrl ?? fallback?.baseUrl ?? defaults.baseUrl ?? '').trim();
  // 显式传入 apiKey（含空串）= 覆盖/清除；未传 apiKey = 保留已存值。
  const keyProvided = value !== undefined && Object.prototype.hasOwnProperty.call(value, 'apiKey');
  const keySource = keyProvided
    ? typeof value?.apiKey === 'string'
      ? value.apiKey
      : ''
    : fallback?.apiKey ?? defaults.apiKey ?? '';
  const legacyKey = encryptApiKey(keySource);
  const migratedProviders =
    !hasProvidersField && providers.length === 0 && (legacyBaseUrl || legacyKey)
      ? [
          {
            id: 'legacy',
            name: '默认供应商',
            note: '由旧配置自动迁移',
            baseUrl: legacyBaseUrl,
            apiKey: legacyKey,
            models: [],
          } satisfies AiProviderConfig,
        ]
      : providers;
  const activeCandidate = value?.activeProviderId ?? fallback?.activeProviderId ?? '';
  const activeProviderId = migratedProviders.some((item) => item.id === activeCandidate)
    ? activeCandidate
    : migratedProviders[0]?.id ?? '';
  const clearLegacy = forWrite && migratedProviders.length > 0;
  return {
    provider:
      value?.provider === 'mock' || fallback?.provider === 'mock'
        ? 'mock'
        : 'openai-compatible',
    providers: migratedProviders,
    activeProviderId,
    baseUrl: clearLegacy ? '' : legacyBaseUrl,
    // 落盘前加密（已加密则幂等保留）；settings.json 不得出现明文 Key。
    apiKey: clearLegacy ? '' : legacyKey,
    agentEndpoint: (value?.agentEndpoint ?? fallback?.agentEndpoint ?? defaults.agentEndpoint ?? '').trim(),
    segmentSeconds: clampInt(value?.segmentSeconds ?? fallback?.segmentSeconds, 600, 30, 3600),
    segmentOverlapSeconds: clampInt(
      value?.segmentOverlapSeconds ?? fallback?.segmentOverlapSeconds,
      30,
      0,
      300,
    ),
    timeoutSeconds: clampInt(value?.timeoutSeconds ?? fallback?.timeoutSeconds, 900, 30, 7200),
    maxRetriesPerSegment: clampInt(
      value?.maxRetriesPerSegment ?? fallback?.maxRetriesPerSegment,
      3,
      0,
      10,
    ),
    enabled: value?.enabled ?? fallback?.enabled ?? true,
  };
}

function normalizeProviders(
  list: AiProviderConfig[],
  fallbackList: AiProviderConfig[],
): AiProviderConfig[] {
  const fallbackById = new Map(fallbackList.map((item) => [item.id, item]));
  const seen = new Set<string>();
  const result: AiProviderConfig[] = [];
  for (const raw of list) {
    if (!raw || typeof raw !== 'object') continue;
    const id = String(raw.id ?? '').trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const fallback = fallbackById.get(id);
    const keyProvided = Object.prototype.hasOwnProperty.call(raw, 'apiKey');
    const keySource = keyProvided ? raw.apiKey : fallback?.apiKey;
    const key = keySource && String(keySource).trim() ? String(keySource) : '';
    const modelsSource = raw.models !== undefined ? raw.models : fallback?.models ?? [];
    const models = [...new Set(modelsSource.map((item) => String(item).trim()).filter(Boolean))];
    const model = String(raw.model ?? fallback?.model ?? '').trim();
    const note = String(raw.note ?? fallback?.note ?? '').trim();
    const homeUrl = String(raw.homeUrl ?? fallback?.homeUrl ?? '').trim();
    result.push({
      id,
      name: String(raw.name ?? fallback?.name ?? '').trim() || '未命名供应商',
      ...(note ? { note } : {}),
      ...(homeUrl ? { homeUrl } : {}),
      baseUrl: String(raw.baseUrl ?? '').trim(),
      ...(key ? { apiKey: encryptApiKey(key) } : {}),
      ...(model ? { model } : {}),
      models,
    });
  }
  return result;
}

function clampInt(value: number | undefined, fallback: number, min: number, max: number): number {
  const number = Number(value ?? fallback);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, Math.round(number)));
}

function normalizeOptionalPath(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? normalizePath(trimmed) : undefined;
}

function normalizePath(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new SettingsError('SETTINGS_PATH_EMPTY', '路径不能为空');
  return isAbsolute(trimmed) ? resolve(trimmed) : resolve(trimmed);
}
