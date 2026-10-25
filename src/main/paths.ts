import { app } from 'electron';
import { join, resolve } from 'node:path';
import type { Settings, SettingsSetArgs } from '../shared/types';

let settingsProvider: (() => Settings) | null = null;

export function bindSettingsProvider(provider: () => Settings): void {
  settingsProvider = provider;
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
