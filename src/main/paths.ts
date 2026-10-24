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

export function resolveStillRoot(): string {
  const envRoot = environmentDataRoot();
  return envRoot ? join(envRoot, 'projects') : resolve(settings().stillDir);
}

export function resolveFrameCacheDir(): string {
  return join(resolveCacheDir(), 'frames');
}

export function resolveProxyCacheDir(): string {
  return join(resolveCacheDir(), 'proxies');
}

export function resolveAudioWaveformCacheDir(): string {
  return join(resolveCacheDir(), 'audio-waveforms');
}

export function resolveDetectFramesDir(projectId: string): string {
  return join(resolveCacheDir(), 'projects', projectId, 'frames', 'detect');
}

export function resolveProjectExportDir(projectId: string): string {
  return join(resolveExportRoot(), projectId, 'exports');
}

export function resolveProjectStillDir(projectId: string): string {
  return join(resolveStillRoot(), projectId, 'stills');
}

export function resolveTermExportDir(): string {
  return join(resolveExportRoot(), 'terms');
}

export function resolveAssetRoots(): string[] {
  return [join(resolveDataRoot(), 'projects'), resolveStillRoot()];
}
