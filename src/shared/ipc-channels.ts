/**
 * IPC 通道名唯一来源（docs/S01 §6.2）。
 * 新增通道：先改本文件 + S01 §6，再在 src/main/ipc 注册、src/preload 暴露。
 */
export const IPC = {
  /** app 域：返回版本 / 平台 / 用户数据目录（I 方向） */
  APP_INFO: 'app:info',
} as const;

export type IpcChannel = (typeof IPC)[keyof typeof IPC];