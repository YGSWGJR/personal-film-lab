<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import AppIcon from './AppIcon.vue';
import type { WorkspaceShot } from '../types/workspace';

const props = defineProps<{
  shots: WorkspaceShot[];
  selectedId: string | null;
  currentTimeMs: number;
  emptyImage: string;
  initialScrollTop?: number;
}>();

const emit = defineEmits<{
  select: [shot: WorkspaceShot];
  addShot: [];
  detect: [];
  collapse: [];
  scrollPosition: [value: number];
  contextMenu: [shot: WorkspaceShot, position: { x: number; y: number }];
}>();

const ROW_HEIGHT = 44;
const OVERSCAN = 4;
const scrollEl = ref<HTMLElement | null>(null);
const scrollTop = ref(0);
const viewportHeight = ref(520);
let resizeObserver: ResizeObserver | null = null;

const startIndex = computed(() => Math.max(0, Math.floor(scrollTop.value / ROW_HEIGHT) - OVERSCAN));
const visibleCount = computed(() => Math.ceil(viewportHeight.value / ROW_HEIGHT) + OVERSCAN * 2);
const visibleShots = computed(() => props.shots.slice(startIndex.value, startIndex.value + visibleCount.value));
const totalHeight = computed(() => props.shots.length * ROW_HEIGHT);

function onScroll(): void {
  scrollTop.value = scrollEl.value?.scrollTop ?? 0;
  emit('scrollPosition', scrollTop.value);
}

onMounted(() => {
  if (!scrollEl.value) return;
  scrollEl.value.scrollTop = props.initialScrollTop ?? 0;
  viewportHeight.value = scrollEl.value.clientHeight;
  resizeObserver = new ResizeObserver(() => {
    viewportHeight.value = scrollEl.value?.clientHeight ?? viewportHeight.value;
  });
  resizeObserver.observe(scrollEl.value);
});

watch(
  () => props.initialScrollTop,
  (value) => {
    if (!scrollEl.value || value === undefined) return;
    if (Math.abs(scrollEl.value.scrollTop - value) < 1) return;
    scrollEl.value.scrollTop = value;
  },
);

onBeforeUnmount(() => {
  resizeObserver?.disconnect();
  resizeObserver = null;
});

function durationText(ms: number): string {
  return `00:${String(Math.round(ms / 1000)).padStart(2, '0')}.0`;
}
</script>

<template>
  <aside class="shot-panel panel-base">
    <header class="panel-head">
      <span>镜头列表</span>
      <div class="head-end">
        <span class="count">{{ shots.length }}</span>
        <button type="button" title="收起镜头列表" @click="emit('collapse')">
          <AppIcon name="chevron-left" :size="14" />
        </button>
      </div>
    </header>

    <div ref="scrollEl" class="shot-scroll" role="listbox" aria-label="镜头列表" @scroll="onScroll">
      <div v-if="shots.length === 0" class="shot-empty">
        <img :src="emptyImage" alt="" />
        <p>暂无镜头</p>
        <span>运行镜头检测，或在播放时手动打点</span>
      </div>
      <div v-else class="shot-spacer" :style="{ height: `${totalHeight}px` }">
        <button
          v-for="(shot, offset) in visibleShots"
          :key="shot.id"
          class="shot-row"
          :class="{
            selected: shot.id === selectedId,
            current: currentTimeMs >= shot.startMs && currentTimeMs < shot.endMs,
          }"
          :style="{ top: `${(startIndex + offset) * ROW_HEIGHT}px` }"
          type="button"
          role="option"
          :aria-selected="shot.id === selectedId"
          @click="emit('select', shot)"
          @contextmenu.prevent="emit('contextMenu', shot, { x: $event.clientX, y: $event.clientY })"
        >
          <span class="shot-thumb">
            <img :src="shot.thumbnail" :alt="`${shot.title} 缩略图`" />
          </span>
          <span class="shot-number">{{ String(shot.index).padStart(2, '0') }}</span>
          <span class="shot-size">{{ shot.shotSize ?? '待定' }}</span>
          <span class="shot-duration">{{ durationText(shot.durationMs) }}</span>
        </button>
      </div>
    </div>

    <footer class="panel-foot">
      <button type="button" title="在当前时码手动打点" @click="emit('addShot')">
        <AppIcon name="plus" :size="16" />
        手动打点
      </button>
    </footer>
  </aside>
</template>

<style scoped>
.shot-panel {
  display: flex;
  min-width: 0;
  min-height: 0;
  flex-direction: column;
  border-radius: 8px 0 0 8px;
}

.panel-head {
  display: flex;
  height: 34px;
  flex: 0 0 auto;
  align-items: center;
  justify-content: space-between;
  padding: 0 12px;
  border-bottom: 1px solid var(--border);
  color: var(--text-primary);
  font-size: 13px;
  font-weight: 600;
}

.count {
  color: var(--text-muted);
  font-family: var(--mono);
  font-size: 10px;
  font-weight: 400;
}

.head-end {
  display: flex;
  align-items: center;
  gap: 4px;
}

.head-end button {
  display: grid;
  width: 28px;
  height: 28px;
  padding: 0;
  border: 0;
  border-radius: 4px;
  background: transparent;
  color: var(--text-faint);
  place-items: center;
}

.head-end button:hover {
  background: var(--bg-hover);
  color: var(--text-primary);
}

.shot-scroll {
  position: relative;
  min-height: 0;
  flex: 1;
  overflow-y: auto;
  padding: 8px 8px 8px 8px;
  overscroll-behavior: contain;
}

.shot-spacer {
  position: relative;
  min-height: 1px;
}

.shot-empty {
  display: flex;
  height: 100%;
  align-items: center;
  justify-content: center;
  flex-direction: column;
  gap: 8px;
  padding: 24px;
  color: var(--text-faint);
  text-align: center;
}

.shot-empty img {
  width: min(176px, 82%);
  max-height: 132px;
  border: 1px solid var(--border);
  border-radius: 8px;
  object-fit: cover;
  opacity: 0.82;
}

.shot-empty p {
  margin: 0;
  color: var(--text-secondary);
  font-size: 13px;
  font-weight: 600;
}

.shot-empty span {
  font-size: 11px;
  line-height: 1.5;
}

.shot-row {
  position: absolute;
  right: 0;
  left: 0;
  display: flex;
  width: 100%;
  height: 44px;
  align-items: center;
  gap: 8px;
  padding: 0 8px;
  border: 2px solid transparent;
  border-radius: 6px;
  background: transparent;
  color: var(--text-secondary);
  text-align: left;
  transition:
    background 120ms ease,
    border-color 120ms ease;
}

.shot-row:hover {
  background: var(--bg-hover);
}

.shot-row.selected {
  border-color: var(--red);
  background: var(--red-soft);
}

.shot-row.current:not(.selected) {
  box-shadow: inset 2px 0 var(--gold);
}

.shot-thumb {
  width: 64px;
  height: 36px;
  flex: 0 0 auto;
  overflow: hidden;
  border: 1px solid var(--border);
  border-radius: 4px;
  background: var(--bg-deep);
}

.shot-thumb img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.shot-number {
  width: 24px;
  flex: 0 0 auto;
  color: var(--text-primary);
  font-family: var(--mono);
  font-size: 11px;
}

.shot-size {
  display: inline-flex;
  height: 20px;
  flex: 0 0 auto;
  align-items: center;
  padding: 0 8px;
  border-radius: 4px;
  background: rgba(251, 191, 36, 0.12);
  color: var(--gold);
  font-size: 10px;
  font-weight: 600;
}

.shot-duration {
  min-width: 0;
  margin-left: auto;
  color: var(--text-muted);
  font-family: var(--mono);
  font-size: 11px;
  white-space: nowrap;
}

.panel-foot {
  flex: 0 0 auto;
  padding: 8px;
  border-top: 1px solid var(--border);
}

.panel-foot button {
  display: flex;
  width: 100%;
  height: 28px;
  align-items: center;
  justify-content: center;
  gap: 6px;
  border: 0;
  border-radius: 6px;
  background: var(--bg-raised);
  color: var(--text-secondary);
  font-size: 12px;
}

.panel-foot button:hover {
  background: var(--bg-hover);
}
</style>
