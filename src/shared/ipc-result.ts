import type { IpcResult } from './types';

/**
 * IPC 统一信封工具（docs/S01 §6.1）：
 *   type IpcResult<T> = { ok: true; data: T } | { ok: false; error: IpcError };
 * 主进程 handler 一律经 withEnvelope 包裹，异常不得穿透到渲染层。
 * 错误可携带 details（媒体任务失败时的 stderr / exitCode / command 诊断）。
 */

export function ok<T>(data: T): IpcResult<T> {
  return { ok: true, data };
}

export function fail(code: string, message: string, details?: Record<string, unknown>): IpcResult<never> {
  return { ok: false, error: details ? { code, message, details } : { code, message } };
}

type Handler = (...args: any[]) => unknown;

/**
 * 把 handler 包成「永不 reject、异常转信封」的 ipcMain.handle 回调。
 */
export function withEnvelope<T extends Handler>(handler: T) {
  return async (_event: unknown, ...args: Parameters<T>): Promise<IpcResult<unknown>> => {
    try {
      const result = await handler(...args);
      if (isIpcResult(result)) {
        return result as IpcResult<unknown>;
      }
      return ok(result);
    } catch (error) {
      const err = error as { code?: string; message?: string; details?: Record<string, unknown> };
      const code = err?.code ?? 'IPC_HANDLER_FAILED';
      const message = err?.message ?? String(error);
      console.error(`[ipc] handler failed: ${code} ${message}`);
      return fail(code, message, err?.details);
    }
  };
}

/**
 * 领域对象也可能自带 ok 字段（例如 DetectEnvCheck）。
 * 只接受结构完全符合 IpcResult 的对象，避免把它们误当成已封装结果。
 */
function isIpcResult(value: unknown): value is IpcResult<unknown> {
  if (!value || typeof value !== 'object') return false;
  const keys = Object.keys(value);
  if (!keys.every((key) => key === 'ok' || key === 'data' || key === 'error')) return false;
  const candidate = value as { ok?: unknown; data?: unknown; error?: unknown };
  if (candidate.ok === true) return 'data' in candidate;
  if (candidate.ok === false) return 'error' in candidate;
  return false;
}
