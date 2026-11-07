<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import type {
  WallEdge,
  WallEdgeKind,
  WallGroup,
  WallLayoutItem,
  WallViewState,
} from '../../../shared/types';
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
const edges = ref<WallEdge[]>([]);
const groups = ref<WallGroup[]>([]);
const selectedIds = ref<Set<string>>(new Set());
const pendingEdge = ref<{ from: string; x: number; y: number } | null>(null);
const edgeHint = ref('');
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
  void reloadGraph();
  window.addEventListener('resize', onWindowResize);
});

async function reloadGraph(): Promise<void> {
  if (!props.projectId) return;
  const [e, g] = await Promise.all([
    window.api.wall.listEdges({ projectId: props.projectId }),
    window.api.wall.listGroups({ projectId: props.projectId }),
  ]);
  if (e.ok) edges.value = e.data;
  if (g.ok) groups.value = g.data;
}

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

/* ---------- 连线渲染（世界坐标，SVG 曲线 + 箭头） ---------- */
const CARDW = 220;
const cardCenter = (id: string): { x: number; y: number } | null => {
  const pos = positions.value.get(id);
  return pos ? { x: pos.x + CARDW, y: pos.y + CARD_H / 2 + 10 } : null;
};

function edgePath(fromId: string, toId: string): string {
  const a = cardCenter(fromId);
  const b = cardCenter(toId);
  if (!a || !b) return '';
  const mx = (a.x + b.x) / 2;
  return `M ${a.x} ${a.y} C ${mx} ${a.y}, ${mx} ${b.y}, ${b.x} ${b.y}`;
}

const edgePaths = computed(() =>
  edges.value
    .map((e) => ({ e, d: edgePath(e.fromShotId, e.toShotId) }))
    .filter((item) => item.d !== ''),
);

const edgeMidpoints = computed(() =>
  edgePaths.value.map((item) => {
    const a = cardCenter(item.e.fromShotId);
    const b = cardCenter(item.e.toShotId);
    if (!a || !b) return null;
    return { e: item.e, x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  }).filter((item): item is NonNullable<typeof item> => item !== null),
);

const groupBoxes = computed(() =>
  groups.value
    .map((g) => {
      const pts = g.shotIds.map((id) => positions.value.get(id)).filter(Boolean) as Array<{
        x: number;
        y: number;
      }>;
      if (pts.length === 0) return null;
      const x = Math.min(...pts.map((p) => p.x)) - 16;
      const y = Math.min(...pts.map((p) => p.y)) - 16;
      const w = Math.max(...pts.map((p) => p.x)) + CARD_W - x + 16;
      const h = Math.max(...pts.map((p) => p.y)) + CARD_H + 40 - y + 16;
      return { g, x, y, w, h };
    })
    .filter((item): item is NonNullable<typeof item> => item !== null),
);

async function removeEdge(fromShotId: string, toShotId: string): Promise<void> {
  if (!props.projectId) return;
  const result = await window.api.wall.removeEdge({
    projectId: props.projectId,
    fromShotId,
    toShotId,
  });
  if (result.ok) {
    edges.value = edges.value.filter(
      (e) => !(e.fromShotId === fromShotId && e.toShotId === toShotId),
    );
  } else {
    edgeHint.value = result.error.message;
    setTimeout(() => (edgeHint.value = ''), 2400);
  }
}

/* ---------- 端口拖线（1.2 防误触：拖动距离超 1.2 卡宽并落在目标卡上才建立） ---------- */
let edgeDrag: { from: string; moved: boolean } | null = null;
const edgeDragFrom = ref<string | null>(null);

function onPortDown(event: PointerEvent, shotId: string): void {
  event.stopPropagation();
  if (event.button !== 0) return;
  edgeDrag = { from: shotId, moved: false };
  edgeDragFrom.value = shotId;
  pendingEdge.value = { from: shotId, x: 0, y: 0 };
  const stage = stageEl.value;
  stage?.setPointerCapture(event.pointerId);
  const move = (ev: PointerEvent): void => {
    const rect = stage?.getBoundingClientRect();
    if (!rect || !edgeDrag) return;
    const wx = (ev.clientX - rect.left - panX.value) / scale.value;
    const wy = (ev.clientY - rect.top - panY.value) / scale.value;
    edgeDrag.moved = true;
    pendingEdge.value = { from: shotId, x: wx, y: wy };
  };
  const up = async (ev: PointerEvent): Promise<void> => {
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
    const from = edgeDrag?.from ?? shotId;
    edgeDrag = null;
    edgeDragFrom.value = null;
    pendingEdge.value = null;
    if (!props.projectId) return;
    const rect = stage?.getBoundingClientRect();
    if (!rect) return;
    const wx = (ev.clientX - rect.left - panX.value) / scale.value;
    const wy = (ev.clientY - rect.top - panY.value) / scale.value;
    const target = laidShots.value.find(
      (item) => wx >= item.x && wx <= item.x + CARD_W && wy >= item.y && wy <= item.y + CARD_H,
    );
    if (!target || target.shot.id === from) return;
    // 防误触 1.2：起点卡中心到释放点距离需超过 1.2 卡宽
    const start = cardCenter(from);
    const dist = start ? Math.hypot(wx - start.x, wy - start.y) : 0;
    if (dist < CARDW * 1.2) return;
    const kind: WallEdgeKind = ev.shiftKey ? 'dash' : 'solid';
    const result = await window.api.wall.addEdge({
      projectId: props.projectId,
      fromShotId: from,
      toShotId: target.shot.id,
      kind,
    });
    if (result.ok) {
      edges.value = edges.value.filter(
        (e) => !(e.fromShotId === from && e.toShotId === target.shot.id),
      );
      edges.value.push(result.data);
    } else {
      edgeHint.value = result.error.message;
      setTimeout(() => (edgeHint.value = ''), 2400);
    }
  };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
}

/* ---------- 分组：Shift 多选 → 成组（跨组边由仓储自动断） / 解散 ---------- */
function toggleSelect(shotId: string, event: PointerEvent): void {
  if (!event.shiftKey) {
    selectedIds.value = new Set();
    return;
  }
  const next = new Set(selectedIds.value);
  if (next.has(shotId)) next.delete(shotId);
  else next.add(shotId);
  selectedIds.value = next;
}

async function createGroupFromSelection(): Promise<void> {
  const ids = [...selectedIds.value];
  if (!props.projectId || ids.length < 2) return;
  const result = await window.api.wall.createGroup({
    projectId: props.projectId,
    name: `场景 ${groups.value.length + 1}`,
    shotIds: ids,
  });
  if (result.ok) {
    selectedIds.value = new Set();
    await reloadGraph();
  } else {
    edgeHint.value = result.error.message;
    setTimeout(() => (edgeHint.value = ''), 2400);
  }
}

async function dissolveGroup(groupId: string): Promise<void> {
  if (!props.projectId) return;
  const result = await window.api.wall.dissolveGroup({ projectId: props.projectId, groupId });
  if (result.ok) await reloadGraph();
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
      // 手机图标式让位：与被拖卡同一水平带（±48px）的其他卡按 x 排序重排
      const dragged = positions.value.get(shot.id)!;
      const band = laidShots.value.filter(
        (item) => item.shot.id !== shot.id && Math.abs(item.y - dragged.y) < 48,
      );
      const updates: WallLayoutItem[] = [{ shotId: shot.id, x: dragged.x, y: dragged.y }];
      const others = band.sort((a, b) => a.x - b.x);
      let cursor = dragged.x + CARD_W + GAP;
      for (const other of others) {
        if (other.x < cursor) {
          positions.value.set(other.shot.id, { x: cursor, y: other.y });
          updates.push({ shotId: other.shot.id, x: cursor, y: other.y });
        }
        cursor = Math.max(cursor, positions.value.get(other.shot.id)!.x) + CARD_W + GAP;
      }
      positions.value = new Map(positions.value);
      emit('layoutChange', updates);
    }
  };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
}

function onCardClick(shot: WorkspaceShot, event: PointerEvent): void {
  if (dragMoved) {
    dragMoved.value = false;
    return;
  }
  toggleSelect(shot.id, event);
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
      <svg class="wall-edges" :viewBox="`0 0 ${stageW} ${stageH}`" preserveAspectRatio="none">
        <path
          v-for="item in edgePaths"
          :key="`${item.e.fromShotId}->${item.e.toShotId}`"
          :d="item.d"
          fill="none"
          :stroke="item.e.kind === 'solid' ? '#5aa2ff' : '#eab308'"
          stroke-width="2"
          :stroke-dasharray="item.e.kind === 'dash' ? '7 5' : undefined"
          marker-end="url(#wall-arrow)"
        />
        <defs>
          <marker id="wall-arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto">
            <path d="M0 0L8 4L0 8z" fill="#5aa2ff" />
          </marker>
        </defs>
        <line
          v-if="pendingEdge && edgeDragFrom"
          :x1="cardCenter(edgeDragFrom)?.x ?? 0"
          :y1="cardCenter(edgeDragFrom)?.y ?? 0"
          :x2="pendingEdge.x"
          :y2="pendingEdge.y"
          stroke="#eab308"
          stroke-width="2"
          stroke-dasharray="5 4"
        />
      </svg>
      <div
        v-for="item in groupBoxes"
        :key="item.g.groupId"
        class="wall-group-box"
        :style="{ left: `${item.x}px`, top: `${item.y}px`, width: `${item.w}px`, height: `${item.h}px` }"
      >
        <span class="wall-group-label">{{ item.g.name }}</span>
        <button
          type="button"
          class="wall-group-dissolve"
          title="解散分组"
          @click.stop="dissolveGroup(item.g.groupId)"
        >
          ×
        </button>
      </div>
      <button
        v-for="item in edgeMidpoints"
        :key="`del-${item.e.fromShotId}->${item.e.toShotId}`"
        type="button"
        class="wall-edge-del"
        title="删除这条连线"
        :style="{ left: `${item.x - 8}px`, top: `${item.y - 8}px` }"
        @click.stop="removeEdge(item.e.fromShotId, item.e.toShotId)"
      >
        ×
      </button>
      <div
        v-for="item in visibleShots"
        :key="item.shot.id"
        class="wall-card"
        :class="{ dragging: draggingId === item.shot.id, selected: selectedIds.has(item.shot.id) }"
        :style="{ left: `${item.x}px`, top: `${item.y}px`, width: `${CARD_W}px` }"
        @pointerdown="onCardPointerDown($event, item.shot)"
        @click="onCardClick(item.shot, $event)"
        @dblclick="onCardDblClick(item.shot)"
      >
        <span class="wall-port" title="拖到另一张卡建立连线（Shift=备选虚线）" @pointerdown="onPortDown($event, item.shot.id)"></span>
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

    <div v-if="selectedIds.size >= 2" class="wall-selection">
      已选 {{ selectedIds.size }} 张
      <button type="button" @click.stop="createGroupFromSelection">成组（自动断开跨组连线）</button>
      <button type="button" @click.stop="selectedIds = new Set()">取消</button>
    </div>
    <div v-if="edgeHint" class="wall-edge-hint">{{ edgeHint }}</div>
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

.wall-edges {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  pointer-events: none;
  overflow: visible;
}

.wall-group-box {
  position: absolute;
  border: 1px solid rgba(90, 162, 255, 0.45);
  border-radius: 14px;
  background: rgba(90, 162, 255, 0.06);
  pointer-events: auto;
}

.wall-group-label {
  position: absolute;
  top: -10px;
  left: 12px;
  padding: 0 8px;
  background: var(--bg-deep, #0a0e16);
  color: var(--blue-hi, #5aa2ff);
  font-size: 11px;
}

.wall-group-dissolve {
  position: absolute;
  top: -12px;
  right: 10px;
  width: 20px;
  height: 20px;
  border: 1px solid var(--border, #2a3a55);
  border-radius: 6px;
  background: var(--surface-2, #182233);
  color: var(--text-muted, #93a4bd);
  cursor: pointer;
  font-size: 12px;
  line-height: 1;
}

.wall-edge-del {
  position: absolute;
  width: 16px;
  height: 16px;
  border: 1px solid var(--border, #2a3a55);
  border-radius: 50%;
  background: var(--surface-2, #182233);
  color: var(--text-muted, #93a4bd);
  font-size: 10px;
  line-height: 1;
  cursor: pointer;
  opacity: 0;
  transition: opacity 0.15s;
  z-index: 2;
}

.wall-edges + .wall-edge-del,
.wall-content:hover .wall-edge-del {
  opacity: 0.85;
}

.wall-edge-del:hover {
  color: #fca5a5;
  border-color: rgba(239, 68, 68, 0.5);
  opacity: 1;
}

.wall-card.selected {
  border-color: #eab308;
  box-shadow: 0 0 0 1px #eab308;
}

.wall-port {
  position: absolute;
  right: -7px;
  top: 50%;
  width: 14px;
  height: 14px;
  border: 2px solid var(--blue-hi, #5aa2ff);
  border-radius: 50%;
  background: var(--bg-deep, #0a0e16);
  transform: translateY(-50%);
  cursor: crosshair;
  opacity: 0;
  transition: opacity 0.15s;
  z-index: 3;
}

.wall-card:hover .wall-port {
  opacity: 1;
}

.wall-selection {
  position: absolute;
  left: 50%;
  bottom: 14px;
  transform: translateX(-50%);
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 10px;
  border: 1px solid var(--border, #2a3a55);
  border-radius: 8px;
  background: rgba(13, 20, 32, 0.92);
  font-size: 12px;
  z-index: 4;
}

.wall-selection button {
  height: 24px;
  padding: 0 10px;
  border: 1px solid var(--border, #2a3a55);
  border-radius: 6px;
  background: var(--surface-2, #182233);
  color: inherit;
  cursor: pointer;
  font-size: 12px;
}

.wall-edge-hint {
  position: absolute;
  top: 12px;
  left: 50%;
  transform: translateX(-50%);
  padding: 4px 12px;
  border: 1px solid rgba(239, 68, 68, 0.4);
  border-radius: 8px;
  background: rgba(30, 10, 14, 0.92);
  color: #fca5a5;
  font-size: 12px;
  z-index: 5;
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
