<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref } from 'vue';
import type { AppInfo, IpcResult, MediaInfo, PlayerErrorEvent, PlayerState } from '../../shared/types';
import type { SkeletonState } from './env';

const info = ref<AppInfo | null>(null);
const error = ref<string | null>(null);
const bridgeReady = ref(false);
const apiKeys = ref('');

const player = reactive<PlayerState>({
  hasFile: false,
  timeMs: 0,
  durationMs: 0,
  paused: true,
  ended: false,
  volume: 1,
  width: 0,
  height: 0,
  fps: 0,
});

const mediaName = ref('');
const playerError = ref<PlayerErrorEvent | null>(null);
const busy = ref(false);
const slotEl = ref<HTMLElement | null>(null);

const skeleton: SkeletonState = {
  ready: false,
  title: document.title,
  bridge: false,
  ipcOk: false,
  apiKeys: '',
  info: null,
  error: null,
};
window.__SKELETON_STATE__ = skeleton;

const timecode = computed(() => formatTime(player.timeMs));
const durationText = computed(() => (player.durationMs > 0 ? formatTime(player.durationMs) : '—'));
const frameText = computed(() => {
  if (!player.hasFile || player.fps <= 0) return '—';
  return String(Math.round((player.timeMs / 1000) * player.fps));
});

const unsubscribers: Array<() => void> = [];
let resizeObserver: ResizeObserver | null = null;
let errorTimer: ReturnType<typeof setTimeout> | null = null;
let stepping = false;

function formatTime(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const millis = Math.max(0, Math.floor(ms % 1000));
  const base = `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
  return player.fps > 0 ? `${base}.${String(millis).padStart(3, '0')}` : base;
}

function showError(code: string, message: string): void {
  playerError.value = { code, message };
  if (errorTimer) clearTimeout(errorTimer);
  errorTimer = setTimeout(() => {
    playerError.value = null;
  }, 6000);
}

function unwrap<T>(result: IpcResult<T>): T | null {
  if (result.ok) return result.data;
  showError(result.error.code, result.error.message);
  return null;
}

async function openFile(): Promise<void> {
  if (busy.value) return;
  busy.value = true;
  try {
    const picked = unwrap(await window.api.player.openDialog());
    if (picked) {
      mediaName.value = fileNameOf(picked.path);
      syncPlayerFromState(await window.api.player.getState());
    }
  } finally {
    busy.value = false;
  }
}

async function toggle(): Promise<void> {
  if (!player.hasFile || busy.value) return;
  busy.value = true;
  try {
    const state = unwrap(await window.api.player.toggle());
    if (state) Object.assign(player, state);
  } finally {
    busy.value = false;
  }
}

async function step(dir: 1 | -1): Promise<void> {
  if (!player.hasFile || stepping) return;
  stepping = true;
  try {
    const frame = unwrap(await window.api.player.frameStep({ dir }));
    if (frame) player.timeMs = frame.timeMs;
  } finally {
    stepping = false;
  }
}

async function seekTo(timeMs: number): Promise<void> {
  if (!player.hasFile || busy.value) return;
  busy.value = true;
  try {
    const state = unwrap(await window.api.player.seek({ timeMs }));
    if (state) Object.assign(player, state);
  } finally {
    busy.value = false;
  }
}

async function onVolume(event: Event): Promise<void> {
  const target = event.target as HTMLInputElement;
  const state = unwrap(await window.api.player.setVolume({ volume: Number(target.value) }));
  if (state) Object.assign(player, state);
}

function onKeydown(event: KeyboardEvent): void {
  const tagName = (event.target as HTMLElement | null)?.tagName;
  if (tagName === 'INPUT' || tagName === 'TEXTAREA' || tagName === 'SELECT') return;
  if (!player.hasFile) return;

  if (event.code === 'Space') {
    event.preventDefault();
    void toggle();
    return;
  }
  if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
    event.preventDefault();
    const dir: 1 | -1 = event.key === 'ArrowLeft' ? -1 : 1;
    if (event.shiftKey) {
      void seekTo(player.timeMs + dir * 1000);
    } else {
      void step(dir);
    }
  }
}

function syncPlayerFromState(state: IpcResult<PlayerState>): void {
  if (state.ok) Object.assign(player, state.data);
}

function fileNameOf(filePath: string): string {
  const parts = filePath.split(/[\\/]/);
  return parts[parts.length - 1] || filePath;
}

function pushBounds(): void {
  if (!slotEl.value || !window.api?.player) return;
  const rect = slotEl.value.getBoundingClientRect();
  void window.api.player.setBounds({
    x: rect.x,
    y: rect.y,
    width: rect.width,
    height: rect.height,
  });
}

onMounted(async () => {
  const api = window.api;
  bridgeReady.value = Boolean(api?.player && api?.app);
  apiKeys.value = api ? Object.keys(api).sort().join(',') : '';
  skeleton.bridge = bridgeReady.value;
  skeleton.apiKeys = apiKeys.value;

  if (!api?.app?.getInfo) {
    error.value = 'window.api 不存在：preload 白名单桥未生效';
    skeleton.error = error.value;
    skeleton.ready = true;
    return;
  }

  try {
    const result = await api.app.getInfo();
    if (!result.ok) throw new Error(result.error.message);
    info.value = result.data;
    skeleton.ipcOk = true;
    skeleton.info = result.data;
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause);
    skeleton.error = error.value;
  } finally {
    skeleton.ready = true;
  }

  if (api.player) {
    unsubscribers.push(
      api.player.onState((state) => {
        Object.assign(player, state);
        if (state.hasFile && !mediaName.value) {
          mediaName.value = '已加载影片';
        }
      }),
      api.player.onTime((event) => {
        player.timeMs = event.timeMs;
      }),
      api.player.onLoaded((media: MediaInfo) => {
        mediaName.value = fileNameOf(media.path);
        player.hasFile = true;
        player.durationMs = media.durationMs;
        player.width = media.width;
        player.height = media.height;
        player.fps = media.fps;
      }),
      api.player.onError((event) => {
        showError(event.code, event.message);
      }),
    );

    await nextTick();
    pushBounds();
    resizeObserver = new ResizeObserver(() => pushBounds());
    if (slotEl.value) resizeObserver.observe(slotEl.value);
    window.addEventListener('resize', pushBounds);
  }

  window.addEventListener('keydown', onKeydown);
});

onBeforeUnmount(() => {
  for (const unsubscribe of unsubscribers) unsubscribe();
  unsubscribers.length = 0;
  resizeObserver?.disconnect();
  resizeObserver = null;
  window.removeEventListener('resize', pushBounds);
  window.removeEventListener('keydown', onKeydown);
  if (errorTimer) clearTimeout(errorTimer);
  void window.api?.player?.close();
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
        <span class="pill pill-warn">阶段 0 · 播放链路</span>
        <span class="pill" :class="bridgeReady ? 'pill-ok' : 'pill-danger'">
          {{ bridgeReady ? 'contextIsolation · 白名单桥已启用' : '桥接缺失' }}
        </span>
      </div>
    </header>

    <main class="workspace">
      <aside class="panel panel-left">
        <h2 class="panel-title">项目 / 镜头</h2>
        <div class="placeholder-list">
          <div class="placeholder-row">尚未导入项目</div>
          <div class="placeholder-row placeholder-muted">下一步：导入 → 探测 → 播放</div>
        </div>
      </aside>

      <section class="panel panel-center">
        <div class="player-body">
          <div class="video-stage">
            <div class="video-slot" ref="slotEl">
              <div v-if="!player.hasFile" class="video-empty">
                <div class="stage-badge">播放器</div>
                <p class="stage-text">打开一个视频文件开始拉片</p>
                <p class="stage-hint">逐帧步进是拉片核心：空格播放/暂停，←/→ 逐帧，Shift+←/→ 跳 1 秒</p>
                <button class="btn btn-primary" :disabled="busy" @click="openFile">打开影片…</button>
              </div>
            </div>
          </div>

          <div class="player-controls">
            <button class="btn" :disabled="busy" @click="openFile">打开影片…</button>
            <button class="btn" :disabled="!player.hasFile" title="上一帧 (←)" @click="step(-1)">◀ 帧</button>
            <button class="btn btn-play" :disabled="!player.hasFile" title="播放/暂停 (空格)" @click="toggle">
              {{ player.paused ? '▶ 播放' : '⏸ 暂停' }}
            </button>
            <button class="btn" :disabled="!player.hasFile" title="下一帧 (→)" @click="step(1)">帧 ▶</button>

            <span class="timecode">{{ timecode }} / {{ durationText }}</span>
            <span class="frame-info">第 {{ frameText }} 帧</span>
            <span v-if="player.fps > 0" class="media-info">
              {{ player.fps.toFixed(3) }} fps · {{ player.width }}×{{ player.height }}
            </span>
            <span v-if="mediaName" class="file-name" :title="mediaName">{{ mediaName }}</span>

            <label class="volume">
              音量
              <input
                type="range"
                min="0"
                max="1"
                step="0.01"
                :value="player.volume"
                :disabled="!player.hasFile"
                @input="onVolume"
              />
            </label>
          </div>
        </div>
      </section>

      <aside class="panel panel-right">
        <h2 class="panel-title">详情卡</h2>
        <div class="placeholder-list">
          <div class="placeholder-row placeholder-muted">选中镜头后显示静帧、标签与笔记</div>
        </div>
        <div class="shortcut-card">
          <h3>快捷键</h3>
          <ul>
            <li><kbd>Space</kbd> 播放 / 暂停</li>
            <li><kbd>←</kbd> / <kbd>→</kbd> 逐帧步进</li>
            <li><kbd>Shift</kbd> + <kbd>←</kbd> / <kbd>→</kbd> ±1 秒</li>
          </ul>
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
      <div class="status-item status-item-grow">
        <span class="status-label">时间码</span>
        <span class="status-value" :class="player.hasFile ? 'ok' : ''">{{ timecode }} · 第 {{ frameText }} 帧</span>
      </div>
    </footer>

    <transition name="toast">
      <div v-if="playerError" class="toast">
        <strong>{{ playerError.code }}</strong>
        <span>{{ playerError.message }}</span>
      </div>
    </transition>
  </div>
</template>