<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import type { WallLayoutItem, WallViewState } from '../../../shared/types';
import type { WorkspaceShot } from '../types/workspace';

/**
 * S43 分镜墙画布一期（看板形态）：
 * - 镜头卡铺在无限二维画布上，滚轮以光标为锚点缩放（0.1~4.0），ALT/两指平移，拖空白/中键/空格抓手；
 * - 卡片拖拽改世界坐标，一次拖拽结束批量落库（wall:saveLayout）；
 * - 视口外卡片不挂载（虚拟化）；缩放只改变换矩阵，不重排、不重取图、不写库；
 * - 打开时视频 HWND 必须已降层（由 App.vue overlayOpen 统一处理）。
 */
const props = defineProps<{
  shots: WorkspaceShot[];
  viewState: WallViewState | null;
  projectId: string;
}>();

const emit = defineEmits<{
  close: [];
  seek: [startMs: number];
  layoutChange: [items: WallLayoutItem[]];
  viewStateChange: [view: WallViewState];
}>();

const CARD_W = 220;
const CARD_H = 148;
const GAP = 24;
const MIN_SCALE = 0.1;
const MAX_SCALE = 4;

const stageEl = ref<HTMLElement | null>(null);
const scale = ref(1);
const panX = ref(0);
const panY = ref(0);
const positions = ref<Map<string, { x: number; y: number }>>(new Map());
const stageW = ref(1280);
const stageH = ref(720);
const draggingId = ref<string | null>(null);
const panning = ref(false);
const dragMoved = ref(false);

const raf = ref(0);
const pendingWheel = ref<{ clientX: number; clientY: number; delta: number } | null>(null);

let bounds: Array<{ id: string; x: number; y: number; w: number; h: number }> = [];

function clampScale(value: number): number {
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, value));
}

/** 首次布局：无记录的镜头按网格排（内存内生成，拖动后才落库） */
function buildInitialLayout(): Map<string, { x: number; y: number }> {
  const map = new Map<string, { x: number; y: number }>();
  const cols = Math.max(1, Math.floor((stageW.value - GAP) / (CARD_W + GAP)));
  let col = 0;
  let row = 0;
  for (const shot of props.shots) {
    map.set(shot.id, { x: GAP + col * (CARD_W + GAP), y: GAP + row * (CARD_H + GAP + 30) });
    col += 1;
    if (col >= cols) {
      col = 0;
      row += 1;
    }
  }
  return map;
}

function ensureLayout(): void {
  // 已有布局优先；shots 变化时仅对无位置的新镜头网格补位
  let changed = false;
  for (const shot of props.shots) {
    if (!positions.value.has(shot.id)) {
      const grid = buildInitialLayout();
      const pos = grid.get(shot.id);
      if (pos) {
        positions.value.set(shot.id, pos);
        changed = true;
      }
    }
  }
  if (changed) positions.value = new Map(positions.value);
}

watch(
  () => props.shots.map((s) => s.id).join('|'),
  () => ensureLayout(),
);

// 视图状态可能在挂载后（settings 异步读取）才到达
watch(
  () => props.viewState,
  (state) => {
    if (state && !userAdjusted) {
      scale.value = clampScale(state.scale);
      panX.value = state.panX;
      panY.value = state.panY;
    }
  },
);

const laidShots = computed(() =>
  props.shots
    .map((shot) => {
      const pos = positions.value.get(shot.id);
      return pos ? { shot, x: pos.x, y: pos.y } : null;
    })
    .filter((item): item is { shot: WorkspaceShot; x: number; y: number } => item !== null),
);

/** 虚拟化：只挂载视口内（含边距）的卡片 */
const visibleShots = computed(() => {
  const margin = 320;
  const vx0 = -panX.value / scale.value - margin;
  const vy0 = -panY.value / scale.value - margin;
  const vx1 = vx0 + stageW.value / scale.value + margin * 2;
  const vy1 = vy0 + stageH.value / scale.value + margin * 2;
  bounds = [];
  return laidShots.value.filter((item) => {
    const hit = item.x < vx1 && item.x + CARD_W > vx0 && item.y < vy1 && item.y + CARD_H > vy0;
    if (hit) bounds.push({ id: item.shot.id, x: item.x, y: item.y, w: CARD_W, h: CARD_H });
    return hit;
  });
});

function measureStage(): void {
  const el = stageEl.value;
  if (!el) return;
  stageW.value = el.clientWidth || 1280;
  stageH.value = el.clientHeight || 720;
}

onMounted(() => {
  measureStage();
  applyInitialState();
  ensureLayout();
  window.addEventListener('resize', onWindowResize);
});

let userAdjusted = false;
function applyInitialState(): void {
  const state = props.viewState;
  if (state && Number.isFinite(state.scale)) {
    scale.value = clampScale(state.scale);
    panX.value = state.panX;
    panY.value = state.panY;
  }
}

function onWindowResize(): void {
  measureStage();
}

onBeforeUnmount(() => {
  window.removeEventListener('resize', onWindowResize);
  if (raf.value) cancelAnimationFrame(raf.value);
});

function normalizeWheelDelta(event: WheelEvent): number {
  if (event.deltaMode === 1) return event.deltaY * 16;
  if (event.deltaMode === 2) return event.deltaY * (stageEl.value?.clientHeight ?? 400);
  return event.deltaY;
}

function onWheel(event: WheelEvent): void {
  event.preventDefault();
  // ALT = 平移；两指横向 = 平移；其余（含 Ctrl 捏合）= 锚点缩放
  if (event.altKey || Math.abs(event.deltaX) > Math.abs(event.deltaY)) {
    panX.value -= event.deltaX || 0;
    panY.value -= event.deltaY || 0;
    emitViewState();
    return;
  }
  const pending = pendingWheel.value;
  if (pending) {
    pending.delta += normalizeWheelDelta(event);
    pending.clientX = event.clientX;
    pending.clientY = event.clientY;
  } else {
    pendingWheel.value = { clientX: event.clientX, clientY: event.clientY, delta: normalizeWheelDelta(event) };
  }
  if (!raf.value) {
    raf.value = requestAnimationFrame(() => {
      raf.value = 0;
      const item = pendingWheel.value;
      pendingWheel.value = null;
      if (!item) return;
      const rect = stageEl.value?.getBoundingClientRect();
      if (!rect) return;
      const screenX = item.clientX - rect.left;
      const screenY = item.clientY - rect.top;
      const worldX = (screenX - panX.value) / scale.value;
      const worldY = (screenY - panY.value) / scale.value;
      const next = clampScale(scale.value * Math.pow(1.0015, -item.delta));
      panX.value = screenX - worldX * next;
      panY.value = screenY - worldY * next;
      scale.value = next;
      emitViewState();
    });
  }
}

let viewStateTimer: ReturnType<typeof setTimeout> | null = null;
function emitViewState(): void {
  userAdjusted = true;
  if (viewStateTimer) clearTimeout(viewStateTimer);
  viewStateTimer = setTimeout(() => {
    emit('viewStateChange', { scale: scale.value, panX: panX.value, panY: panY.value });
  }, 300);
}

/* ---------- 抓手平移（空白拖拽 / 中键 / 空格+左键） ---------- */
let spaceDown = false;
function onKeyDown(e: KeyboardEvent): void {
  if (e.code === 'Space') spaceDown = true;
  if (e.key === '0' && (e.ctrlKey || e.metaKey)) {
    e.preventDefault();
    resetView();
  }
  if (e.key === '+' || e.key === '=') zoomBy(1.2);
  if (e.key === '-') zoomBy(1 / 1.2);
}
function onKeyUp(e: KeyboardEvent): void {
  if (e.code === 'Space') spaceDown = false;
}
function zoomBy(factor: number): void {
  const cx = stageW.value / 2;
  const cy = stageH.value / 2;
  zoomAt(cx, cy, factor);
}
function resetView(): void {
  scale.value = 1;
  panX.value = 0;
  panY.value = 0;
  emitViewState();
}
function zoomAt(screenX: number, screenY: number, factor: number): void {
  const worldX = (screenX - panX.value) / scale.value;
  const worldY = (screenY - panY.value) / scale.value;
  const next = clampScale(scale.value * factor);
  panX.value = screenX - worldX * next;
  panY.value = screenY - worldY * next;
  scale.value = next;
  emitViewState();
}

let panDrag: { x: number; y: number; px: number; py: number } | null = null;
function onStagePointerDown(event: PointerEvent): void {
  if ((event.target as HTMLElement).closest('.wall-card')) return;
  if (!(event.button === 1 || spaceDown || event.button === 0)) return;
  panDrag = { x: event.clientX, y: event.clientY, px: panX.value, py: panY.value };
  panning.value = true;
  (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
}
function onStagePointerMove(event: PointerEvent): void {
  if (!panDrag) return;
  panX.value = panDrag.px + (event.clientX - panDrag.x);
  panY.value = panDrag.py + (event.clientY - panDrag.y);
}
function onStagePointerUp(): void {
  panDrag = null;
  panning.value = false;
  emitViewState();
}

/* ---------- 卡片拖拽 ---------- */
function onCardPointerDown(event: PointerEvent, shot: WorkspaceShot): void {
  if (event.button !== 0 || spaceDown) return;
  event.stopPropagation();
  const pos = positions.value.get(shot.id);
  if (!pos) return;
  const startX = event.clientX;
  const startY = event.clientY;
  const originX = pos.x;
  const originY = pos.y;
  draggingId.value = shot.id;
  dragMoved.value = false;
  const move = (ev: PointerEvent): void => {
    const nx = originX + (ev.clientX - startX) / scale.value;
    const ny = originY + (ev.clientY - startY) / scale.value;
    if (Math.abs(ev.clientX - startX) > 2 || Math.abs(ev.clientY - startY) > 2) dragMoved.value = true;
    positions.value.set(shot.id, { x: nx, y: ny });
    positions.value = new Map(positions.value);
  };
  const up = (ev: PointerEvent): void => {
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
    draggingId.value = null;
    if (dragMoved.value) {
      positions.value.set(shot.id, {
        x: originX + (ev.clientX - startX) / scale.value,
        y: originY + (ev.clientY - startY) / scale.value,
      });
      const item = positions.value.get(shot.id);
      if (item) {
        emit('layoutChange', [{ shotId: shot.id, x: item.x, y: item.y }]);
      }
    }
  };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
}

function onCardClick(shot: WorkspaceShot): void {
  if (dragMoved) {
    dragMoved.value = false;
    return;
  }
  emit('seek', shot.startMs);
}

function onCardDblClick(shot: WorkspaceShot): void {
  emit('seek', shot.startMs);
  emit('close');
}

function fmtDuration(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}
</script>

<template>
  <section
    ref="stageEl"
    class="wall-stage"
    :class="{ grabbing: panning }"
    @wheel="onWheel"
    @pointerdown="onStagePointerDown"
    @pointermove="onStagePointerMove"
    @pointerup="onStagePointerUp"
    @pointercancel="onStagePointerUp"
    @keydown="onKeyDown"
    @keyup="onKeyUp"
    tabindex="-1"
  >
    <div
      class="wall-content"
      :style="{ transform: `translate(${panX}px, ${panY}px) scale(${scale})` }"
    >
      <div
        v-for="item in visibleShots"
        :key="item.shot.id"
        class="wall-card"
        :class="{ dragging: draggingId === item.shot.id }"
        :style="{ left: `${item.x}px`, top: `${item.y}px`, width: `${CARD_W}px` }"
        @pointerdown="onCardPointerDown($event, item.shot)"
        @click="onCardClick(item.shot)"
        @dblclick="onCardDblClick(item.shot)"
      >
        <div class="wall-thumb">
          <img :src="item.shot.thumbnail" :alt="item.shot.title" draggable="false" />
        </div>
        <div class="wall-meta">
          <b>#{{ String(item.shot.index).padStart(2, '0') }}</b>
          <span v-if="item.shot.shotSize" class="wall-chip">{{ item.shot.shotSize }}</span>
          <span v-if="item.shot.cameraMethod" class="wall-chip">{{ item.shot.cameraMethod }}</span>
          <span class="wall-dur">{{ fmtDuration(item.shot.durationMs) }}</span>
        </div>
      </div>
    </div>

    <div class="wall-hud">
      <button type="button" class="wall-hud-btn" aria-label="缩小" @click.stop="zoomBy(1 / 1.2)">−</button>
      <span class="wall-zval">{{ Math.round(scale * 100) }}%</span>
      <button type="button" class="wall-hud-btn" aria-label="放大" @click.stop="zoomBy(1.2)">+</button>
      <button type="button" class="wall-hud-btn" aria-label="复位（Ctrl+0）" @click.stop="resetView">⌂</button>
    </div>
    <div class="wall-hint">滚轮缩放（锚点=光标） · ALT+滚轮/两指横滑 平移 · 空格/中键拖拽抓手 · 双击卡片回到时间线定位 · Ctrl+0 复位</div>
    <button type="button" class="wall-close" aria-label="关闭分镜墙" @click="emit('close')">×</button>
  </section>
</template>

<style scoped>
.wall-stage {
  /* 覆盖 workbench 区（避开 40px 顶栏与 24px 状态栏），视频 HWND 已由 overlayOpen 降层 */
  position: fixed;
  top: 40px;
  bottom: 24px;
  left: 0;
  right: 0;
  z-index: 60;
  overflow: hidden;
  background:
    radial-gradient(circle at 24px 24px, rgba(148, 163, 184, 0.14) 1px, transparent 1.4px) 0 0 / 24px 24px,
    var(--bg-deep, #0a0e16);
  cursor: grab;
  outline: none;
}

.wall-stage.grabbing {
  cursor: grabbing;
}

.wall-content {
  position: absolute;
  inset: 0;
  transform-origin: 0 0;
  will-change: transform;
}

.wall-card {
  position: absolute;
  border: 1px solid var(--border, #2a3a55);
  border-radius: 10px;
  overflow: hidden;
  background: var(--bg-panel, #131a26);
  cursor: pointer;
  user-select: none;
}

.wall-card:hover {
  border-color: var(--blue-hi, #5aa2ff);
}

.wall-card.dragging {
  box-shadow: 0 12px 30px rgba(0, 0, 0, 0.55);
  z-index: 5;
}

.wall-thumb {
  height: 116px;
  background: #0d1420;
}

.wall-thumb img {
  display: block;
  width: 100%;
  height: 100%;
  object-fit: cover;
  pointer-events: none;
}

.wall-meta {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 5px 8px;
  font-size: 11px;
  color: var(--text-muted, #93a4bd);
}

.wall-meta b {
  color: var(--text-soft, #e6edf7);
  font-weight: 500;
}

.wall-chip {
  background: var(--surface-2, #182233);
  border-radius: 4px;
  padding: 0 5px;
  white-space: nowrap;
}

.wall-dur {
  margin-left: auto;
  font-variant-numeric: tabular-nums;
}

.wall-hud {
  position: absolute;
  left: 12px;
  bottom: 12px;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 8px;
  border: 1px solid var(--border, #2a3a55);
  border-radius: 8px;
  background: rgba(13, 20, 32, 0.85);
}

.wall-hud-btn {
  width: 24px;
  height: 24px;
  border: 1px solid var(--border, #2a3a55);
  border-radius: 6px;
  background: var(--surface-2, #182233);
  color: inherit;
  cursor: pointer;
  font-size: 13px;
  line-height: 1;
}

.wall-zval {
  min-width: 38px;
  text-align: center;
  font-size: 11px;
  color: var(--text-muted, #93a4bd);
  font-variant-numeric: tabular-nums;
}

.wall-hint {
  position: absolute;
  left: 12px;
  top: 10px;
  padding: 4px 10px;
  border: 1px solid var(--border, #2a3a55);
  border-radius: 8px;
  background: rgba(13, 20, 32, 0.72);
  color: var(--text-muted, #93a4bd);
  font-size: 11px;
  max-width: calc(100% - 24px);
}

.wall-close {
  position: absolute;
  right: 12px;
  top: 10px;
  width: 30px;
  height: 30px;
  border: 1px solid var(--border, #2a3a55);
  border-radius: 8px;
  background: rgba(13, 20, 32, 0.85);
  color: inherit;
  font-size: 16px;
  cursor: pointer;
}
</style>
