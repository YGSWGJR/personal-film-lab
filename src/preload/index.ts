import { contextBridge, ipcRenderer } from 'electron';
import type { ZodType } from 'zod';
import { IPC } from '../shared/ipc-channels';
import { fail } from '../shared/ipc-result';
import { appInfoArgsSchema } from '../shared/schemas';
import type { AppInfo, IpcResult, WindowApi } from '../shared/types';

/**
 * preload：渲染层与主进程之间唯一的桥（docs/S01 §1.3 / §3.2）。
 *
 * - contextIsolation: true，渲染层拿不到 ipcRenderer / require；
 * - sandbox: true，本文件只能使用 electron 内置模块（zod 等已打进产物）；
 * - 仅暴露白名单方法，禁止 send(channel, ...) 这类通用透传；
 * - 入参先经 shared/schemas.ts 校验，非法载荷直接拒绝。
 */

/** 白名单：通道 → 入参校验 schema；未登记的通道不会转发 */
const INVOKE_WHITELIST: Record<string, ZodType> = {
  [IPC.APP_INFO]: appInfoArgsSchema,
};

async function invoke<T>(channel: string, args: unknown[] = []): Promise<IpcResult<T>> {
  const schema = INVOKE_WHITELIST[channel];
  if (!schema) {
    return fail('IPC_CHANNEL_NOT_WHITELISTED', `通道未在白名单中：${channel}`);
  }

  const parsed = schema.safeParse(args);
  if (!parsed.success) {
    return fail('IPC_INVALID_PAYLOAD', parsed.error.message);
  }

  return (await ipcRenderer.invoke(channel)) as IpcResult<T>;
}

const api: WindowApi = {
  app: {
    getInfo: () => invoke<AppInfo>(IPC.APP_INFO),
  },
};

contextBridge.exposeInMainWorld('api', api);