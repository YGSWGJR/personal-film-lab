import { join } from 'node:path';
import { app, BrowserWindow } from 'electron';
import { DataLayer } from '../data/db';
import { ProjectPackageService } from '../data/project-package';
import { IPC } from '../shared/ipc-channels';
import { createMainWindow } from './app';
import { registerAssetProtocol, registerAssetScheme } from './assets/asset-protocol';
import { CaptureService } from './capture/capture-service';
import { registerIpcHandlers } from './ipc';
import { MediaService } from './media/media-service';
import { PlayerService } from './player/player-service';
import { runSmokeTest } from './smoke';

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

function ensureMainWindow(): BrowserWindow {
  if (mainWindow && !mainWindow.isDestroyed()) return mainWindow;

  const win = createMainWindow();
  mainWindow = win;
  playerService = new PlayerService(win);
  mediaService = new MediaService(() => mainWindow);
  captureService =
    dataLayer && mediaService
      ? new CaptureService(dataLayer, mediaService, (still) => {
          if (!win.isDestroyed()) win.webContents.send(IPC.STILL_EVENT_CREATED, still);
        })
      : null;

  win.on('closed', () => {
    if (mainWindow === win) {
      mainWindow = null;
      playerService = null;
      captureService = null;
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
});

app.whenReady().then(() => {
  if (!dataLayer) {
    const dataRoot = process.env['DSH_DATA_ROOT'] ?? join(app.getPath('userData'), 'lapian');
    dataLayer = new DataLayer(dataRoot);
    packageService = new ProjectPackageService(dataLayer);
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
});
