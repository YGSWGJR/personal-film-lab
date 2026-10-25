import { app, BrowserWindow } from 'electron';
import { existsSync, mkdirSync, copyFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { DataLayer } from '../data/db';
import { ProjectPackageService } from '../data/project-package';
import { IPC } from '../shared/ipc-channels';
import type {
  CandidateProject,
  Project,
  Settings,
  SettingsDataRootChangingEvent,
  SettingsMigrationPreview,
  SettingsMigrationResult,
  WorkspaceState,
} from '../shared/types';
import { createMainWindow } from './app';
import { registerAssetProtocol, registerAssetScheme } from './assets/asset-protocol';
import { CaptureService } from './capture/capture-service';
import { importProjectFrom, scanCandidateRoots } from './data/import-service';
import { DetectService } from './detect/detect-service';
import { ExportService } from './export/export-service';
import { registerIpcHandlers } from './ipc';
import { MediaService } from './media/media-service';
import { PlayerService } from './player/player-service';
import { resolveAssetRoots, resolveDataRoot, bindSettingsProvider } from './paths';
import { ScopeService } from './scope/scope-service';
import { SessionService } from './session/session-service';
import { SettingsError, SettingsService } from './settings/settings-service';
import { runSmokeTest } from './smoke';
import { StatsService } from './stats/stats-service';
import { TermTransferService } from './terms/term-transfer-service';

const IS_SMOKE_TEST = process.argv.includes('--smoke-test');

/**
 * S31：把 Electron userData（设置文件 / session / Chromium 缓存）重定向到 G 盘，
 * 避免在 C 盘产生文件。目标目录不可用时回退默认 userData，保证软件可用。
 * 必须在任何 app.getPath('userData') 读取之前调用。
 */
const CUSTOM_USER_DATA = 'G:\\拉片\\软件数据';
const DEFAULT_USER_DATA = app.getPath('userData');
try {
  mkdirSync(CUSTOM_USER_DATA, { recursive: true });
  app.setPath('userData', CUSTOM_USER_DATA);
} catch (error) {
  console.warn(`[userData] 自定义 userData 不可用，回退默认：${(error as Error).message}`);
}
const ACTIVE_USER_DATA = app.getPath('userData');

/** 首次启动时把旧 userData 的 settings.json 迁移到新位置（只迁必要配置，缓存垃圾不迁）。 */
function migrateUserDataSettingsOnce(): void {
  if (DEFAULT_USER_DATA === ACTIVE_USER_DATA) return;
  const newSettings = resolve(ACTIVE_USER_DATA, 'settings.json');
  const oldSettings = resolve(DEFAULT_USER_DATA, 'settings.json');
  if (!existsSync(newSettings) && existsSync(oldSettings)) {
    try {
      mkdirSync(ACTIVE_USER_DATA, { recursive: true });
      copyFileSync(oldSettings, newSettings);
      console.log(`[userData] 已迁移 settings.json 至 ${ACTIVE_USER_DATA}`);
    } catch (error) {
      console.warn(`[userData] settings.json 迁移失败：${(error as Error).message}`);
    }
  }
}
migrateUserDataSettingsOnce();

/**
 * 原生视频子窗口（libmpv 通过 wid 渲染）要显示在网页内容之上，
 * 必须关闭 Chromium 的 DirectComposition；否则会被网页合成层盖住。
 */
app.commandLine.appendSwitch('disable-direct-composition');
registerAssetScheme();

let mainWindow: BrowserWindow | null = null;
let playerService: PlayerService | null = null;
let mediaService: MediaService | null = null;
let dataLayer: DataLayer | null = null;
let packageService: ProjectPackageService | null = null;
let captureService: CaptureService | null = null;
let termTransferService: TermTransferService | null = null;
let exportService: ExportService | null = null;
let detectService: DetectService | null = null;
let scopeService: ScopeService | null = null;
let settingsService: SettingsService | null = null;
let sessionService: SessionService | null = null;
let statsService: StatsService | null = null;
let exitCaptureStarted = false;
let allowWindowClose = false;
let closeCaptureStarted = false;

interface PendingDataRootMigration {
  previousSettings: Settings;
  previousRoot: string;
  targetRoot: string;
  targetLayer: DataLayer;
  candidates: CandidateProject[];
}

let pendingDataRootMigration: PendingDataRootMigration | null = null;

async function captureWorkspaceSession(win: BrowserWindow): Promise<void> {
  if (!sessionService || win.isDestroyed()) return;
  try {
    const state = await win.webContents.executeJavaScript(
      'window.__CAPTURE_WORKSPACE_STATE__?.() ?? null',
    );
    if (state && typeof state === 'object') {
      sessionService.save(state as WorkspaceState);
    }
  } catch (error) {
    console.warn(`[session] 退出时读取工作区状态失败：${(error as Error).message}`);
  }
}

function createWindowDataServices(
  win: BrowserWindow,
  layer: DataLayer,
  media: MediaService,
): {
  capture: CaptureService;
  exportService: ExportService;
  detect: DetectService;
} {
  const capture = new CaptureService(layer, media, (still) => {
    if (!win.isDestroyed()) win.webContents.send(IPC.STILL_EVENT_CREATED, still);
  });
  const exportService = new ExportService(
    layer,
    capture,
    (event) => {
      if (!win.isDestroyed()) win.webContents.send(IPC.EXPORT_EVENT_PROGRESS, event);
    },
    (event) => {
      if (!win.isDestroyed()) win.webContents.send(IPC.EXPORT_EVENT_DONE, event);
    },
  );
  const detect = new DetectService(
    layer,
    media,
    (event) => {
      if (!win.isDestroyed()) win.webContents.send(IPC.DETECT_EVENT_PROGRESS, event);
    },
    (event) => {
      if (!win.isDestroyed()) win.webContents.send(IPC.DETECT_EVENT_DONE, event);
    },
  );
  return { capture, exportService, detect };
}

function rebuildDataServices(): void {
  const nextLayer = new DataLayer(resolveDataRoot());
  const nextPackage = new ProjectPackageService(nextLayer);
  const nextTerms = new TermTransferService(nextLayer, () => mainWindow);
  const nextStats = new StatsService(nextLayer);
  const nextWindowServices =
    mainWindow && mediaService ? createWindowDataServices(mainWindow, nextLayer, mediaService) : null;
  const previousDetect = detectService;
  const previousLayer = dataLayer;

  dataLayer = nextLayer;
  packageService = nextPackage;
  termTransferService = nextTerms;
  statsService = nextStats;
  captureService = nextWindowServices?.capture ?? null;
  exportService = nextWindowServices?.exportService ?? null;
  detectService = nextWindowServices?.detect ?? null;

  previousDetect?.dispose();
  previousLayer?.close();
}

function requirePendingMigration(): PendingDataRootMigration {
  const pending = pendingDataRootMigration;
  if (!pending) {
    throw new SettingsError('SETTINGS_MIGRATION_NOT_PENDING', '没有待确认的数据目录迁移');
  }
  return pending;
}

function previewDataRootMigration(): SettingsMigrationPreview {
  const pending = requirePendingMigration();
  return { root: pending.previousRoot, projects: pending.candidates };
}

function confirmDataRootMigration(projectIds: string[]): SettingsMigrationResult {
  const pending = requirePendingMigration();
  const requested = [...new Set(projectIds)];
  const available = new Set(pending.candidates.map((project) => project.id));
  const unknown = requested.filter((projectId) => !available.has(projectId));
  if (unknown.length > 0) {
    throw new SettingsError('SETTINGS_MIGRATION_INVALID_SELECTION', '迁移列表中不存在所选项目', {
      projectIds: unknown,
    });
  }

  const imported: Project[] = [];
  const skipped: string[] = [];
  for (const projectId of requested) {
    const result = importProjectFrom(
      pending.targetLayer,
      pending.previousRoot,
      projectId,
      [pending.previousSettings.stillSubDir ?? pending.previousSettings.stillDir],
    );
    if (result.imported) imported.push(result.project);
    else skipped.push(projectId);
  }

  pending.targetLayer.close();
  pendingDataRootMigration = null;
  rebuildDataServices();
  return { imported, skipped };
}

function skipDataRootMigration(): Settings {
  const pending = requirePendingMigration();
  pending.targetLayer.close();
  pendingDataRootMigration = null;
  rebuildDataServices();
  return settingsService!.get();
}

function cancelDataRootMigration(): Settings {
  const pending = requirePendingMigration();
  const restored = settingsService!.restore(pending.previousSettings);
  pending.targetLayer.close();
  pendingDataRootMigration = null;
  return restored;
}

function handleDataRootChange(next: Settings, previous: Settings): void {
  if (pendingDataRootMigration) {
    throw new SettingsError(
      'SETTINGS_MIGRATION_ALREADY_PENDING',
      '上一次数据目录更改尚未处理，请先完成或取消迁移',
    );
  }
  const previousRoot = resolve(previous.dataRoot);
  const targetRoot = resolve(next.dataRoot);
  const targetLayer = new DataLayer(targetRoot);
  try {
    const source = scanCandidateRoots(targetLayer, [previousRoot]).find(
      (item) => resolve(item.root) === previousRoot,
    );
    const candidates = source?.projects ?? [];
    const event: SettingsDataRootChangingEvent = {
      previousRoot,
      nextRoot: targetRoot,
      projectCount: candidates.length,
    };

    if (candidates.length === 0) {
      targetLayer.close();
      rebuildDataServices();
      mainWindow?.webContents.send(IPC.SETTINGS_DATA_ROOT_CHANGING, event);
      return;
    }

    if (!mainWindow || mainWindow.isDestroyed()) {
      throw new SettingsError('WINDOW_UNAVAILABLE', '主窗口尚未就绪，无法确认数据迁移');
    }
    pendingDataRootMigration = {
      previousSettings: previous,
      previousRoot,
      targetRoot,
      targetLayer,
      candidates,
    };
    mainWindow.webContents.send(IPC.SETTINGS_DATA_ROOT_CHANGING, event);
  } catch (error) {
    if (pendingDataRootMigration?.targetLayer === targetLayer) {
      pendingDataRootMigration = null;
    }
    targetLayer.close();
    throw error;
  }
}

function restorePendingMigrationOnShutdown(): void {
  const pending = pendingDataRootMigration;
  if (!pending) return;
  pending.targetLayer.close();
  pendingDataRootMigration = null;
  try {
    settingsService?.restore(pending.previousSettings);
  } catch (error) {
    console.warn(`[settings] 退出时恢复待迁移目录失败：${(error as Error).message}`);
  }
}

function ensureMainWindow(): BrowserWindow {
  if (mainWindow && !mainWindow.isDestroyed()) return mainWindow;

  const win = createMainWindow();
  mainWindow = win;
  playerService = new PlayerService(win);
  mediaService = new MediaService(() => mainWindow);
  scopeService = new ScopeService();
  allowWindowClose = false;
  closeCaptureStarted = false;
  const windowServices = dataLayer ? createWindowDataServices(win, dataLayer, mediaService) : null;
  captureService = windowServices?.capture ?? null;
  exportService = windowServices?.exportService ?? null;
  detectService = windowServices?.detect ?? null;

  win.on('close', (event) => {
    if (allowWindowClose || !sessionService || win.isDestroyed()) return;
    event.preventDefault();
    if (closeCaptureStarted) return;
    closeCaptureStarted = true;
    void captureWorkspaceSession(win).finally(() => {
      allowWindowClose = true;
      win.close();
    });
  });

  win.on('closed', () => {
    if (mainWindow === win) {
      mainWindow = null;
      playerService = null;
      captureService = null;
      exportService = null;
      detectService?.dispose();
      detectService = null;
      scopeService?.dispose();
      scopeService = null;
      mediaService?.dispose();
      mediaService = null;
    }
  });

  return win;
}

registerIpcHandlers({
  getWindow: () => mainWindow,
  getPlayer: () => playerService,
  getMedia: () => mediaService,
  getData: () => dataLayer,
  getPackage: () => packageService,
  getCapture: () => captureService,
  getTermTransfer: () => termTransferService,
  getExport: () => exportService,
  getDetect: () => detectService,
  getScope: () => scopeService,
  getSettings: () => settingsService,
  previewSettingsMigration: () => previewDataRootMigration(),
  confirmSettingsMigration: (projectIds) => confirmDataRootMigration(projectIds),
  skipSettingsMigration: () => skipDataRootMigration(),
  cancelSettingsMigration: () => cancelDataRootMigration(),
  getSession: () => sessionService,
  getStats: () => statsService,
});

app.whenReady().then(() => {
  sessionService = new SessionService();
  settingsService = new SettingsService(
    () => mainWindow,
    (next, previous) => {
      if (next.dataRoot !== previous.dataRoot) handleDataRootChange(next, previous);
    },
  );
  bindSettingsProvider(() => settingsService!.get());

  if (!dataLayer) {
    dataLayer = new DataLayer(resolveDataRoot());
    packageService = new ProjectPackageService(dataLayer);
    termTransferService = new TermTransferService(dataLayer, () => mainWindow);
    statsService = new StatsService(dataLayer);
  }

  registerAssetProtocol(() => resolveAssetRoots());
  const win = ensureMainWindow();

  if (IS_SMOKE_TEST) {
    void runSmokeTest(win, { getPlayer: () => playerService });
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      ensureMainWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

function cleanupServices(): void {
  restorePendingMigrationOnShutdown();
  dataLayer?.close();
  dataLayer = null;
  packageService = null;
  captureService = null;
  termTransferService = null;
  exportService = null;
  detectService?.dispose();
  detectService = null;
  scopeService?.dispose();
  scopeService = null;
  settingsService = null;
  sessionService?.flush();
  sessionService = null;
  statsService = null;
}

app.on('before-quit', (event) => {
  const win = mainWindow;
  if (!exitCaptureStarted && sessionService && win && !win.isDestroyed()) {
    exitCaptureStarted = true;
    event.preventDefault();
    void captureWorkspaceSession(win)
      .finally(() => {
        allowWindowClose = true;
        cleanupServices();
        app.quit();
      });
    return;
  }
  cleanupServices();
});
