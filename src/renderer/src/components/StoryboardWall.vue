<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue';
import ContextMenu from './ContextMenu.vue';
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
const props = withDefaults(
  defineProps<{
    shots: WorkspaceShot[];
    viewState: WallViewState | null;
    projectId: string;
    boardMode?: boolean;
  }>(),
  { boardMode: false },
);

const emit = defineEmits<{
  close: [];
  seek: [startMs: number];
  layoutChange: [items: WallLayoutItem[]];
  viewStateChange: [view: WallViewState];
  editNode: [nodeId: string];
  createNode: [kind: 'image' | 'black' | 'white'];
  deleteNode: [nodeId: string];
  project: [];
}>();

const CARD_W = 220;
const CARD_H = 142;
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
/* S43 分镜PPT 放映 + 镜头卡标注 */
type AnnType = 'brush' | 'smear' | 'line' | 'arrow' | 'rect' | 'ellipse' | 'text' | 'mosaic';
interface Ann {
  id: string;
  type: AnnType;
  color: string;
  data: { pts?: Array<{ x: number; y: number }>; x?: number; y?: number; w?: number; h?: number; text?: string };
}
const player = ref({
  open: false,
  scope: [] as WorkspaceShot[],
  idx: 0,
  single: false,
  playing: false,
});
const annotations = ref<Map<string, Ann[]>>(new Map());
const annTool = ref<AnnType | 'select' | 'eraser'>('brush');
const annColor = ref('#ff5a5a');
const annSel = ref<Ann | null>(null);
const annDrafting = ref<{ card: WorkspaceShot; o: Ann } | null>(null);
const playerTrackEl = ref<HTMLElement | null>(null);
const playProgress = ref(0);
const playerDepths = ref<Map<string, number>>(new Map());
const ANNC = ['#ff5a5a', '#ffd23d', '#3ddc84', '#5aa2ff', '#ffffff'];
let annSeq = 1;
let playRaf = 0;
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

defineExpose({ reloadGraph });

onMounted(() => {
  measureStage();
  applyInitialState();
  ensureLayout();
  void reloadGraph();
  window.addEventListener('resize', onWindowResize);
  // capture 阶段拦截：放映打开时按键先于 App 全局快捷键（否则 Esc 会连带关掉整面墙）
  window.addEventListener('keydown', onGlobalKey, true);
  window.addEventListener('keyup', onGlobalKeyUp, true);
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

async function exportImages(): Promise<void> {
  if (!props.projectId) return;
  const result = await window.api.wall.exportImages({ projectId: props.projectId });
  if (result.ok) {
    edgeHint.value = `已按连线顺序导出 ${result.data.count} 张图片（跳过 ${result.data.skipped}）→ ${result.data.dir}`;
  } else {
    edgeHint.value = result.error.message;
  }
  setTimeout(() => (edgeHint.value = ''), 4000);
}

function onWindowResize(): void {
  measureStage();
}

function onGlobalKey(e: KeyboardEvent): void {
  if (player.value.open) {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopImmediatePropagation();
      closePlayer();
      return;
    }
    if (e.key === 'ArrowRight') {
      e.preventDefault();
      e.stopImmediatePropagation();
      playerMove(1);
      return;
    }
    if (e.key === 'ArrowLeft') {
      e.preventDefault();
      e.stopImmediatePropagation();
      playerMove(-1);
      return;
    }
    const map: Record<string, string> = {
      '1': 'brush', '2': 'smear', '3': 'line', '4': 'arrow', '5': 'rect',
      '6': 'ellipse', '7': 'text', '8': 'mosaic', '9': 'eraser', a: 'select',
    };
    const k = e.key.toLowerCase();
    if (map[k]) {
      e.preventDefault();
      e.stopImmediatePropagation();
      annTool.value = map[k] as AnnType | 'select' | 'eraser';
    }
    return;
  }
  if (e.code === 'Space') spaceDown = true;
  if (e.key === '0' && (e.ctrlKey || e.metaKey)) {
    e.preventDefault();
    resetView();
  }
  if (e.key === '+' || e.key === '=') zoomBy(1.2);
  if (e.key === '-') zoomBy(1 / 1.2);
}

function onGlobalKeyUp(e: KeyboardEvent): void {
  if (e.code === 'Space') spaceDown = false;
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
  // 0.3.2：直线连接（对齐竞品形态），端点分别在源卡右缘与目标卡左缘
  return `M ${a.x} ${a.y} L ${b.x} ${b.y}`;
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
let edgeDragSide: 'out' | 'in' = 'out';

function onPortDown(event: PointerEvent, shotId: string, side: 'out' | 'in' = 'out'): void {
  event.stopPropagation();
  if (event.button !== 0) return;
  edgeDrag = { from: shotId, moved: false };
  edgeDragSide = side;
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
    // out 端口：this -> target；in 端口：target -> this（本卡的输入来自目标卡）
    const [fromId, toId] =
      edgeDragSide === 'in' ? [target.shot.id, from] : [from, target.shot.id];
    const result = await window.api.wall.addEdge({
      projectId: props.projectId,
      fromShotId: fromId,
      toShotId: toId,
      kind,
    });
    if (result.ok) {
      edges.value = edges.value.filter(
        (e) => !(e.fromShotId === fromId && e.toShotId === toId),
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

/* ---------- S43 分镜PPT 放映 ---------- */
const ANN_TOOLS: Array<{ k: AnnType | 'select' | 'eraser'; n: string; key: string }> = [
  { k: 'brush', n: '画笔', key: '1' },
  { k: 'smear', n: '涂抹', key: '2' },
  { k: 'line', n: '直线', key: '3' },
  { k: 'arrow', n: '箭头', key: '4' },
  { k: 'rect', n: '矩形', key: '5' },
  { k: 'ellipse', n: '圆', key: '6' },
  { k: 'text', n: '文字', key: '7' },
  { k: 'mosaic', n: '马赛克', key: '8' },
  { k: 'eraser', n: '橡皮', key: '9' },
  { k: 'select', n: '选择', key: 'A' },
];

/** 作用域：组内沿边可达（不跨分组）；无组=全画布连通分量；孤卡=单张 */
function playerScope(startId: string): WorkspaceShot[] {
  const g = groups.value.find((item) => item.shotIds.includes(startId));
  const poolIds = g ? g.shotIds : props.shots.map((item) => item.id);
  const pool = new Set(poolIds);
  const adj = new Map<string, Array<string>>();
  for (const id of poolIds) adj.set(id, []);
  for (const e of edges.value) {
    if (pool.has(e.fromShotId) && pool.has(e.toShotId)) {
      adj.get(e.fromShotId)?.push(e.toShotId);
      adj.get(e.toShotId)?.push(e.fromShotId);
    }
  }
  const seen = new Set<string>([startId]);
  const order: string[] = [startId];
  let frontier: string[] = [startId];
  while (frontier.length > 0) {
    const next: string[] = [];
    for (const cur of frontier) {
      for (const nb of adj.get(cur) ?? []) {
        if (!seen.has(nb)) {
          seen.add(nb);
          order.push(nb);
          next.push(nb);
        }
      }
    }
    frontier = next;
  }
  // 0.3.1 投影：记录 BFS 深度（层）供多宫格/多轨呈现
  playerDepths.value = new Map<string, number>();
  playerDepths.value.set(startId, 0);
  frontier = [startId];
  let depth = 0;
  while (frontier.length > 0) {
    depth += 1;
    const next: string[] = [];
    for (const cur of frontier) {
      for (const nb of adj.get(cur) ?? []) {
        if (!seen.has(nb) && !playerDepths.value.has(nb)) {
          playerDepths.value.set(nb, depth);
          next.push(nb);
        }
        if (!seen.has(nb)) seen.add(nb);
      }
    }
    frontier = next;
  }
  return order
    .map((id) => props.shots.find((item) => item.id === id))
    .filter((item): item is WorkspaceShot => item !== undefined);
}

/** 层分组：scope 索引按深度分段（同层=并行节点 → 多宫格） */
const playerLayers = computed<Array<number[]>>(() => {
  const layers: Array<number[]> = [];
  let last: number | null = null;
  for (const [i, shot] of player.value.scope.entries()) {
    const depth = playerDepths.value.get(shot.id) ?? 0;
    if (last === null || depth !== last) {
      layers.push([i]);
      last = depth;
    } else {
      layers[layers.length - 1].push(i);
    }
  }
  return layers;
});

const curLayerIdxs = computed<number[]>(() => {
  for (const layer of playerLayers.value) {
    if (layer.includes(player.value.idx)) return layer;
  }
  return [player.value.idx];
});

/** 多轨条：按 solid 出边展开的链（每链一轨，块宽∝时长） */
const trackRows = computed(() => {
  const rows: Array<Array<{ id: string; dur: number }>> = [];
  const visited = new Set<string>();
  const outMap = new Map<string, Array<{ to: string; dur: number }>>();
  for (const shot of player.value.scope) outMap.set(shot.id, []);
  for (const e of edges.value) {
    if (outMap.has(e.fromShotId) && player.value.scope.some((s) => s.id === e.toShotId)) {
      const target = player.value.scope.find((s) => s.id === e.toShotId);
      if (target && e.kind === 'solid') {
        outMap.get(e.fromShotId)?.push({ to: e.toShotId, dur: target.durationMs });
      }
    }
  }
  for (const shot of player.value.scope) {
    if (visited.has(shot.id)) continue;
    if (edges.value.some((e) => e.toShotId === shot.id && player.value.scope.some((s) => s.id === e.fromShotId))) {
      continue;
    }
    const row: Array<{ id: string; dur: number }> = [];
    let cursor: string | null = shot.id;
    while (cursor && !visited.has(cursor)) {
      visited.add(cursor);
      const node = player.value.scope.find((s) => s.id === cursor);
      row.push({ id: cursor, dur: node?.durationMs ?? 3000 });
      cursor = outMap.get(cursor)?.[0]?.to ?? null;
    }
    if (row.length > 0) rows.push(row);
  }
  return rows;
});

async function openPlayer(startId: string): Promise<void> {
  // 放映前刷新连线（可能被 MCP/其他入口修改）
  if (props.projectId) {
    const fresh = await window.api.wall.listEdges({ projectId: props.projectId });
    if (fresh.ok) edges.value = fresh.data;
  }
  const scope = playerScope(startId);
  if (scope.length === 0) return;
  player.value = {
    open: true,
    scope,
    idx: Math.max(0, scope.findIndex((item) => item.id === startId)),
    single: false,
    playing: false,
  };
  annSel.value = null;
  playProgress.value = 0;
  const result = await window.api.wall.listAnnotations({
    projectId: props.projectId,
    shotIds: scope.map((item) => item.id),
  });
  if (result.ok) annotations.value = new Map(Object.entries(result.data));
}

const playerScopeLabel = computed(() => {
  if (player.value.scope.length === 0) return '';
  const cur = player.value.scope[player.value.idx];
  const g = groups.value.find((item) => item.shotIds.includes(cur.id));
  return g ? '作用域：' + g.name + '（组内 ' + player.value.scope.length + ' 张，不跨组）' : '作用域：孤立卡（仅此一张）';
});

function closePlayer(): void {
  stopPlay();
  player.value.open = false;
  for (const shot of player.value.scope) refreshThumbAnn(shot.id);
}

function playerMove(d: number): void {
  const n = player.value.idx + d;
  if (n < 0 || n >= player.value.scope.length) return;
  player.value.idx = n;
  annSel.value = null;
  stopPlay();
}

function stopPlay(): void {
  player.value.playing = false;
  if (playRaf) cancelAnimationFrame(playRaf);
  playRaf = 0;
  playProgress.value = 0;
}
function startPlay(): void {
  const shot = player.value.scope[player.value.idx];
  if (!shot) return;
  playT0 = performance.now();
  const dur = Math.max(400, shot.durationMs);
  const tick = (t: number): void => {
    if (!player.value.playing) return;
    const k = Math.min(1, (t - playT0) / dur);
    playProgress.value = k;
    if (k < 1) {
      playRaf = requestAnimationFrame(tick);
    } else if (player.value.idx < player.value.scope.length - 1) {
      player.value.idx += 1;
      annSel.value = null;
      startPlay();
    } else {
      stopPlay();
    }
  };
  playRaf = requestAnimationFrame(tick);
}
let playT0 = 0;

/* ---------- 标注（归一化坐标，宿主=镜头卡；马赛克置底渲染；保存后墙卡回显） ---------- */
function annListOf(shotId: string): Ann[] {
  let list = annotations.value.get(shotId);
  if (!list) {
    list = [];
    annotations.value.set(shotId, list);
  }
  return list;
}
function annMarkup(shotId: string, interactive: boolean): string {
  const list = annListOf(shotId);
  const mosaic = list.filter((o) => o.type === 'mosaic');
  const rest = list.filter((o) => o.type !== 'mosaic');
  let out = '';
  const pts2str = (pts: Array<{ x: number; y: number }>): string =>
    pts.map((p) => p.x.toFixed(2) + ',' + p.y.toFixed(2)).join(' ');
  const wrap = (o: Ann, inner: string): string =>
    '<g data-oid="' + o.id + '"' + (interactive && annSel.value && annSel.value.id === o.id ? ' class="sbg-sel"' : '') + '>' + inner + '</g>';
  for (const o of [...mosaic, ...rest]) {
    const d = o.data;
    if (o.type === 'mosaic' && d.x !== undefined && d.y !== undefined && d.w !== undefined && d.h !== undefined) {
      let cells = '';
      const n = 5;
      const r = 3;
      for (let i = 0; i < n; i++) {
        for (let j = 0; j < r; j++) {
          const hue = (Math.round(d.x * 7) + i * 13 + j * 29) % 360;
          cells += '<rect x="' + (d.x + (i * d.w) / n).toFixed(2) + '" y="' + (d.y + (j * d.h) / r).toFixed(2) + '" width="' + (d.w / n + 0.06).toFixed(2) + '" height="' + (d.h / r + 0.06).toFixed(2) + '" fill="hsl(' + hue + ',18%,' + (30 + ((i + j) % 3) * 13) + '%)"/>';
        }
      }
      out += wrap(o, cells + '<rect x="' + d.x + '" y="' + d.y + '" width="' + d.w + '" height="' + d.h + '" fill="none" stroke="rgba(255,255,255,.4)" stroke-width=".35" vector-effect="non-scaling-stroke"/>');
    } else if ((o.type === 'brush' || o.type === 'smear') && d.pts) {
      out += wrap(o, '<polyline points="' + pts2str(d.pts) + '" fill="none" stroke="' + o.color + '" stroke-width="' + (o.type === 'smear' ? 3.4 : 1.5) + '" stroke-linecap="round" stroke-linejoin="round"/>');
    } else if (o.type === 'line' && d.pts && d.pts.length >= 2) {
      out += wrap(o, '<line x1="' + d.pts[0].x + '" y1="' + d.pts[0].y + '" x2="' + d.pts[1].x + '" y2="' + d.pts[1].y + '" stroke="' + o.color + '" stroke-width="1.7"/>');
    } else if (o.type === 'arrow' && d.pts && d.pts.length >= 2) {
      const a = d.pts[0];
      const b = d.pts[1];
      const ang = Math.atan2(b.y - a.y, b.x - a.x);
      const L = 2.6;
      const Wd = 1.4;
      const p1 = (b.x - L * Math.cos(ang) + Wd * Math.sin(ang)).toFixed(2) + ',' + (b.y - L * Math.sin(ang) - Wd * Math.cos(ang)).toFixed(2);
      const p2 = (b.x - L * Math.cos(ang) - Wd * Math.sin(ang)).toFixed(2) + ',' + (b.y - L * Math.sin(ang) + Wd * Math.cos(ang)).toFixed(2);
      out += wrap(o, '<line x1="' + a.x + '" y1="' + a.y + '" x2="' + b.x + '" y2="' + b.y + '" stroke="' + o.color + '" stroke-width="1.7"/><polygon points="' + b.x + ',' + b.y + ' ' + p1 + ' ' + p2 + '" fill="' + o.color + '"/>');
    } else if (o.type === 'rect' && d.pts && d.pts.length >= 2) {
      out += wrap(o, '<rect x="' + Math.min(d.pts[0].x, d.pts[1].x) + '" y="' + Math.min(d.pts[0].y, d.pts[1].y) + '" width="' + Math.abs(d.pts[1].x - d.pts[0].x) + '" height="' + Math.abs(d.pts[1].y - d.pts[0].y) + '" fill="none" stroke="' + o.color + '" stroke-width="1.7"/>');
    } else if (o.type === 'ellipse' && d.pts && d.pts.length >= 2) {
      out += wrap(o, '<ellipse cx="' + (d.pts[0].x + d.pts[1].x) / 2 + '" cy="' + (d.pts[0].y + d.pts[1].y) / 2 + '" rx="' + Math.abs(d.pts[1].x - d.pts[0].x) / 2 + '" ry="' + Math.abs(d.pts[1].y - d.pts[0].y) / 2 + '" fill="none" stroke="' + o.color + '" stroke-width="1.7"/>');
    } else if (o.type === 'text' && d.pts && d.pts.length >= 1) {
      out += wrap(o, '<text x="' + d.pts[0].x + '" y="' + d.pts[0].y + '" font-size="3.4" fill="' + o.color + '">' + (d.text ?? '').replace(/</g, '&lt;') + '</text>');
    }
  }
  return out;
}
function refreshThumbAnn(shotId: string): void {
  const el = document.getElementById('tann-' + shotId);
  if (!el) return;
  el.innerHTML = '<svg class="sbg-tann" viewBox="0 0 100 56.25" preserveAspectRatio="none">' + annMarkup(shotId, false) + '</svg>';
}
function persistAnn(shotId: string): void {
  const list = annListOf(shotId);
  void window.api.wall
    .saveAnnotations({ projectId: props.projectId, shotId, items: list.map((o) => ({ type: o.type, color: o.color, data: o.data })) })
    .then(function () {
      refreshThumbAnn(shotId);
    });
}

function curAnnSvg(): SVGElement | null {
  const slide = playerTrackEl.value ? playerTrackEl.value.children[player.value.idx] : null;
  return slide ? ((slide as HTMLElement).querySelector('.sbg-annlayer') as SVGElement | null) : null;
}
function annSlidePos(event: PointerEvent, svg: SVGElement): { x: number; y: number } {
  const rect = svg.getBoundingClientRect();
  return { x: ((event.clientX - rect.left) / rect.width) * 100, y: ((event.clientY - rect.top) / rect.height) * 56.25 };
}
function onAnnPointerDown(event: PointerEvent): void {
  const svg = curAnnSvg();
  const shot = player.value.scope[player.value.idx];
  if (!svg || !shot) return;
  const p0 = annSlidePos(event, svg);
  if (annTool.value === 'select' || annTool.value === 'eraser') {
    const hit = (event.target as Element).closest ? ((event.target as Element).closest('[data-oid]') as SVGElement | null) : null;
    const oid = hit ? hit.dataset.oid : null;
    const o = oid ? annListOf(shot.id).find(function (x) { return x.id === oid; }) : null;
    if (o) {
      if (annTool.value === 'eraser') {
        annotations.value.set(shot.id, annListOf(shot.id).filter(function (x) { return x !== o; }));
        persistAnn(shot.id);
      } else {
        annSel.value = annSel.value && annSel.value.id === o.id ? null : o;
      }
    } else if (annTool.value === 'select' && annSel.value) {
      annSel.value = null;
    }
    return;
  }
  if (annTool.value === 'text') {
    annListOf(shot.id).push({ id: 'a' + Date.now() + annSeq++, type: 'text', color: annColor.value, data: { pts: [p0], text: '标注 ' + annSeq } });
    persistAnn(shot.id);
    return;
  }
  if (annTool.value === 'mosaic') {
    annListOf(shot.id).push({ id: 'a' + Date.now() + annSeq++, type: 'mosaic', color: annColor.value, data: { x: p0.x - 8, y: p0.y - 4, w: 16, h: 8 } });
    persistAnn(shot.id);
    return;
  }
  const o: Ann = { id: 'a' + Date.now() + annSeq++, type: annTool.value as AnnType, color: annColor.value, data: { pts: [p0, p0] } };
  annListOf(shot.id).push(o);
  annDrafting.value = { card: shot, o: o };
  try {
    svg.setPointerCapture(event.pointerId);
  } catch {
    /* ignore */
  }
}
function onAnnPointerMove(event: PointerEvent): void {
  const drafting = annDrafting.value;
  if (!drafting) return;
  const svg = curAnnSvg();
  if (!svg) return;
  const p = annSlidePos(event, svg);
  const o = drafting.o;
  if ((o.type === 'brush' || o.type === 'smear') && o.data.pts) {
    const pts = o.data.pts;
    if (pts.length === 2 && pts[0].x === pts[1].x && pts[0].y === pts[1].y) o.data.pts = [pts[0], p];
    else pts.push(p);
  } else if (o.data.pts && o.data.pts.length >= 2) {
    o.data.pts[1] = p;
  }
  refreshPlayerAnn(drafting.card);
}
function onAnnPointerUp(): void {
  const drafting = annDrafting.value;
  if (!drafting) return;
  const o = drafting.o;
  if (o.type !== 'brush' && o.type !== 'smear' && o.data.pts && o.data.pts.length >= 2) {
    if (Math.abs(o.data.pts[0].x - o.data.pts[1].x) < 0.4 && Math.abs(o.data.pts[0].y - o.data.pts[1].y) < 0.4) {
      annotations.value.set(drafting.card.id, annListOf(drafting.card.id).filter(function (x) { return x !== o; }));
    }
  }
  annDrafting.value = null;
  persistAnn(drafting.card.id);
}
function refreshPlayerAnn(card: WorkspaceShot): void {
  const svg = curAnnSvg();
  if (svg && svg.dataset.card === card.id) svg.innerHTML = annMarkup(card.id, true);
}

const playerTrackStyle = computed(() => {
  const slide = playerTrackEl.value?.children[0] as HTMLElement | undefined;
  const sw = slide ? slide.offsetWidth + 24 : 0;
  const stW = playerTrackEl.value?.parentElement?.clientWidth ?? 0;
  if (!sw || !stW) return {};
  const off = stW / 2 - sw / 2 - player.value.idx * sw;
  return { transform: `translateX(${off}px)` };
});

/* ---------- 分组：Shift 多选 → 成组（跨组边由仓储自动断） / 解散 ---------- */
function toggleSelect(shotId: string, event: PointerEvent): void {
  const next = new Set(selectedIds.value);
  if (event.ctrlKey || event.metaKey) {
    // Ctrl/Cmd：切换选中
    if (next.has(shotId)) next.delete(shotId);
    else next.add(shotId);
  } else if (event.shiftKey) {
    // Shift：追加多选
    next.add(shotId);
  } else {
    next.clear();
  }
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

/* ---------- 0.3.1 整理节点 / 撤销 / 右键菜单 ---------- */
const ctxMenu = reactive({
  visible: false,
  x: 0,
  y: 0,
  items: [] as Array<{ label: string; danger?: boolean; disabled?: boolean; action: () => void }>,
});
const chainStartId = ref<string | null>(null);
let undoSnapshot: WallLayoutItem[] | null = null;

function snapshotLayout(): void {
  undoSnapshot = [...positions.value.entries()].map(([id, p]) => ({ shotId: id, x: p.x, y: p.y }));
}

function restoreLayout(): void {
  if (!undoSnapshot) return;
  for (const item of undoSnapshot) {
    if (positions.value.has(item.shotId)) positions.value.set(item.shotId, { x: item.x, y: item.y });
  }
  positions.value = new Map(positions.value);
  emit('layoutChange', undoSnapshot.filter((item) => positions.value.has(item.shotId)));
  undoSnapshot = null;
}

/** 断开某卡全部连线 */
async function disconnectAll(shotId: string): Promise<void> {
  if (!props.projectId) return;
  const related = edges.value.filter((e) => e.fromShotId === shotId || e.toShotId === shotId);
  for (const e of related) {
    await window.api.wall.removeEdge({
      projectId: props.projectId,
      fromShotId: e.fromShotId,
      toShotId: e.toShotId,
    });
  }
  edges.value = edges.value.filter((e) => !related.includes(e));
}

function selectAllNodes(): void {
  selectedIds.value = new Set(props.shots.map((shot) => shot.id));
}

function openNodeMenuButton(): void {
  const sel = [...selectedIds.value];
  const rect = stageEl.value?.getBoundingClientRect();
  const x = rect ? rect.left + 90 : 120;
  const y = rect ? rect.bottom - 160 : 400;
  if (sel.length === 1) {
    openMenuAt(x, y, sel[0]);
    return;
  }
  openMenuAt(x, y, null);
}

function zoomToFit(): void {
  if (positions.value.size === 0) return;
  const pts = [...positions.value.values()];
  const minX = Math.min(...pts.map((p) => p.x)) - GAP;
  const minY = Math.min(...pts.map((p) => p.y)) - GAP;
  const maxX = Math.max(...pts.map((p) => p.x + CARD_W)) + GAP;
  const maxY = Math.max(...pts.map((p) => p.y + CARD_H + 30)) + GAP;
  const sw = stageW.value;
  const sh = stageH.value;
  scale.value = clampScale(Math.min(sw / (maxX - minX), sh / (maxY - minY)));
  panX.value = -minX * scale.value + (sw - (maxX - minX) * scale.value) / 2;
  panY.value = -minY * scale.value + (sh - (maxY - minY) * scale.value) / 2;
  emitViewState();
}

/** 整理节点：连线链拓扑成行（solid 优先），未连线按镜号网格排到下方独立区 */
function organizeNodes(): void {
  snapshotLayout();
  const visited = new Set<string>();
  const chains: string[][] = [];
  const outMap = new Map<string, Array<{ to: string; kind: string }>>();
  for (const shot of props.shots) outMap.set(shot.id, []);
  for (const e of edges.value) outMap.get(e.fromShotId)?.push({ to: e.toShotId, kind: e.kind });
  const incoming = new Set(edges.value.map((e) => e.toShotId));
  const starts = props.shots
    .filter((shot) => !incoming.has(shot.id))
    .sort((a, b) => { if (a.id === chainStartId.value) return -1; if (b.id === chainStartId.value) return 1; return a.index - b.index; });
  for (const shot of starts) {
    if (visited.has(shot.id)) continue;
    const chain: string[] = [];
    let cursor: string | null = shot.id;
    while (cursor && !visited.has(cursor)) {
      visited.add(cursor);
      chain.push(cursor);
      const outs: Array<{ to: string; kind: string }> = (outMap.get(cursor) ?? [])
        .slice()
        .sort((a) => (a.kind === 'solid' ? -1 : 1));
      cursor = outs.length > 0 ? outs[0].to : null;
    }
    if (chain.length >= 1) chains.push(chain);
  }
  for (const shot of props.shots) {
    if (visited.has(shot.id)) continue;
    const chain: string[] = [];
    let cursor: string | null = shot.id;
    while (cursor && !visited.has(cursor)) {
      visited.add(cursor);
      chain.push(cursor);
      const outs: Array<{ to: string; kind: string }> = (outMap.get(cursor) ?? []).filter(
        (o) => !visited.has(o.to),
      );
      cursor = outs.length > 0 ? outs[0].to : null;
    }
    chains.push(chain);
  }
  const rowH = CARD_H + 64;
  const perRow = Math.max(1, Math.floor((stageW.value - GAP) / (CARD_W + GAP)));
  let row = 0;
  const updates: WallLayoutItem[] = [];
  for (const chain of chains) {
    chain.forEach((id, i) => {
      const x = GAP + (i % perRow) * (CARD_W + GAP);
      const y = GAP + row * rowH;
      positions.value.set(id, { x, y });
      updates.push({ shotId: id, x, y });
      if (i === chain.length - 1 || (i + 1) % perRow === 0) row += 1;
    });
  }
  const unlinked = props.shots
    .filter((shot) => !edges.value.some((e) => e.fromShotId === shot.id || e.toShotId === shot.id))
    .sort((a, b) => a.index - b.index);
  const startY = GAP + row * rowH + 80;
  unlinked.forEach((shot, i) => {
    const x = GAP + (i % perRow) * (CARD_W + GAP);
    const y = startY + Math.floor(i / perRow) * rowH;
    positions.value.set(shot.id, { x, y });
    updates.push({ shotId: shot.id, x, y });
  });
  positions.value = new Map(positions.value);
  emit('layoutChange', updates);
}

async function removeNodeFromWall(shotId: string): Promise<void> {
  positions.value.delete(shotId);
  positions.value = new Map(positions.value);
  selectedIds.value.delete(shotId);
}

function openWallContextMenu(event: MouseEvent, shotId: string | null): void {
  openMenuAt(event.clientX, event.clientY, shotId);
}

/** 0.3.3：按钮召唤菜单（右键失效时的可靠入口） */
function openMenuAt(x: number, y: number, shotId: string | null): void {
  const items: Array<{ label: string; danger?: boolean; disabled?: boolean; action: () => void }> = [];
  if (shotId) {
    const hasEdges = edges.value.some((e) => e.fromShotId === shotId || e.toShotId === shotId);
    items.push({ label: '断开此卡所有连线', disabled: !hasEdges, action: () => void disconnectAll(shotId) });
    items.push({ label: '设为主线起点', action: () => (chainStartId.value = shotId) });
    if (selectedIds.value.size >= 2) {
      items.push({ label: '成组（已选 ' + selectedIds.value.size + ' 张）', action: () => void createGroupFromSelection() });
    }
    const g = groups.value.find((item) => item.shotIds.includes(shotId));
    if (g) items.push({ label: '解散所在组（' + g.name + '）', action: () => void dissolveGroup(g.groupId) });
    if (props.boardMode) {
      items.push({ label: '编辑节点（名称/时长/笔记）', action: () => emit('editNode', shotId) });
      items.push({
        label: '删除节点',
        danger: true,
        action: () => {
          void removeNodeFromWall(shotId);
          emit('deleteNode', shotId);
        },
      });
    } else {
      items.push({ label: '删除节点（仅从墙移除布局）', danger: true, action: () => void removeNodeFromWall(shotId) });
    }
  } else {
    if (props.boardMode) {
      items.push({ label: '添加节点 · 导入照片', action: () => emit('createNode', 'image') });
      items.push({ label: '添加节点 · 黑底+文本', action: () => emit('createNode', 'black') });
      items.push({ label: '添加节点 · 白底+文本', action: () => emit('createNode', 'white') });
      items.push({
        label: selectedIds.value.size > 0 ? `删除节点（已选 ${selectedIds.value.size} 张）` : '删除节点（先选中卡片）',
        danger: true,
        disabled: selectedIds.value.size === 0,
        action: () => {
          for (const id of [...selectedIds.value]) void removeNodeFromWall(id);
          selectedIds.value = new Set();
        },
      });
    }
    items.push({ label: '整理节点', action: () => organizeNodes() });
    items.push({ label: '全选', action: () => selectAllNodes() });
    items.push({ label: '缩放到全部内容', action: () => zoomToFit() });
    if (undoSnapshot) items.push({ label: '撤销整理（Ctrl+Z）', action: () => restoreLayout() });
  }
  ctxMenu.x = x;
  ctxMenu.y = y;
  ctxMenu.items = items;
  ctxMenu.visible = true;
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
  // 0.3.2 修复：交互控件（HUD 按钮/删边按钮/端口/菜单）不能被画布抓手捕获，
  // 否则 pointer capture 吞掉 click，按钮全部失灵
  if ((event.target as HTMLElement).closest('button, .wall-edge-del, .wall-port, .wall-selection, .board-badge')) return;
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
  const dragOrigins = new Map<string, { x: number; y: number }>();
  for (const id of selectedIds.value.has(shot.id) ? selectedIds.value : [shot.id]) {
    const pos0 = positions.value.get(id);
    if (pos0) dragOrigins.set(id, { ...pos0 });
  }
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
      // 0.3.1：允许重叠——只移动被拖卡；多选时整组随动（相对位移）
      const dx = (ev.clientX - startX) / scale.value;
      const dy = (ev.clientY - startY) / scale.value;
      const updates: WallLayoutItem[] = [];
      const ids = selectedIds.value.has(shot.id) ? [...selectedIds.value] : [shot.id];
      for (const id of ids) {
        const base =
          id === shot.id ? { x: originX, y: originY } : dragOrigins.get(id);
        if (!base) continue;
        const nx = base.x + dx;
        const ny = base.y + dy;
        positions.value.set(id, { x: nx, y: ny });
        updates.push({ shotId: id, x: nx, y: ny });
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
  void openPlayer(shot.id);
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
        @contextmenu.prevent="openWallContextMenu($event, item.shot.id)"
      >
        <span
          class="wall-port-in"
          title="拖到另一张卡：建立它到本卡的连线"
          @pointerdown="onPortDown($event, item.shot.id, 'in')"
        ></span>
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
      <button type="button" class="wall-hud-btn" title="缩小画布" aria-label="缩小" @click.stop="zoomBy(1 / 1.2)">−</button>
      <span class="wall-zval">{{ Math.round(scale * 100) }}%</span>
      <button type="button" class="wall-hud-btn" title="放大画布" aria-label="放大" @click.stop="zoomBy(1.2)">+</button>
      <button type="button" class="wall-hud-btn" title="复位视图（Ctrl+0）" aria-label="复位（Ctrl+0）" @click.stop="resetView">⌂</button>
      <button type="button" class="wall-hud-btn wall-export" title="按连线顺序导出镜头图片" @click.stop="exportImages">⇩</button>
      <button type="button" class="wall-hud-btn" title="整理节点（连线链成行，未连线按镜号排下方）" @click.stop="organizeNodes">⌗</button>
      <button type="button" class="wall-hud-btn wall-project" title="投影到拉片界面：按连线顺序把节点呈现在时间线/主播放/右侧面板" @click.stop="emit('project')">▣</button>
      <button type="button" class="wall-hud-btn" title="节点菜单（添加/删除节点、整理等）" @click.stop="openNodeMenuButton">☰</button>
    </div>
    <teleport to="body">
      <ContextMenu
        :visible="ctxMenu.visible"
        :x="ctxMenu.x"
        :y="ctxMenu.y"
        :items="ctxMenu.items"
        @close="ctxMenu.visible = false"
      />
    </teleport>
    <div v-if="props.boardMode && laidShots.length === 0" class="wall-empty-guide">
      <b>空白分镜本</b>
      <span>右键画布空白处 → 添加节点（导入照片 / 黑白底+文本框）；拖动卡片右侧端口连线编排顺序</span>
    </div>
    <div class="wall-hint">滚轮缩放（锚点=光标） · ALT+滚轮/两指横滑 平移 · 空格/中键拖拽抓手 · 双击卡片回到时间线定位 · Ctrl+0 复位</div>
    <!-- S43 分镜PPT 放映层 -->
    <div v-if="player.open" class="wall-ppt" :class="{ 'wall-ppt-single': player.single }">
      <div class="wall-ppt-bar">
        <div class="wall-ppt-tools">
          <button
            v-for="t in ANN_TOOLS"
            :key="t.k"
            type="button"
            class="wall-ppt-tool"
            :class="{ on: annTool === t.k }"
            @click="annTool = t.k"
          >
            {{ t.n }}<kbd>{{ t.key }}</kbd>
          </button>
        </div>
        <div class="wall-ppt-colors">
          <button
            v-for="c in ANNC"
            :key="c"
            type="button"
            class="wall-sw"
            :class="{ on: annColor === c }"
            :style="{ background: c }"
            :aria-label="'颜色 ' + c"
            @click="annColor = c; annSel ? (annSel.color = c) : null"
          ></button>
          <input v-model="annColor" type="color" aria-label="自定义颜色" />
        </div>
        <div class="wall-ppt-actions">
          <button type="button" class="wall-ppt-btn" @click="player.single = !player.single">
            {{ player.single ? '预览模式' : '单张模式' }}
          </button>
          <button type="button" class="wall-ppt-btn acc" @click="player.playing ? stopPlay() : ((player.playing = true), startPlay())">
            {{ player.playing ? '‖ 停止' : '▶ 跟随播放' }}
          </button>
          <span class="wall-ppt-count">{{ player.idx + 1 }} / {{ player.scope.length }}</span>
          <button type="button" class="wall-ppt-close" aria-label="退出放映" @click="closePlayer">×</button>
        </div>
      </div>
      <div class="wall-ppt-stage">
        <button type="button" class="wall-ppt-nav l" :disabled="player.idx === 0" aria-label="上一张" @click="playerMove(-1)">‹</button>
        <div ref="playerTrackEl" class="wall-ppt-track" :style="playerTrackStyle">
          <div
            v-for="(shot, i) in player.scope"
            :key="shot.id"
            class="wall-ppt-slide"
            :class="{ cur: i === player.idx }"
          >
            <div class="wall-ppt-frame">
              <img :src="shot.thumbnail" :alt="shot.title" draggable="false" />
              <svg
                class="sbg-annlayer"
                viewBox="0 0 100 56.25"
                preserveAspectRatio="none"
                :data-card="shot.id"
                @pointerdown="onAnnPointerDown"
                @pointermove="onAnnPointerMove"
                @pointerup="onAnnPointerUp"
              >
                <g v-html="annMarkup(shot.id, true)"></g>
              </svg>
            </div>
            <div
              v-if="curLayerIdxs.length > 1"
              class="wall-ppt-grid"
            >
              <div
                v-for="j in curLayerIdxs"
                :key="'g' + j"
                class="wall-ppt-grid-cell"
                :class="{ on: j === player.idx }"
                @click="player.idx = j"
              >
                <img :src="player.scope[j]?.thumbnail" alt="" draggable="false" />
                <span>#{{ String(player.scope[j]?.index ?? 0).padStart(2, '0') }}</span>
              </div>
            </div>
            <div class="wall-ppt-meta">
              <b>#{{ String(shot.index).padStart(2, '0') }}</b>
              <span v-if="shot.shotSize" class="wall-chip">{{ shot.shotSize }}</span>
              <span v-if="shot.cameraMethod" class="wall-chip">{{ shot.cameraMethod }}</span>
              <span class="wall-dur">{{ (shot.durationMs / 1000).toFixed(1) }}s</span>
              <span class="wall-note">{{ shot.remark ?? shot.title }}</span>
            </div>
          </div>
        </div>
        <button type="button" class="wall-ppt-nav r" :disabled="player.idx >= player.scope.length - 1" aria-label="下一张" @click="playerMove(1)">›</button>
        <div class="wall-ppt-progress" :hidden="!player.playing"><i :style="{ width: (playProgress * 100) + '%' }"></i></div>
      </div>
      <div v-if="trackRows.length > 1" class="wall-ppt-tracks">
        <div v-for="(row, ri) in trackRows" :key="ri" class="wall-ppt-track-row">
          <span class="track-name">轨 {{ ri + 1 }}</span>
          <div class="track-blocks">
            <div
              v-for="seg in row"
              :key="seg.id"
              class="track-block"
              :style="{ flexGrow: seg.dur }"
              :class="{ on: player.scope[player.idx]?.id === seg.id }"
            >
              {{ player.scope.find((s) => s.id === seg.id)?.title.slice(0, 10) }}
            </div>
          </div>
        </div>
      </div>
      <div class="wall-ppt-foot">
        <span class="wall-ppt-scope">{{ playerScopeLabel }}</span>
        <span>← → 沿连线切换 · 1~9 工具 · A 选择 · 拖动绘制 · Esc 退出 · 标注自动保存并回显到分镜墙</span>
      </div>
    </div>
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
  width: 20px;
  height: 20px;
  border: 1px solid var(--border, #2a3a55);
  border-radius: 50%;
  background: var(--surface-2, #182233);
  color: var(--text-muted, #93a4bd);
  font-size: 12px;
  line-height: 1;
  cursor: pointer;
  opacity: 0.9;
  z-index: 6;
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
  right: -8px;
  top: 50%;
  width: 12px;
  height: 12px;
  border: 2px solid var(--green, #34d399);
  border-radius: 3px;
  background: var(--bg-deep, #0a0e16);
  transform: translateY(-50%);
  cursor: crosshair;
  z-index: 3;
}

.wall-port-in {
  position: absolute;
  left: -8px;
  top: 50%;
  width: 12px;
  height: 12px;
  border: 2px solid var(--blue-hi, #5aa2ff);
  border-radius: 3px;
  background: var(--bg-deep, #0a0e16);
  transform: translateY(-50%);
  pointer-events: none;
  z-index: 3;
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

.wall-empty-guide {
  position: absolute;
  left: 50%;
  top: 42%;
  transform: translateX(-50%);
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 16px 22px;
  border: 1px dashed var(--border, #2a3a55);
  border-radius: 12px;
  background: rgba(13, 20, 32, 0.8);
  text-align: center;
  pointer-events: none;
}

.wall-empty-guide b {
  color: var(--blue-hi, #5aa2ff);
  font-weight: 500;
}

.wall-empty-guide span {
  color: var(--text-muted, #93a4bd);
  font-size: 12px;
}

.wall-ppt {
  position: absolute;
  inset: 0;
  z-index: 30;
  display: flex;
  flex-direction: column;
  background: #05070c;
}

.wall-ppt-bar {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  padding: 8px 12px;
  border-bottom: 1px solid var(--border, #2a3a55);
  background: var(--bg-panel, #131a26);
}

.wall-ppt-tools {
  display: flex;
  gap: 3px;
  flex-wrap: wrap;
}

.wall-ppt-tool {
  position: relative;
  min-width: 30px;
  height: 28px;
  padding: 0 7px;
  border: 1px solid var(--border, #2a3a55);
  border-radius: 7px;
  background: var(--surface-2, #182233);
  color: inherit;
  cursor: pointer;
  font-size: 12px;
}

.wall-ppt-tool.on {
  border-color: var(--blue-hi, #5aa2ff);
  background: rgba(90, 162, 255, 0.22);
}

.wall-ppt-tool kbd {
  position: absolute;
  top: -7px;
  right: -5px;
  padding: 0 3px;
  border: 1px solid var(--border, #2a3a55);
  border-radius: 4px;
  background: var(--bg-deep, #0a0e16);
  color: var(--text-muted, #93a4bd);
  font-size: 9px;
}

.wall-ppt-colors {
  display: flex;
  align-items: center;
  gap: 5px;
}

.wall-sw {
  width: 18px;
  height: 18px;
  padding: 0;
  border: 2px solid transparent;
  border-radius: 50%;
  cursor: pointer;
}

.wall-sw.on {
  border-color: #fff;
}

.wall-ppt-colors input[type='color'] {
  width: 22px;
  height: 22px;
  padding: 1px;
  border: 1px solid var(--border, #2a3a55);
  border-radius: 5px;
  background: var(--surface-2, #182233);
  cursor: pointer;
}

.wall-ppt-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-left: auto;
}

.wall-ppt-btn {
  height: 26px;
  padding: 0 10px;
  border: 1px solid var(--border, #2a3a55);
  border-radius: 7px;
  background: var(--surface-2, #182233);
  color: inherit;
  cursor: pointer;
  font-size: 12px;
}

.wall-ppt-btn.acc {
  border-color: var(--green, #34d399);
  color: var(--green, #34d399);
}

.wall-ppt-count {
  font-size: 12px;
  color: var(--text-muted, #93a4bd);
  font-variant-numeric: tabular-nums;
}

.wall-ppt-close {
  width: 28px;
  height: 26px;
  border: 1px solid var(--border, #2a3a55);
  border-radius: 7px;
  background: var(--surface-2, #182233);
  color: inherit;
  cursor: pointer;
  font-size: 15px;
}

.wall-ppt-stage {
  position: relative;
  display: flex;
  flex: 1;
  align-items: center;
  overflow: hidden;
}

.wall-ppt-track {
  display: flex;
  gap: 24px;
  align-items: center;
  transition: transform 0.32s cubic-bezier(0.25, 0.1, 0.25, 1);
  will-change: transform;
}

.wall-ppt-slide {
  flex: 0 0 auto;
  width: 62%;
  overflow: hidden;
  border-radius: 10px;
  background: #000;
  opacity: 0.35;
  transform: scale(0.72);
  transition: transform 0.32s cubic-bezier(0.25, 0.1, 0.25, 1), opacity 0.32s;
}

.wall-ppt-slide.cur {
  opacity: 1;
  transform: scale(1);
}

.wall-ppt-single .wall-ppt-slide {
  width: 82%;
}

.wall-ppt-single .wall-ppt-slide:not(.cur) {
  display: none;
}

.wall-ppt-frame {
  position: relative;
  aspect-ratio: 16 / 9;
}

.wall-ppt-frame img {
  display: block;
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.sbg-annlayer {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  cursor: crosshair;
  touch-action: none;
}

.sbg-annlayer[data-oid] .sbg-sel,
.sbg-sel {
  stroke-dasharray: 2 1.4;
}

.wall-ppt-meta {
  display: flex;
  gap: 6px;
  align-items: center;
  padding: 5px 10px;
  border-top: 1px solid var(--border, #2a3a55);
  background: var(--bg-panel, #131a26);
  color: var(--text-muted, #93a4bd);
  font-size: 11px;
}

.wall-ppt-meta b {
  color: var(--text-soft, #e6edf7);
  font-weight: 500;
}

.wall-note {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.wall-ppt-nav {
  position: absolute;
  top: 50%;
  z-index: 4;
  width: 44px;
  height: 64px;
  border: 1px solid var(--border, #2a3a55);
  border-radius: 10px;
  background: rgba(19, 26, 38, 0.8);
  color: inherit;
  cursor: pointer;
  font-size: 26px;
  transform: translateY(-50%);
}

.wall-ppt-nav.l { left: 10px; }
.wall-ppt-nav.r { right: 10px; }
.wall-ppt-nav:disabled { opacity: 0.25; cursor: default; }

.wall-ppt-progress {
  position: absolute;
  right: 0;
  bottom: 0;
  left: 0;
  z-index: 6;
  height: 3px;
  background: rgba(255, 255, 255, 0.12);
}

.wall-ppt-progress i {
  display: block;
  width: 0;
  height: 100%;
  background: var(--green, #34d399);
}

.wall-ppt-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(120px, 1fr));
  gap: 8px;
  padding: 8px 10px;
  border-top: 1px solid var(--border, #2a3a55);
  background: rgba(10, 14, 22, 0.9);
}

.wall-ppt-grid-cell {
  position: relative;
  overflow: hidden;
  border: 1px solid var(--border, #2a3a55);
  border-radius: 6px;
  cursor: pointer;
  aspect-ratio: 16 / 9;
}

.wall-ppt-grid-cell img {
  display: block;
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.wall-ppt-grid-cell.on {
  border-color: var(--green, #34d399);
}

.wall-ppt-grid-cell span {
  position: absolute;
  left: 4px;
  top: 4px;
  padding: 0 4px;
  border-radius: 4px;
  background: rgba(0, 0, 0, 0.6);
  color: #e6edf7;
  font-size: 10px;
}

.wall-ppt-tracks {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 6px 12px;
  border-top: 1px solid var(--border, #2a3a55);
  background: var(--bg-panel, #131a26);
}

.wall-ppt-track-row {
  display: flex;
  align-items: center;
  gap: 8px;
}

.track-name {
  flex: 0 0 34px;
  font-size: 10px;
  color: var(--text-muted, #93a4bd);
}

.track-blocks {
  display: flex;
  flex: 1;
  gap: 3px;
}

.track-block {
  min-width: 24px;
  overflow: hidden;
  padding: 2px 6px;
  border: 1px solid var(--border, #2a3a55);
  border-radius: 5px;
  background: var(--surface-2, #182233);
  color: var(--text-muted, #93a4bd);
  font-size: 10px;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.track-block.on {
  border-color: var(--green, #34d399);
  color: var(--green, #34d399);
}

.wall-ppt-foot {
  display: flex;
  gap: 10px;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  padding: 7px 12px;
  border-top: 1px solid var(--border, #2a3a55);
  background: var(--bg-panel, #131a26);
  color: var(--text-muted, #93a4bd);
  font-size: 11px;
}

.wall-ppt-scope { color: var(--blue-hi, #5aa2ff); }

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
