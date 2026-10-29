import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { app, dialog, type BrowserWindow } from 'electron';
import { settingsSetArgsSchema } from '../../shared/schemas';
import type {
  Settings,
  SettingsChooseDirectoryArgs,
  SettingsSetArgs,
} from '../../shared/types';
import { defaultSettings, environmentDataRoot } from '../paths';

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
    const normalized = normalizeSettings(args);
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
      stored.proxyTier === expected.proxyTier
    );
  } catch {
    return false;
  }
}

function normalizeSettings(args: SettingsSetArgs): SettingsSetArgs {
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
  };
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
