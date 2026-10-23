import { app, ipcMain } from 'electron';
import { IPC } from '../../shared/ipc-channels';
import { withEnvelope } from '../../shared/ipc-result';
import type { AppInfo } from '../../shared/types';

/**
 * IPC 注册器（docs/S01 §4 / §6.2）。
 * 所有 handler 经 withEnvelope 统一返回 IpcResult 信封。
 * 新增通道：先在 shared/ipc-channels.ts 与 S01 §6 登记，再在此注册。
 */
export function registerIpcHandlers(): void {
  ipcMain.handle(
    IPC.APP_INFO,
    withEnvelope((): AppInfo => ({
      version: app.getVersion(),
      platform: process.platform,
      appDataPath: app.getPath('userData'),
    })),
  );
}