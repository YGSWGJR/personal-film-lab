import { app, BrowserWindow } from 'electron';
import { createMainWindow } from './app';
import { registerIpcHandlers } from './ipc';
import { PlayerService } from './player/player-service';
import { runSmokeTest } from './smoke';

const IS_SMOKE_TEST = process.argv.includes('--smoke-test');

/**
 * 原生视频子窗口（libmpv 通过 wid 渲染）要显示在网页内容之上，
 * 必须关闭 Chromium 的 DirectComposition；否则会被网页合成层盖住。
 */
app.commandLine.appendSwitch('disable-direct-composition');

let mainWindow: BrowserWindow | null = null;
let playerService: PlayerService | null = null;

function ensureMainWindow(): BrowserWindow {
  if (mainWindow && !mainWindow.isDestroyed()) return mainWindow;

  const win = createMainWindow();
  mainWindow = win;
  playerService = new PlayerService(win);

  win.on('closed', () => {
    if (mainWindow === win) {
      mainWindow = null;
      playerService = null;
    }
  });

  return win;
}

registerIpcHandlers({
  getWindow: () => mainWindow,
  getPlayer: () => playerService,
});

app.whenReady().then(() => {
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