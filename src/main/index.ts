import { join } from 'node:path';
import { app, BrowserWindow } from 'electron';
import { DataLayer } from '../data/db';
import { ProjectPackageService } from '../data/project-package';
import { IPC } from '../shared/ipc-channels';
import { createMainWindow } from './app';
import { registerAssetProtocol, registerAssetScheme } from './assets/asset-protocol';
import { CaptureService } from './capture/capture-service';
import { DetectService } from './detect/detect-service';
import { ExportService } from './export/export-service';
import { registerIpcHandlers } from './ipc';
import { MediaService } from './media/media-service';
import { PlayerService } from './player/player-service';
import { ScopeService } from './scope/scope-service';
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

function ensureMainWindow(): BrowserWindow {
  if (mainWindow && !mainWindow.isDestroyed()) return mainWindow;

  const win = createMainWindow();
  mainWindow = win;
  playerService = new PlayerService(win);
  mediaService = new MediaService(() => mainWindow);
  scopeService = new ScopeService();
  captureService =
    dataLayer && mediaService
      ? new CaptureService(dataLayer, mediaService, (still) => {
          if (!win.isDestroyed()) win.webContents.send(IPC.STILL_EVENT_CREATED, still);
        })
      : null;
  exportService =
    dataLayer && captureService
      ? new ExportService(
          dataLayer,
          captureService,
          (event) => {
            if (!win.isDestroyed()) win.webContents.send(IPC.EXPORT_EVENT_PROGRESS, event);
          },
          (event) => {
            if (!win.isDestroyed()) win.webContents.send(IPC.EXPORT_EVENT_DONE, event);
          },
        )
      : null;
  detectService =
    dataLayer && mediaService
      ? new DetectService(
          dataLayer,
          mediaService,
          (event) => {
            if (!win.isDestroyed()) win.webContents.send(IPC.DETECT_EVENT_PROGRESS, event);
          },
          (event) => {
            if (!win.isDestroyed()) win.webContents.send(IPC.DETECT_EVENT_DONE, event);
          },
        )
      : null;

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
});

app.whenReady().then(() => {
  if (!dataLayer) {
    const dataRoot = process.env['DSH_DATA_ROOT'] ?? join(app.getPath('userData'), 'lapian');
    dataLayer = new DataLayer(dataRoot);
    packageService = new ProjectPackageService(dataLayer);
    termTransferService = new TermTransferService(dataLayer, () => mainWindow);
  }

  registerAssetProtocol(dataLayer.dataRoot);
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

app.on('before-quit', () => {
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
});
