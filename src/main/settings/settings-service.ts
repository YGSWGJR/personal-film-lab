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
        environmentOverride: true,
      };
    }
    return {
      ...(this.stored ?? defaultSettings()),
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
    for (const path of Object.values(normalized)) {
      mkdirSync(path, { recursive: true });
    }

    const previousStored = this.stored;
    const next: Settings = { ...normalized, environmentOverride: false };
    this.stored = normalized;
    try {
      this.writeStored(normalized);
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

function normalizeSettings(args: SettingsSetArgs): SettingsSetArgs {
  return {
    dataRoot: normalizePath(args.dataRoot),
    cacheDir: normalizePath(args.cacheDir),
    exportDir: normalizePath(args.exportDir),
    stillDir: normalizePath(args.stillDir),
  };
}

function normalizePath(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new SettingsError('SETTINGS_PATH_EMPTY', '路径不能为空');
  return isAbsolute(trimmed) ? resolve(trimmed) : resolve(trimmed);
}
