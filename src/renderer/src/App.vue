<script setup lang="ts">
import { onMounted, ref } from 'vue';
import type { AppInfo } from '../../shared/types';
import type { SkeletonState } from './env';

const info = ref<AppInfo | null>(null);
const error = ref<string | null>(null);
const bridgeReady = ref(false);
const apiKeys = ref('');

const state: SkeletonState = {
  ready: false,
  title: document.title,
  bridge: false,
  ipcOk: false,
  apiKeys: '',
  info: null,
  error: null,
};
window.__SKELETON_STATE__ = state;

onMounted(async () => {
  const api = window.api;
  bridgeReady.value = Boolean(api?.app?.getInfo);
  apiKeys.value = api ? Object.keys(api).join(',') : '';
  state.bridge = bridgeReady.value;
  state.apiKeys = apiKeys.value;

  if (!api?.app?.getInfo) {
    error.value = 'window.api 不存在：preload 白名单桥未生效';
    state.error = error.value;
    state.ready = true;
    return;
  }

  try {
    const result = await api.app.getInfo();
    if (!result.ok) {
      throw new Error(result.error.message);
    }
    info.value = result.data;
    state.ipcOk = true;
    state.info = result.data;
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause);
    state.error = error.value;
  } finally {
    state.ready = true;
  }
});
</script>

<template>
  <div class="app-shell">
    <header class="topbar">
      <div class="brand">
        <span class="brand-mark" aria-hidden="true"></span>
        <div class="brand-text">
          <h1 id="app-title">个人拉片工作台</h1>
          <p class="brand-sub">Personal Film Lab</p>
        </div>
      </div>
      <div class="topbar-meta">
        <span class="pill pill-warn">阶段 0 · 工程骨架</span>
        <span class="pill" :class="bridgeReady ? 'pill-ok' : 'pill-danger'">
          {{ bridgeReady ? 'contextIsolation · 白名单桥已启用' : '桥接缺失' }}
        </span>
      </div>
    </header>

    <main class="workspace">
      <aside class="panel panel-left">
        <h2 class="panel-title">项目 / 镜头</h2>
        <div class="placeholder-list">
          <div class="placeholder-row">尚未导入影片</div>
          <div class="placeholder-row placeholder-muted">下一步：导入 → 探测 → 播放</div>
        </div>
      </aside>

      <section class="panel panel-center">
        <div class="stage">
          <div class="stage-badge">播放器占位</div>
          <p class="stage-text">Electron 窗口与渲染页面已就绪</p>
          <p class="stage-hint">阶段 2 接入 libmpv 后，此处承载帧级播放</p>
        </div>
      </section>

      <aside class="panel panel-right">
        <h2 class="panel-title">详情卡</h2>
        <div class="placeholder-list">
          <div class="placeholder-row placeholder-muted">选中镜头后显示静帧、标签与笔记</div>
        </div>
      </aside>
    </main>

    <footer class="statusbar">
      <div class="status-item">
        <span class="status-label">渲染层</span>
        <span class="status-value" :class="error ? 'error' : info ? 'ok' : ''">
          {{ error ?? (info ? '已加载 · app:info 正常' : '加载中…') }}
        </span>
      </div>
      <div class="status-item">
        <span class="status-label">preload 白名单</span>
        <span class="status-value" :class="bridgeReady ? 'ok' : 'error'">{{ apiKeys || '—' }}</span>
      </div>
      <div class="status-item">
        <span class="status-label">版本</span>
        <span class="status-value">{{ info ? `v${info.version}` : '—' }}</span>
      </div>
      <div class="status-item">
        <span class="status-label">平台</span>
        <span class="status-value">{{ info?.platform ?? '—' }}</span>
      </div>
      <div class="status-item status-item-grow">
        <span class="status-label">数据目录</span>
        <span class="status-value" :title="info?.appDataPath">{{ info?.appDataPath ?? '—' }}</span>
      </div>
    </footer>
  </div>
</template>