import { app, BrowserWindow } from 'electron';
import { createMainWindow } from './app';
import { registerIpcHandlers } from './ipc';
import { runSmokeTest } from './smoke';

const IS_SMOKE_TEST = process.argv.includes('--smoke-test');

registerIpcHandlers();

app.whenReady().then(() => {
  const win = createMainWindow();

  if (IS_SMOKE_TEST) {
    void runSmokeTest(win);
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});