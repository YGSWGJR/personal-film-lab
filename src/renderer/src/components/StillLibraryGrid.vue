<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import type { Still } from '../../../shared/types';

const props = withDefaults(
  defineProps<{
    projectId: string;
    visible: boolean;
  }>(),
  { visible: true },
);

const emit = defineEmits<{
  open: [still: Still];
}>();

const gridEl = ref<HTMLElement | null>(null);
const stills = ref<Still[]>([]);
const thumbWidth = ref(240);
const loading = ref(false);
const lastError = ref<string | null>(null);
let refreshTimer: ReturnType<typeof setInterval> | null = null;
let wheelRaf = 0;
let pendingWheel = 0;
let scrollPersistTimer: ReturnType<typeof setTimeout> | null = null;

const storageKey = () => `pfl:wall-stills:${props.projectId}`;

function loadViewState(): void {
  try {
    const raw = localStorage.getItem(storageKey());
    if (!raw) return;
    const parsed = JSON.parse(raw) as { thumbWidth?: unknown; scrollTop?: unknown };
    if (typeof parsed.thumbWidth === 'number' && Number.isFinite(parsed.thumbWidth)) {
      thumbWidth.value = Math.max(120, Math.min(420, Math.round(parsed.thumbWidth)));
    }
    const scrollTop =
      typeof parsed.scrollTop === 'number' && Number.isFinite(parsed.scrollTop)
        ? Math.max(0, parsed.scrollTop)
        : 0;
    void nextTick(() => {
      if (gridEl.value) gridEl.value.scrollTop = scrollTop;
    });
  } catch {
    thumbWidth.value = 240;
  }
}

function saveViewState(): void {
  try {
    localStorage.setItem(
      storageKey(),
      JSON.stringify({
        mode: 'grid',
        thumbWidth: thumbWidth.value,
        scrollTop: gridEl.value?.scrollTop ?? 0,
      }),
    );
  } catch {
    // localStorage failure must not break image browsing.
  }
}

function scheduleScrollSave(): void {
  if (scrollPersistTimer) clearTimeout(scrollPersistTimer);
  scrollPersistTimer = setTimeout(saveViewState, 180);
}

function stillAssetUrl(still: Still): string {
  const filePath = still.thumbPath || still.filePath;
  const encodedPath = filePath
    .split(/[\\/]/u)
    .filter(Boolean)
    .map((part) => encodeURIComponent(part))
    .join('/');
  return `lapian-asset://${props.projectId}/${encodedPath}`;
}

function normalizeMainStills(items: Still[]): Still[] {
  const byId = new Map<string, Still>();
  for (const item of items) {
    if (item.role === 'main') byId.set(item.id, item);
  }
  return [...byId.values()].sort(
    (left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt),
  );
}

async function refresh(initial = false): Promise<void> {
  if (!props.visible || !props.projectId) return;
  if (initial) loading.value = true;
  try {
    const result = await window.api.still.list({ projectId: props.projectId });
    if (!result.ok) {
      lastError.value = result.error.message;
      return;
    }
    lastError.value = null;
    const current = new Map(stills.value.map((item) => [item.id, item]));
    const next = normalizeMainStills(result.data);
    let changed = next.length !== stills.value.length;
    for (const item of next) {
      const previous = current.get(item.id);
      if (!previous || previous.updatedAt !== item.updatedAt) {
        changed = true;
        break;
      }
    }
    if (changed) stills.value = next;
  } catch (error) {
    lastError.value = error instanceof Error ? error.message : String(error);
  } finally {
    if (initial) loading.value = false;
  }
}

function syncRefreshTimer(): void {
  if (refreshTimer) {
    clearInterval(refreshTimer);
    refreshTimer = null;
  }
  if (props.visible) {
    void refresh(true);
    refreshTimer = setInterval(() => void refresh(false), 1000);
  }
}

watch(
  () => [props.projectId, props.visible] as const,
  ([, visible], previous) => {
    if (visible && (!previous || previous[1] !== visible)) {
      loadViewState();
      syncRefreshTimer();
    } else if (!visible && refreshTimer) {
      clearInterval(refreshTimer);
      refreshTimer = null;
      saveViewState();
    }
  },
);

function applyWheelZoom(event: WheelEvent): void {
  event.preventDefault();
  const grid = gridEl.value;
  if (!grid) return;
  const target = event.target as HTMLElement | null;
  const card = target?.closest<HTMLElement>('[data-still-id]');
  const anchorId = card?.dataset.stillId ?? null;
  const beforeTop = card?.getBoundingClientRect().top ?? 0;
  pendingWheel += event.deltaY;
  if (wheelRaf) return;
  wheelRaf = requestAnimationFrame(async () => {
    wheelRaf = 0;
    const delta = pendingWheel;
    pendingWheel = 0;
    const factor = Math.pow(1.0018, -delta);
    const next = Math.max(120, Math.min(420, Math.round(thumbWidth.value * factor)));
    if (next === thumbWidth.value) return;
    thumbWidth.value = next;
    await nextTick();
    if (anchorId) {
      const anchor = grid.querySelector<HTMLElement>(
        `[data-still-id="${CSS.escape(anchorId)}"]`,
      );
      if (anchor) {
        const deltaY = anchor.getBoundingClientRect().top - beforeTop;
        grid.scrollTop += deltaY;
      }
    }
    saveViewState();
  });
}

function onWheel(event: WheelEvent): void {
  event.stopPropagation();
  if (event.altKey) {
    scheduleScrollSave();
    return;
  }
  applyWheelZoom(event);
}

function resetView(): void {
  thumbWidth.value = 240;
  if (gridEl.value) gridEl.value.scrollTop = 0;
  saveViewState();
}

function openStill(still: Still): void {
  if (!still.shotId) return;
  emit('open', still);
}

onMounted(() => {
  loadViewState();
  syncRefreshTimer();
});

onBeforeUnmount(() => {
  if (refreshTimer) clearInterval(refreshTimer);
  if (scrollPersistTimer) clearTimeout(scrollPersistTimer);
  if (wheelRaf) cancelAnimationFrame(wheelRaf);
  saveViewState();
});
</script>

<template>
  <section
    ref="gridEl"
    class="still-library"
    tabindex="0"
    aria-label="静帧列表"
    @wheel.stop="onWheel"
    @pointerdown.stop
    @scroll.passive="scheduleScrollSave"
    @keydown.ctrl.0.prevent.stop="resetView"
  >
    <header class="still-library-head">
      <div>
        <b>静帧库</b>
        <span>{{ stills.length }} 张主静帧</span>
      </div>
      <p>滚轮调整缩略图 · Alt+滚轮滚动 · Ctrl+0 复位</p>
    </header>

    <div
      v-if="stills.length > 0"
      class="still-grid"
      :style="{ '--still-width': `${thumbWidth}px` }"
    >
      <article
        v-for="still in stills"
        :key="still.id"
        class="still-card"
        :data-still-id="still.id"
        @dblclick="openStill(still)"
      >
        <div class="still-image-wrap">
          <img :src="stillAssetUrl(still)" alt="" draggable="false" loading="lazy" />
          <span>{{ (still.timeMs / 1000).toFixed(2) }}s</span>
        </div>
        <div class="still-caption">
          <b>{{ still.caption || '未命名静帧' }}</b>
          <small>{{ new Date(still.createdAt).toLocaleString('zh-CN') }}</small>
        </div>
      </article>
    </div>

    <div v-else-if="loading" class="still-empty">正在读取静帧…</div>
    <div v-else class="still-empty">
      <b>还没有主静帧</b>
      <span>在放映层截图后，静帧会在这里自动出现。双击可回到该帧。</span>
    </div>

    <p v-if="lastError" class="still-error">{{ lastError }}</p>
  </section>
</template>

<style scoped>
.still-library {
  position: absolute;
  inset: 0;
  z-index: 40;
  overflow: auto;
  padding: 22px;
  outline: none;
  background:
    radial-gradient(circle at 24px 24px, rgba(148, 163, 184, 0.12) 1px, transparent 1.4px) 0 0 / 24px 24px,
    #0a0f18;
}

.still-library-head {
  position: sticky;
  top: -22px;
  z-index: 2;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 20px;
  margin: -22px -22px 18px;
  padding: 16px 22px;
  border-bottom: 1px solid rgba(148, 163, 184, 0.16);
  background: rgba(10, 15, 24, 0.94);
  backdrop-filter: blur(10px);
}

.still-library-head div {
  display: flex;
  align-items: baseline;
  gap: 10px;
}

.still-library-head b {
  font-size: 17px;
}

.still-library-head span,
.still-library-head p {
  color: #8394aa;
}

.still-library-head p {
  margin: 0;
  font-size: 11px;
}

.still-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(var(--still-width), 1fr));
  gap: 16px;
  align-items: start;
}

.still-card {
  min-width: 0;
  overflow: hidden;
  border: 1px solid rgba(148, 163, 184, 0.2);
  border-radius: 12px;
  background: #111923;
  cursor: default;
}

.still-card:hover {
  border-color: rgba(90, 162, 255, 0.55);
}

.still-image-wrap {
  position: relative;
  aspect-ratio: 16 / 9;
  overflow: hidden;
  background: #080c13;
}

.still-image-wrap img {
  width: 100%;
  height: 100%;
  object-fit: contain;
}

.still-image-wrap span {
  position: absolute;
  right: 8px;
  bottom: 8px;
  padding: 3px 6px;
  border-radius: 4px;
  background: rgba(0, 0, 0, 0.7);
  color: #d7e6f9;
  font: 10px var(--mono);
}

.still-caption {
  display: grid;
  gap: 4px;
  padding: 10px 11px 12px;
}

.still-caption b,
.still-caption small {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.still-caption small {
  color: #78899f;
}

.still-empty {
  display: grid;
  min-height: 48vh;
  place-items: center;
  align-content: center;
  gap: 8px;
  color: #8092a9;
}

.still-empty b {
  color: #c3d1e3;
  font-size: 18px;
}

.still-error {
  color: #ff8b8b;
}
</style>
