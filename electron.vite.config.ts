import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import vue from '@vitejs/plugin-vue';

/**
 * electron-vite 三端构建配置（docs/S01 §2 / §4）。
 * 入口约定：src/main/index.ts、src/preload/index.ts、src/renderer/index.html。
 */
export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
  },
  preload: {
    // zod 等校验依赖需要打进 preload 包：sandbox 下无法 require 外部模块
    build: {
      rollupOptions: {
        output: {
          format: 'cjs',
        },
      },
    },
  },
  renderer: {
    plugins: [vue()],
  },
});