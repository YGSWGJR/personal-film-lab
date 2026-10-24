/// <reference types="vite/client" />

import type { AppInfo, WindowApi, WorkspaceState } from '../../shared/types';

/** 冒烟测试可读的运行时状态（仅骨架阶段使用） */
export interface SkeletonState {
  ready: boolean;
  title: string;
  bridge: boolean;
  ipcOk: boolean;
  apiKeys: string;
  info: AppInfo | null;
  error: string | null;
}

declare global {
  interface Window {
    /** preload 白名单桥（docs/S01 §3.2） */
    api: WindowApi;
    __SKELETON_STATE__?: SkeletonState;
    __CAPTURE_WORKSPACE_STATE__?: () => WorkspaceState;
  }
}

export {};
