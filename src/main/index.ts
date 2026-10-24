import { app, BrowserWindow } from 'electron';
import { DataLayer } from '../data/db';
import { ProjectPackageService } from '../data/project-package';
import { IPC } from '../shared/ipc-channels';
import type { WorkspaceState } from '../shared/types';
import { createMainWindow } from './app';
import { registerAssetProtocol, registerAssetScheme } from './assets/asset-protocol';
import { CaptureService } from './capture/capture-service';
import { DetectService } from './detect/detect-service';
import { ExportService } from './export/export-service';
import { registerIpcHandlers } from './ipc';
import { MediaService } from './media/media-service';
import { PlayerService } from './player/player-service';
import { resolveAssetRoots, resolveDataRoot, bindSettingsProvider } from './paths';
import { ScopeService } from './scope/scope-service';
import { SessionService } from './session/session-service';
import { SettingsService } from './settings/settings-service';
import { runSmokeTest } from './smoke';
import { TermTransferService } from './terms/term-transfer-service';

const IS_SMOKE_TEST = process.argv.includes('--smoke-test');

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
let exitCaptureStarted = false;
let allowWindowClose = false;
let closeCaptureStarted = false;

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
  const nextWindowServices =
    mainWindow && mediaService ? createWindowDataServices(mainWindow, nextLayer, mediaService) : null;
  const previousDetect = detectService;
  const previousLayer = dataLayer;

  dataLayer = nextLayer;
  packageService = nextPackage;
  termTransferService = nextTerms;
  captureService = nextWindowServices?.capture ?? null;
  exportService = nextWindowServices?.exportService ?? null;
  detectService = nextWindowServices?.detect ?? null;

  previousDetect?.dispose();
  previousLayer?.close();
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
  getSession: () => sessionService,
});

app.whenReady().then(() => {
  sessionService = new SessionService();
  settingsService = new SettingsService(
    () => mainWindow,
    (next, previous) => {
      if (next.dataRoot !== previous.dataRoot) rebuildDataServices();
    },
  );
  bindSettingsProvider(() => settingsService!.get());

  if (!dataLayer) {
    dataLayer = new DataLayer(resolveDataRoot());
    packageService = new ProjectPackageService(dataLayer);
    termTransferService = new TermTransferService(dataLayer, () => mainWindow);
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
