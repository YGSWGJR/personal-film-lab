import { app } from 'electron';
import { join, resolve } from 'node:path';
import type {
  AiSettings,
  RecognitionSettings,
  Settings,
  SettingsSetArgs,
  ShortcutSettings,
  TimelineSettings,
} from '../shared/types';

let settingsProvider: (() => Settings) | null = null;

export function bindSettingsProvider(provider: () => Settings): void {
  settingsProvider = provider;
}

/** 时间线轨道缩放默认档（S36-3）：轨高 96px / 密度 96px/s。 */
export function defaultTimelineSettings(): TimelineSettings {
  return { trackHeight: 96, pxPerSecond: 96 };
}

/** S36-2：默认识别引擎 = AI（OpenCV 仅隐藏开关）。 */
export function defaultRecognitionSettings(): RecognitionSettings {
  return { engine: 'ai' };
}

export function defaultShortcutSettings(): ShortcutSettings {
  return { split: 'Ctrl+K', merge: 'Ctrl+Shift+G' };
}

/** S36-2：AI 识别默认参数。apiKey 为空时由凭据存储加密写入。 */
export function defaultAiSettings(): AiSettings {
  return {
    provider: 'local',
    providers: [],
    activeProviderId: '',
    baseUrl: '',
    apiKey: '',
    agentEndpoint: '',
    segmentSeconds: 600,
    segmentOverlapSeconds: 30,
    timeoutSeconds: 900,
    maxRetriesPerSegment: 3,
    enabled: true,
    fallbackToOpenCv: true,
    localBatchSize: 4,
  };
}

export function defaultSettings(): SettingsSetArgs {
  const dataRoot = join(app.getPath('userData'), 'lapian');
  return {
    dataRoot,
    cacheDir: dataRoot,
    exportDir: join(dataRoot, 'projects'),
    stillDir: join(dataRoot, 'projects'),
    proxyCacheDir: undefined,
    frameCacheDir: undefined,
    waveformCacheDir: undefined,
    thumbCacheDir: undefined,
    exportSubDir: undefined,
    stillSubDir: undefined,
    proxyTier: '540p',
    confirmUserContent: true,
    timeline: defaultTimelineSettings(),
    recognition: defaultRecognitionSettings(),
    ai: defaultAiSettings(),
    shortcuts: defaultShortcutSettings(),
  };
}

function settings(): Settings {
  if (settingsProvider) return settingsProvider();
  return { ...defaultSettings(), environmentOverride: false };
}

export function environmentDataRoot(): string | null {
  const configured = process.env['DSH_DATA_ROOT']?.trim();
  return configured ? resolve(configured) : null;
}

export function resolveCandidateDataRoots(): string[] {
  const roots = [resolveDataRoot(), join(app.getPath('userData'), 'lapian')];
  return [...new Set(roots.map((root) => resolve(root)))];
}

export function resolveDataRoot(): string {
  return environmentDataRoot() ?? resolve(settings().dataRoot);
}

export function resolveCacheDir(): string {
  return environmentDataRoot() ?? resolve(settings().cacheDir);
}

export function resolveExportRoot(): string {
  const envRoot = environmentDataRoot();
  return envRoot ? join(envRoot, 'projects') : resolve(settings().exportDir);
}

export function resolveExportSubDir(): string {
  const envRoot = environmentDataRoot();
  if (envRoot) return join(envRoot, 'projects');
  const current = settings();
  return resolve(current.exportSubDir ?? current.exportDir);
}

export function resolveStillRoot(): string {
  const envRoot = environmentDataRoot();
  return envRoot ? join(envRoot, 'projects') : resolve(settings().stillDir);
}

export function resolveStillSubDir(): string {
  const envRoot = environmentDataRoot();
  if (envRoot) return join(envRoot, 'projects');
  const current = settings();
  return resolve(current.stillSubDir ?? current.stillDir);
}

export function resolveFrameCacheDir(): string {
  const current = settings();
  return environmentDataRoot()
    ? join(resolveCacheDir(), 'frames')
    : resolve(current.frameCacheDir ?? join(resolveCacheDir(), 'frames'));
}

export function resolveProxyCacheDir(): string {
  const current = settings();
  return environmentDataRoot()
    ? join(resolveCacheDir(), 'proxies')
    : resolve(current.proxyCacheDir ?? join(resolveCacheDir(), 'proxies'));
}

export function resolveAudioWaveformCacheDir(): string {
  const current = settings();
  return environmentDataRoot()
    ? join(resolveCacheDir(), 'audio-waveforms')
    : resolve(current.waveformCacheDir ?? join(resolveCacheDir(), 'audio-waveforms'));
}

export function resolveThumbCacheDir(): string {
  const current = settings();
  return environmentDataRoot()
    ? join(resolveFrameCacheDir(), 'thumbs')
    : resolve(current.thumbCacheDir ?? join(resolveFrameCacheDir(), 'thumbs'));
}

export function resolveDetectFramesDir(projectId: string): string {
  return join(resolveCacheDir(), 'projects', projectId, 'frames', 'detect');
}

export function resolveProjectExportDir(projectId: string): string {
  return join(resolveExportSubDir(), projectId, 'exports');
}

export function resolveProjectStillDir(projectId: string): string {
  return join(resolveStillSubDir(), projectId, 'stills');
}

export function resolveTermExportDir(): string {
  return join(resolveExportSubDir(), 'terms');
}

export function resolveAssetRoots(): string[] {
  return [
    ...new Set([
      resolve(join(resolveDataRoot(), 'projects')),
      resolveStillRoot(),
      resolveStillSubDir(),
    ]),
  ];
}
