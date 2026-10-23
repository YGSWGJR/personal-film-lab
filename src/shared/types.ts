/**
 * 主进程 / preload / 渲染层共享的类型（docs/S01 §7）。
 * 本文件只允许放类型与常量，禁止引入 Node / Electron 依赖。
 */

/** 应用信息（S01 §6.2 app:info 返回） */
export interface AppInfo {
  version: string;
  platform: string;
  appDataPath: string;
}

/** IPC 错误体（S01 §6.1） */
export interface IpcError {
  code: string;
  message: string;
}

/** 统一返回信封（S01 §6.1） */
export type IpcResult<T> = { ok: true; data: T } | { ok: false; error: IpcError };

/**
 * preload 暴露给渲染层的 window.api 契约。
 * 阶段 0 只开放 app 域；后续按 S01 §6 分域扩展（playerApi / projectApi / ...）。
 */
export interface AppApi {
  getInfo(): Promise<IpcResult<AppInfo>>;
}

export interface WindowApi {
  app: AppApi;
}