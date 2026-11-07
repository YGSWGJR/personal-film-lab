<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import AppIcon from './AppIcon.vue';
import type { BoundaryChange, TimelineMarker, WorkspaceShot } from '../types/workspace';
import type { AudioWaveform } from '../../../shared/types';
import { PX_PER_SEC_LEVELS, TRACK_HEIGHT_LEVELS, snapToLevel } from '../../../shared/types';
import { formatTimecodeFF } from '../../../shared/time';

const props = defineProps<{
  shots: WorkspaceShot[];
  markers: TimelineMarker[];
  selectedId: string | null;
  mergePartnerId?: string | null;
  splitShortcut: string;
  mergeShortcut: string;
  currentTimeMs: number;
  durationMs: number;
  fps: number;
  audioWaveform: AudioWaveform | null;
  audioLoading?: boolean;
  mediaLabel?: string;
  /** S36-3a：V1/V2 轨道高度（px），5 档 48/96/144/192/240。 */
  trackHeight: number;
  /** S36-3b：横向时间密度（px/s），6 档 24/48/96/192/384/768。 */
  pxPerSecond: number;
  /** S36-4b：入点（ms），未设置时为 null。 */
  inPointMs: number | null;
  /** S36-4b：出点（ms），未设置时为 null。 */
  outPointMs: number | null;
}>();

const emit = defineEmits<{
  seek: [timeMs: number];
  select: [shot: WorkspaceShot, additive: boolean];
  split: [];
  merge: [];
  contextMenu: [
    shot: WorkspaceShot | null,
    position: { x: number; y: number },
    timeMs: number,
  ];
  boundaryChange: [change: BoundaryChange];
  boundaryCommit: [change: BoundaryChange];
  updateTrackHeight: [value: number];
  updatePxPerSecond: [value: number];
}>();

const timelineViewportEl = ref<HTMLElement | null>(null);
const audioCanvasEl = ref<HTMLCanvasElement | null>(null);
const viewStartMs = ref(0);
const trackWidthPx = ref(0);
const v2Visible = ref(true);
const v1Visible = ref(true);
const v1Locked = ref(false);
const audioMuted = ref(false);
const audioSolo = ref(false);
const draggingBoundary = ref<number | null>(null);
let activeBoundary: number | null = null;
let latestBoundaryTime = 0;
let boundaryMinTime = 0;
let boundaryMaxTime = 0;
let drawFrame = 0;
let resizeObserver: ResizeObserver | null = null;
let scrubElement: HTMLElement | null = null;

const safeDuration = computed(() => Math.max(1, props.durationMs));
const visibleDurationMs = computed(() =>
  trackWidthPx.value > 0
    ? (trackWidthPx.value / Math.max(1, props.pxPerSecond)) * 1000
    : safeDuration.value,
);
const viewEndMs = computed(() => viewStartMs.value + visibleDurationMs.value);
const maxViewStartMs = computed(() => Math.max(0, safeDuration.value - visibleDurationMs.value));
const playheadPercent = computed(() =>
  clampPercent(((props.currentTimeMs - viewStartMs.value) / visibleDurationMs.value) * 100),
);
const audioHeight = computed(() =>
  Math.max(1, Math.min(96, Math.round(props.trackHeight * 0.7))),
);
const densityLabel = computed(() => `${props.pxPerSecond} px/s`);
const heightLabel = computed(() => `${props.trackHeight}px`);
const compactHead = computed(() => props.trackHeight <= 48);
const mediaLabel = computed(() => props.mediaLabel?.trim() || '影片原声');
const durationLabel = computed(() => formatDuration(props.durationMs));
const selectedShot = computed(() => props.shots.find((shot) => shot.id === props.selectedId) ?? null);
const canSplitSelected = computed(
  () =>
    Boolean(selectedShot.value) &&
    !selectedShot.value?.locked &&
    !v1Locked.value &&
    props.currentTimeMs > (selectedShot.value?.startMs ?? 0) &&
    props.currentTimeMs < (selectedShot.value?.endMs ?? 0),
);
const canMergeSelected = computed(() => {
  const primary = selectedShot.value;
  const partner = props.shots.find((shot) => shot.id === props.mergePartnerId);
  if (!primary || !partner || primary.id === partner.id) return false;
  const [left, right] = primary.startMs <= partner.startMs ? [primary, partner] : [partner, primary];
  return !left.locked && !right.locked && !v1Locked.value && left.endMs === right.startMs;
});
const timelineGridStyle = computed(() => ({
  '--second-px': `${Math.max(8, props.pxPerSecond)}px`,
}));
const navigatorMaxMs = computed(() => Math.max(0, Math.round(maxViewStartMs.value)));
const navigatorValueMs = computed(() => Math.round(viewStartMs.value));
const navigatorDisabled = computed(() => navigatorMaxMs.value <= 0);
const selectionRange = computed(() => {
  if (props.inPointMs === null || props.outPointMs === null) return null;
  const start = Math.min(props.inPointMs, props.outPointMs);
  const end = Math.max(props.inPointMs, props.outPointMs);
  if (end <= viewStartMs.value || start >= viewEndMs.value) return null;
  return {
    left: `${clampPercent(((start - viewStartMs.value) / visibleDurationMs.value) * 100)}%`,
    width: `${Math.max(
      0.1,
      clampPercent(((Math.min(end, viewEndMs.value) - Math.max(start, viewStartMs.value)) / visibleDurationMs.value) * 100),
    )}%`,
  };
});
const visibleMarkers = computed(() =>
  props.markers
    .filter((marker) => marker.timeMs >= viewStartMs.value && marker.timeMs <= viewEndMs.value)
    .map((marker) => ({
      ...marker,
      left: `${clampPercent(((marker.timeMs - viewStartMs.value) / visibleDurationMs.value) * 100)}%`,
    })),
);
const visibleShots = computed(() => {
  const viewStart = viewStartMs.value;
  const viewEnd = viewEndMs.value;
  const viewDuration = visibleDurationMs.value;
  return props.shots.flatMap((shot, index) => {
    if (shot.endMs <= viewStart || shot.startMs >= viewEnd) return [];
    const clippedStart = Math.max(viewStart, shot.startMs);
    const clippedEnd = Math.min(viewEnd, shot.endMs);
    const widthPx = ((clippedEnd - clippedStart) / viewDuration) * trackWidthPx.value;
    const tileWidth = Math.max(56, Math.min(150, audioHeight.value * 1.55));
    return [{
      shot,
      index,
      left: `${clampPercent(((shot.startMs - viewStart) / viewDuration) * 100)}%`,
      width: `${clampPercent(((shot.endMs - shot.startMs) / viewDuration) * 100)}%`,
      thumbnailCopies: Array.from(
        { length: Math.max(1, Math.min(10, Math.ceil(widthPx / tileWidth))) },
        (_, tileIndex) => tileIndex,
      ),
      duration: formatDuration(shot.durationMs || shot.endMs - shot.startMs),
      label: shot.title || shot.dialogue || shot.shotSize || '未命名镜头',
      selected: shot.id === props.selectedId,
      partnerSelected: shot.id === props.mergePartnerId,
      current: props.currentTimeMs >= shot.startMs && props.currentTimeMs < shot.endMs,
      canTrimLeft: index > 0 && !v1Locked.value && !shot.locked,
      canTrimRight: index < props.shots.length - 1 && !v1Locked.value && !shot.locked,
    }];
  });
});

const ticks = computed(() => {
  const width = trackWidthPx.value;
  const start = viewStartMs.value;
  const duration = visibleDurationMs.value;
  if (width <= 0 || !Number.isFinite(duration) || duration <= 0) return [];

  const frameMs = 1000 / Math.max(1, props.fps || 24);
  const msPerPixel = 1000 / Math.max(1, props.pxPerSecond);
  const minSpacingPx = 82;
  let mode: 'frame' | 'second' | 'ten';
  let candidates: number[];
  if (props.pxPerSecond >= 384) {
    mode = 'frame';
    candidates = [frameMs, frameMs * 2, frameMs * 5, frameMs * 10, frameMs * 25];
  } else if (props.pxPerSecond >= 96) {
    mode = 'second';
    candidates = [1000, 2000, 5000, 10000];
  } else {
    mode = 'ten';
    candidates = [10000, 20000, 30000, 60000, 120000];
  }

  let interval = candidates[candidates.length - 1];
  for (const candidate of candidates) {
    if (candidate / msPerPixel >= minSpacingPx) {
      interval = candidate;
      break;
    }
  }

  const labelFor = (ms: number): string => {
    if (mode === 'frame') return formatTimecodeFF(ms, props.fps);
    if (mode === 'second') return formatClock(ms);
    return formatShortClock(ms);
  };
  const list: Array<{ percent: number; label: string }> = [];
  let first = Math.ceil(start / interval) * interval;
  if (mode === 'frame') first = Math.ceil(start / frameMs) * frameMs;
  const end = start + duration;
  for (let time = first; time <= end; time += interval) {
    if (time < 0) continue;
    list.push({ percent: ((time - start) / duration) * 100, label: labelFor(time) });
    if (list.length > 300) break;
  }
  return list;
});

/** S36-8：音量式缩放控件状态。 */
const zoomOpen = ref(false);
const zoomDragging = ref(false);
const zoomHeightDraft = ref(String(props.trackHeight));
const zoomDensityDraft = ref(String(props.pxPerSecond));
const zoomHeightEditing = ref(false);
const zoomDensityEditing = ref(false);
const zoomCtlEl = ref<HTMLElement | null>(null);

function clampPercent(value: number): number {
  return Math.max(0, Math.min(100, value));
}

function clampIndex(value: number, length: number): number {
  return Math.max(0, Math.min(length - 1, value));
}

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

function formatClock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  return `${pad2(Math.floor(total / 3600))}:${pad2(Math.floor((total % 3600) / 60))}:${pad2(total % 60)}`;
}

function formatShortClock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(total / 60)}:${pad2(total % 60)}`;
}

function formatDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  return hours > 0
    ? `${pad2(hours)}:${pad2(minutes)}:${pad2(seconds)}`
    : `${pad2(minutes)}:${pad2(seconds)}`;
}

function onDocumentPointerDown(event: PointerEvent): void {
  if (!zoomOpen.value) return;
  const element = zoomCtlEl.value;
  if (element && !element.contains(event.target as Node)) zoomOpen.value = false;
}

function onHeightSliderInput(event: Event): void {
  zoomDragging.value = true;
  const value = Number((event.target as HTMLInputElement).value);
  const snapped = snapToLevel(value, TRACK_HEIGHT_LEVELS);
  emit('updateTrackHeight', snapped);
  zoomHeightDraft.value = String(snapped);
}

function onHeightSliderChange(event: Event): void {
  const value = Number((event.target as HTMLInputElement).value);
  const snapped = snapToLevel(value, TRACK_HEIGHT_LEVELS);
  emit('updateTrackHeight', snapped);
  zoomHeightDraft.value = String(snapped);
  zoomDragging.value = false;
}

function onDensitySliderInput(event: Event): void {
  zoomDragging.value = true;
  const value = Number((event.target as HTMLInputElement).value);
  setPxPerSecond(value);
  zoomDensityDraft.value = String(snapToLevel(value, PX_PER_SEC_LEVELS));
}

function onDensitySliderChange(event: Event): void {
  const value = Number((event.target as HTMLInputElement).value);
  setPxPerSecond(value);
  zoomDensityDraft.value = String(snapToLevel(value, PX_PER_SEC_LEVELS));
  zoomDragging.value = false;
}

function beginHeightInput(): void {
  zoomHeightEditing.value = true;
  zoomHeightDraft.value = String(props.trackHeight);
}

function commitHeightInput(): void {
  const value = Number(zoomHeightDraft.value);
  if (!Number.isFinite(value)) {
    zoomHeightDraft.value = String(props.trackHeight);
    zoomHeightEditing.value = false;
    return;
  }
  const snapped = snapToLevel(value, TRACK_HEIGHT_LEVELS);
  emit('updateTrackHeight', snapped);
  zoomHeightDraft.value = String(snapped);
  zoomHeightEditing.value = false;
}

function beginDensityInput(): void {
  zoomDensityEditing.value = true;
  zoomDensityDraft.value = String(props.pxPerSecond);
}

function commitDensityInput(): void {
  const value = Number(zoomDensityDraft.value);
  if (!Number.isFinite(value)) {
    zoomDensityDraft.value = String(props.pxPerSecond);
    zoomDensityEditing.value = false;
    return;
  }
  const snapped = snapToLevel(value, PX_PER_SEC_LEVELS);
  emit('updatePxPerSecond', snapped);
  zoomDensityDraft.value = String(snapped);
  zoomDensityEditing.value = false;
}

function onHeightWheel(event: WheelEvent): void {
  if (event.deltaY === 0) return;
  event.preventDefault();
  event.stopPropagation();
  zoomHeightDraft.value = String(stepTrackHeight(event.deltaY < 0 ? 1 : -1));
}

function onDensityWheel(event: WheelEvent): void {
  if (event.deltaY === 0) return;
  event.preventDefault();
  event.stopPropagation();
  zoomDensityDraft.value = String(stepPxPerSecond(event.deltaY < 0 ? 1 : -1));
}

function resetZoomControl(): void {
  emit('updateTrackHeight', 96);
  resetDensity();
  zoomHeightDraft.value = '96';
  zoomDensityDraft.value = '96';
}

watch(
  () => props.trackHeight,
  (value) => {
    if (!zoomHeightEditing.value) zoomHeightDraft.value = String(value);
  },
);
watch(
  () => props.pxPerSecond,
  (value) => {
    if (!zoomDensityEditing.value) zoomDensityDraft.value = String(value);
  },
);

function timeFromClientX(clientX: number, element: HTMLElement | null): number {
  const rect = element?.getBoundingClientRect();
  if (!rect || rect.width <= 0) return 0;
  const raw = viewStartMs.value + ((clientX - rect.left) / rect.width) * visibleDurationMs.value;
  const frameMs = 1000 / Math.max(1, props.fps || 24);
  const frameAlignedMs = Math.round(raw / frameMs) * frameMs;
  return Math.max(0, Math.min(Math.round(safeDuration.value), Math.round(frameAlignedMs)));
}

function clampViewStart(value: number): number {
  return Math.max(0, Math.min(maxViewStartMs.value, Math.round(value)));
}

function resetDensity(): void {
  if (props.pxPerSecond !== 96) emit('updatePxPerSecond', 96);
  viewStartMs.value = 0;
}

function setPxPerSecond(
  nextPx: number,
  anchorClientX?: number,
  options: { snap?: boolean } = {},
): void {
  // S41：默认仍吸附档位（胶囊/输入框/Ctrl+滚轮）；纯滚轮缩放传 snap:false 走连续值。
  const snap = options.snap ?? true;
  const target = snap
    ? snapToLevel(nextPx, PX_PER_SEC_LEVELS)
    : Math.max(24, Math.min(768, nextPx));
  if (Math.abs(target - props.pxPerSecond) < 0.01) return;
  const width = trackWidthPx.value;
  const rect = timelineViewportEl.value?.getBoundingClientRect();
  const ratio =
    width > 0 && anchorClientX !== undefined && rect
      ? Math.max(0, Math.min(1, (anchorClientX - rect.left) / width))
      : 0.5;
  const anchorTime = viewStartMs.value + visibleDurationMs.value * ratio;
  emit('updatePxPerSecond', target);
  const nextVisible = width > 0 ? (width / target) * 1000 : safeDuration.value;
  viewStartMs.value = clampViewStart(anchorTime - nextVisible * ratio);
}

function stepPxPerSecond(direction: 1 | -1): number {
  // 非档位值（连续缩放后）回退到最近档位，而不是写死 96。
  let nearestIndex = 0;
  let nearestDistance = Number.POSITIVE_INFINITY;
  PX_PER_SEC_LEVELS.forEach((level, index) => {
    const distance = Math.abs(level - props.pxPerSecond);
    if (distance < nearestDistance) {
      nearestDistance = distance;
      nearestIndex = index;
    }
  });
  const next = PX_PER_SEC_LEVELS[clampIndex(nearestIndex + direction, PX_PER_SEC_LEVELS.length)];
  setPxPerSecond(next);
  return snapToLevel(next, PX_PER_SEC_LEVELS);
}

function stepTrackHeight(direction: 1 | -1): number {
  const index = TRACK_HEIGHT_LEVELS.indexOf(props.trackHeight);
  const base = index >= 0 ? index : TRACK_HEIGHT_LEVELS.indexOf(96);
  const next = TRACK_HEIGHT_LEVELS[clampIndex(base + direction, TRACK_HEIGHT_LEVELS.length)];
  if (next !== props.trackHeight) emit('updateTrackHeight', next);
  return next;
}

function panView(event: WheelEvent, force = false): void {
  const delta =
    Math.abs(event.deltaX) > Math.abs(event.deltaY)
      ? event.deltaX
      : event.shiftKey || force
        ? event.deltaY
        : 0;
  if (delta === 0) return;
  event.preventDefault();
  const rect = timelineViewportEl.value?.getBoundingClientRect();
  if (!rect || rect.width <= 0) return;
  viewStartMs.value = clampViewStart(viewStartMs.value + (delta / rect.width) * visibleDurationMs.value);
}

/** S41：归一化滚轮位移（deltaMode 0=像素 1=行 2=页） */
function normalizeWheelDelta(event: WheelEvent): number {
  if (event.deltaMode === 1) return event.deltaY * 16;
  if (event.deltaMode === 2) {
    const height = timelineViewportEl.value?.clientHeight ?? 400;
    return event.deltaY * height;
  }
  return event.deltaY;
}

/** 高频 wheel 事件用 rAF 合并，一帧只应用一次连续缩放。 */
let pendingWheelZoom: { clientX: number; delta: number } | null = null;
let wheelZoomRaf = 0;

function scheduleWheelZoom(event: WheelEvent): void {
  const delta = normalizeWheelDelta(event);
  if (pendingWheelZoom) {
    pendingWheelZoom.delta += delta;
  } else {
    pendingWheelZoom = { clientX: event.clientX, delta };
  }
  if (wheelZoomRaf) return;
  wheelZoomRaf = requestAnimationFrame(() => {
    wheelZoomRaf = 0;
    const pending = pendingWheelZoom;
    pendingWheelZoom = null;
    if (!pending) return;
    zoomAtClientX(pending.clientX, pending.delta);
  });
}

function zoomAtClientX(clientX: number, delta: number): void {
  const rect = timelineViewportEl.value?.getBoundingClientRect();
  if (!rect || rect.width <= 0) return;
  const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
  const anchorTime = viewStartMs.value + visibleDurationMs.value * ratio;
  const nextPx = Math.max(24, Math.min(768, props.pxPerSecond * Math.pow(1.0015, -delta)));
  emit('updatePxPerSecond', nextPx);
  const width = trackWidthPx.value;
  const nextVisible = width > 0 ? (width / nextPx) * 1000 : safeDuration.value;
  viewStartMs.value = clampViewStart(anchorTime - nextVisible * ratio);
}

function onRulerWheel(event: WheelEvent): void {
  // 事件顺序：Ctrl/Cmd 档位 → ALT 平移 → Shift/横向平移 → 默认连续缩放
  if (event.ctrlKey || event.metaKey) {
    event.preventDefault();
    stepPxPerSecond(event.deltaY < 0 ? 1 : -1);
    return;
  }
  if (event.altKey) {
    panView(event, true);
    return;
  }
  if (event.shiftKey || Math.abs(event.deltaX) > Math.abs(event.deltaY)) {
    panView(event);
    return;
  }
  if (event.deltaY === 0) return;
  event.preventDefault();
  scheduleWheelZoom(event);
}

function onNavigatorInput(event: Event): void {
  if (navigatorDisabled.value) return;
  viewStartMs.value = clampViewStart(Number((event.target as HTMLInputElement).value));
}

function onTracksWheel(event: WheelEvent): void {
  if (event.ctrlKey || event.metaKey) {
    event.preventDefault();
    stepTrackHeight(event.deltaY < 0 ? 1 : -1);
    return;
  }
  if (event.altKey) {
    panView(event, true);
    return;
  }
  if (event.shiftKey || Math.abs(event.deltaX) > Math.abs(event.deltaY)) {
    panView(event);
    return;
  }
  if (event.deltaY === 0) return;
  event.preventDefault();
  scheduleWheelZoom(event);
}

function beginScrub(event: PointerEvent, element: HTMLElement | null): void {
  if (!element) return;
  event.preventDefault();
  scrubElement = element;
  emit('seek', timeFromClientX(event.clientX, element));
  window.addEventListener('pointermove', scrubMove);
  window.addEventListener('pointerup', finishScrub, { once: true });
}

function scrubMove(event: PointerEvent): void {
  if (!scrubElement) return;
  emit('seek', timeFromClientX(event.clientX, scrubElement));
}

function finishScrub(): void {
  window.removeEventListener('pointermove', scrubMove);
  scrubElement = null;
}

function onRulerPointerDown(event: PointerEvent): void {
  if (event.button !== 0) return;
  const viewport = timelineViewportEl.value;
  if (!viewport) return;
  beginScrub(event, viewport);
}

function onTimelineBlankPointerDown(event: PointerEvent): void {
  if (event.button !== 0 || event.target !== event.currentTarget) return;
  beginScrub(event, event.currentTarget as HTMLElement);
}

function selectShotAt(shot: WorkspaceShot, additive = false): void {
  emit('select', shot, additive);
  if (!additive) emit('seek', shot.startMs);
}

function onShotClipPointerDown(index: number, event: PointerEvent): void {
  if (event.button !== 0) return;
  event.preventDefault();
  event.stopPropagation();
  const shot = props.shots[index];
  if (!shot) return;
  if (v1Locked.value) {
    selectShotAt(shot);
    return;
  }
  selectShotAt(
    shot,
    event.shiftKey || event.ctrlKey || event.metaKey,
  );
}

function onTimelineContextMenu(shot: WorkspaceShot | null, event: MouseEvent): void {
  const timeMs = timelineViewportEl.value
    ? timeFromClientX(event.clientX, timelineViewportEl.value)
    : props.currentTimeMs;
  emit('contextMenu', shot, { x: event.clientX, y: event.clientY }, timeMs);
}

function requestSplit(): void {
  if (canSplitSelected.value) emit('split');
}

function requestMerge(): void {
  if (canMergeSelected.value) emit('merge');
}

function beginTrim(index: number, side: 'left' | 'right', event: PointerEvent): void {
  if (v1Locked.value || props.shots[index]?.locked) return;
  event.preventDefault();
  event.stopPropagation();
  const boundaryIndex = side === 'right' ? index : index - 1;
  if (boundaryIndex < 0 || boundaryIndex >= props.shots.length - 1) return;
  beginBoundaryDrag(boundaryIndex, event);
}

function beginBoundaryDrag(index: number, event: PointerEvent): void {
  const shot = props.shots[index];
  const next = props.shots[index + 1];
  if (!shot || !next) return;
  activeBoundary = index;
  draggingBoundary.value = index;
  latestBoundaryTime = shot.endMs;
  boundaryMinTime = shot.startMs + 350;
  boundaryMaxTime = next.endMs - 350;
  window.addEventListener('pointermove', handleBoundaryMove);
  window.addEventListener('pointerup', finishBoundaryDrag, { once: true });
  handleBoundaryMove(event);
}

function handleBoundaryMove(event: PointerEvent): void {
  if (activeBoundary === null) return;
  const candidate = Math.max(
    boundaryMinTime,
    Math.min(boundaryMaxTime, timeFromClientX(event.clientX, timelineViewportEl.value)),
  );
  latestBoundaryTime = candidate;
  emit('boundaryChange', { index: activeBoundary, timeMs: candidate });
}

function finishBoundaryDrag(): void {
  window.removeEventListener('pointermove', handleBoundaryMove);
  if (activeBoundary !== null) {
    emit('boundaryCommit', { index: activeBoundary, timeMs: latestBoundaryTime });
  }
  activeBoundary = null;
  draggingBoundary.value = null;
}

function onMarkerPointerDown(marker: TimelineMarker, event: PointerEvent): void {
  if (event.button !== 0) return;
  event.preventDefault();
  event.stopPropagation();
  const shot = props.shots.find((item) => item.id === marker.shotId);
  if (shot) emit('select', shot, false);
  emit('seek', marker.timeMs);
}

function resizeCanvas(canvas: HTMLCanvasElement): CanvasRenderingContext2D | null {
  const rect = canvas.getBoundingClientRect();
  const ratio = window.devicePixelRatio || 1;
  const width = Math.max(1, Math.round(rect.width * ratio));
  const height = Math.max(1, Math.round(rect.height * ratio));
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }
  const context = canvas.getContext('2d');
  if (!context) return null;
  context.setTransform(ratio, 0, 0, ratio, 0, 0);
  return context;
}

function drawAudioWaveform(): void {
  drawFrame = 0;
  const canvas = audioCanvasEl.value;
  if (!canvas) return;
  const context = resizeCanvas(canvas);
  if (!context) return;
  const rect = canvas.getBoundingClientRect();
  const width = rect.width;
  const height = rect.height;
  context.clearRect(0, 0, width, height);
  const centerY = height / 2;
  context.strokeStyle = 'rgba(132, 204, 188, 0.3)';
  context.lineWidth = 1;
  context.setLineDash([3, 3]);
  context.beginPath();
  context.moveTo(0, centerY);
  context.lineTo(width, centerY);
  context.stroke();
  context.setLineDash([]);

  if (props.audioWaveform) {
    const bucketWidthMs = props.audioWaveform.bucketMs;
    const halfHeight = Math.max(2, height / 2 - 3);
    for (const bucket of props.audioWaveform.buckets) {
      if (bucket.startMs + bucketWidthMs < viewStartMs.value || bucket.startMs > viewEndMs.value) {
        continue;
      }
      const x = ((bucket.startMs - viewStartMs.value) / visibleDurationMs.value) * width;
      const bucketWidth = Math.max(
        1,
        (bucketWidthMs / visibleDurationMs.value) * width - 0.3,
      );
      const peakHeight = Math.max(0.6, bucket.peak * halfHeight);
      const rmsHeight = Math.max(0.5, bucket.rms * halfHeight);
      context.fillStyle = 'rgba(199, 232, 220, 0.34)';
      context.fillRect(x, centerY - peakHeight, bucketWidth, peakHeight * 2);
      context.fillStyle = 'rgba(228, 246, 238, 0.84)';
      context.fillRect(x, centerY - rmsHeight, bucketWidth, rmsHeight * 2);
    }
  }
}

function scheduleDraw(): void {
  if (drawFrame) return;
  drawFrame = requestAnimationFrame(drawAudioWaveform);
}

watch(
  () => [
    props.audioWaveform,
    props.durationMs,
    props.pxPerSecond,
    viewStartMs.value,
    trackWidthPx.value,
    audioHeight.value,
  ],
  scheduleDraw,
);

watch(
  () => props.currentTimeMs,
  (timeMs) => {
    if (draggingBoundary.value !== null) return;
    const end = viewStartMs.value + visibleDurationMs.value;
    if (timeMs >= viewStartMs.value && timeMs <= end) return;
    viewStartMs.value = clampViewStart(timeMs - visibleDurationMs.value * 0.12);
  },
);

function measureTrackWidth(): void {
  const rect = timelineViewportEl.value?.getBoundingClientRect();
  trackWidthPx.value = rect && rect.width > 0 ? rect.width : 0;
}

onMounted(async () => {
  await nextTick();
  document.addEventListener('pointerdown', onDocumentPointerDown);
  measureTrackWidth();
  viewStartMs.value = clampViewStart(props.currentTimeMs - visibleDurationMs.value * 0.12);
  resizeObserver = new ResizeObserver(() => {
    measureTrackWidth();
    scheduleDraw();
  });
  if (timelineViewportEl.value) resizeObserver.observe(timelineViewportEl.value);
  if (audioCanvasEl.value) resizeObserver.observe(audioCanvasEl.value);
  scheduleDraw();
});

onBeforeUnmount(() => {
  if (drawFrame) cancelAnimationFrame(drawFrame);
  document.removeEventListener('pointerdown', onDocumentPointerDown);
  resizeObserver?.disconnect();
  resizeObserver = null;
  window.removeEventListener('pointermove', handleBoundaryMove);
  window.removeEventListener('pointerup', finishBoundaryDrag);
  window.removeEventListener('pointermove', scrubMove);
  window.removeEventListener('pointerup', finishScrub);
});
</script>

<template>
  <section class="timeline" :style="{ '--track-height': `${trackHeight}px`, '--audio-height': `${audioHeight}px` }">
    <div class="timeline-context">
      <div class="timeline-tab">
        <AppIcon name="film" :size="12" />
        <span>Timeline 1</span>
        <em>{{ shots.length }} 镜头</em>
      </div>
      <span class="source-chip">单视频源 · V2 参考轨</span>
      <div class="timeline-actions">
        <button
          type="button"
          class="timeline-action"
          :title="`在播放头切分当前镜头（${splitShortcut}）`"
          :disabled="!canSplitSelected"
          @click="requestSplit"
        >
          <AppIcon name="scissors" :size="12" />
          切分
        </button>
        <button
          type="button"
          class="timeline-action"
          :title="`合并双选中的相邻镜头（${mergeShortcut}）`"
          :disabled="!canMergeSelected"
          @click="requestMerge"
        >
          <AppIcon name="link" :size="12" />
          合并
        </button>
      </div>
      <span class="timeline-duration">{{ durationLabel }}</span>
    </div>

    <div class="ruler-row" @wheel="onRulerWheel">
      <span class="ruler-head">时间码</span>
      <div ref="timelineViewportEl" class="track-container" @pointerdown="onRulerPointerDown">
        <span
          v-for="tick in ticks"
          :key="`${tick.percent}-${tick.label}`"
          class="tick"
          :style="{ left: `${tick.percent}%` }"
        >
          <i></i><em>{{ tick.label }}</em>
        </span>
        <div ref="zoomCtlEl" class="zoom-ctl" @pointerdown.stop>
          <button
            type="button"
            class="zoom-btn"
            :class="{ active: zoomOpen, dragging: zoomDragging }"
            :title="`轨道高度 ${heightLabel} · 时间密度 ${densityLabel}（点击展开滑块）`"
            @click="zoomOpen = !zoomOpen"
          >
            <AppIcon name="search" :size="11" />
            <span>{{ heightLabel }} · {{ densityLabel }}</span>
          </button>
          <div v-show="zoomOpen" class="zoom-pop" @pointerdown.stop @wheel.stop>
            <div class="zoom-row" @wheel.prevent.stop="onHeightWheel">
              <span>轨道高度</span>
              <input
                type="range"
                min="1"
                max="240"
                step="1"
                :value="trackHeight"
                @input="onHeightSliderInput"
                @change="onHeightSliderChange"
              />
              <input
                class="zoom-num"
                v-model="zoomHeightDraft"
                type="number"
                min="1"
                max="240"
                @focus="beginHeightInput"
                @keydown.enter.prevent="commitHeightInput"
                @blur="commitHeightInput"
              />
            </div>
            <div class="zoom-row" @wheel.prevent.stop="onDensityWheel">
              <span>时间密度</span>
              <input
                type="range"
                min="24"
                max="768"
                step="1"
                :value="pxPerSecond"
                @input="onDensitySliderInput"
                @change="onDensitySliderChange"
              />
              <input
                class="zoom-num"
                v-model="zoomDensityDraft"
                type="number"
                min="24"
                max="768"
                @focus="beginDensityInput"
                @keydown.enter.prevent="commitDensityInput"
                @blur="commitDensityInput"
              />
            </div>
            <div class="zoom-pop-foot">
              <button type="button" class="zoom-reset" @click="resetZoomControl">重置 96 / 96</button>
              <span class="zoom-hint">拖动逐档预览 · 松手定档 · 滚轮微调</span>
            </div>
          </div>
        </div>
        <span class="playhead playhead-ruler" :style="{ left: `${playheadPercent}%` }"></span>
      </div>
    </div>

    <div class="navigator-row" aria-label="时间线区域导航">
      <span class="navigator-label">导航</span>
      <div class="navigator-track">
        <input
          class="timeline-navigator-slider"
          type="range"
          min="0"
          :max="Math.max(1, navigatorMaxMs)"
          step="1"
          :value="navigatorValueMs"
          :disabled="navigatorDisabled"
          :title="navigatorDisabled ? '当前缩放已显示全片' : '拖到任意位置快速跳转时间线视图'"
          @input="onNavigatorInput"
        />
        <span class="navigator-range-label">
          {{ navigatorDisabled ? '全片' : `${formatShortClock(viewStartMs)} – ${formatShortClock(viewEndMs)}` }}
        </span>
      </div>
    </div>

    <div class="tracks" :style="timelineGridStyle" @wheel="onTracksWheel">
      <div class="track-row track-row-v2" :class="{ 'track-hidden': !v2Visible }">
        <div class="track-head" :class="{ compact: compactHead }">
          <div class="head-topline">
            <span class="track-badge video-badge">V2</span>
            <div class="head-actions">
              <button
                type="button"
                class="head-control"
                :class="{ active: v2Visible }"
                :aria-pressed="v2Visible"
                title="显示或隐藏 V2 缩略图"
                @click="v2Visible = !v2Visible"
              >◉</button>
              <button type="button" class="head-control muted-control" title="V2 为只读参考轨" disabled>⌾</button>
            </div>
          </div>
          <strong>视频 2</strong>
          <small>{{ shots.length }} 个片段 · 缩略图参考</small>
        </div>
        <div class="lane v2-lane" @pointerdown="onTimelineBlankPointerDown">
          <div
            v-for="item in visibleShots"
            :key="`v2-${item.shot.id}`"
            class="v2-clip"
            :class="{ selected: item.selected, current: item.current }"
            :style="{ left: item.left, width: item.width }"
            :title="`${String(item.shot.index).padStart(2, '0')} · ${item.label}`"
            @pointerdown.stop="selectShotAt(item.shot)"
          >
            <div v-if="v2Visible && item.shot.thumbnail" class="v2-tiles">
              <img
                v-for="copy in item.thumbnailCopies"
                :key="copy"
                :src="item.shot.thumbnail"
                alt=""
                draggable="false"
              />
            </div>
            <div v-else class="v2-fallback">
              <span>{{ String(item.shot.index).padStart(2, '0') }}</span>
            </div>
            <div class="v2-caption">
              <span>{{ item.label }}</span>
              <em>{{ item.duration }}</em>
            </div>
          </div>
          <div v-if="shots.length === 0" class="lane-empty">检测镜头后，这里显示缩略图参考条</div>
          <div v-if="!v2Visible" class="lane-empty hidden-note">V2 缩略图已隐藏</div>
          <span class="playhead" :style="{ left: `${playheadPercent}%` }"></span>
        </div>
      </div>

      <div class="track-row track-row-v1" :class="{ 'track-hidden': !v1Visible }">
        <div class="track-head" :class="{ compact: compactHead }">
          <div class="head-topline">
            <span class="track-badge video-badge">V1</span>
            <div class="head-actions">
              <button
                type="button"
                class="head-control"
                :class="{ active: v1Visible }"
                :aria-pressed="v1Visible"
                title="显示或隐藏 V1 剪辑"
                @click="v1Visible = !v1Visible"
              >◉</button>
              <button
                type="button"
                class="head-control"
                :class="{ active: v1Locked }"
                :aria-pressed="v1Locked"
                title="锁定 V1 边界编辑"
                @click="v1Locked = !v1Locked"
              >{{ v1Locked ? '▣' : '□' }}</button>
            </div>
          </div>
          <strong>视频 1</strong>
          <small>{{ shots.length }} 个剪辑 · 边界可调</small>
        </div>
        <div
          class="lane v1-lane"
          @pointerdown="onTimelineBlankPointerDown"
          @contextmenu.prevent="onTimelineContextMenu(null, $event)"
        >
          <div v-if="selectionRange" class="selection-range" :style="selectionRange"></div>
          <div
            v-for="item in visibleShots"
            :key="`v1-${item.shot.id}`"
            class="v1-clip"
            :class="{
              selected: item.selected,
              'partner-selected': item.partnerSelected,
              current: item.current,
              dragging: draggingBoundary === item.index || draggingBoundary === item.index - 1,
            }"
            :style="{ left: item.left, width: item.width }"
            @pointerdown="onShotClipPointerDown(item.index, $event)"
            @contextmenu.prevent.stop="onTimelineContextMenu(item.shot, $event)"
          >
            <button
              v-if="item.canTrimLeft"
              type="button"
              class="trim-handle trim-left"
              title="拖动调整前一个镜头的出点"
              @pointerdown="beginTrim(item.index, 'left', $event)"
            ></button>
            <div class="v1-copy">
              <span class="v1-index">{{ String(item.shot.index).padStart(2, '0') }}</span>
              <strong>{{ item.label }}</strong>
              <small>{{ item.duration }} · {{ item.shot.shotSize || '镜头' }}</small>
            </div>
            <button
              v-if="item.canTrimRight"
              type="button"
              class="trim-handle trim-right"
              title="拖动调整本镜头出点"
              @pointerdown="beginTrim(item.index, 'right', $event)"
            ></button>
          </div>
          <button
            v-for="marker in visibleMarkers"
            :key="`marker-${marker.id}`"
            type="button"
            class="marker-pin"
            :class="marker.type"
            :style="{ left: marker.left }"
            :title="marker.label"
            @pointerdown="onMarkerPointerDown(marker, $event)"
          ><span></span></button>
          <div v-if="shots.length === 0" class="lane-empty">暂无镜头剪辑</div>
          <span class="playhead" :style="{ left: `${playheadPercent}%` }"></span>
        </div>
      </div>

      <div class="track-row track-row-a1" :class="{ 'track-muted': audioMuted }">
        <div class="track-head audio-head" :class="{ compact: compactHead }">
          <div class="head-topline">
            <span class="track-badge audio-badge">A1</span>
            <div class="head-actions audio-actions">
              <button
                type="button"
                class="head-control letter-control"
                :class="{ active: audioMuted }"
                :aria-pressed="audioMuted"
                title="静音 A1"
                @click="audioMuted = !audioMuted"
              >M</button>
              <button
                type="button"
                class="head-control letter-control"
                :class="{ active: audioSolo }"
                :aria-pressed="audioSolo"
                title="独奏 A1"
                @click="audioSolo = !audioSolo"
              >S</button>
            </div>
          </div>
          <strong>音频 1</strong>
          <small>原声 · {{ durationLabel }}</small>
        </div>
        <div class="lane a1-lane" :class="{ muted: audioMuted, solo: audioSolo }" @pointerdown="onTimelineBlankPointerDown">
          <div class="audio-clip">
            <canvas
              ref="audioCanvasEl"
              class="audio-canvas"
              role="img"
              :aria-label="audioWaveform ? `${audioWaveform.buckets.length} 个音频包络分桶` : '音频波形加载中或不可用'"
            ></canvas>
            <span class="audio-caption">
              <i v-if="audioLoading" class="audio-loading-dot"></i>
              {{ audioLoading ? '读取音频波形…' : mediaLabel }}
              <em>{{ durationLabel }}</em>
            </span>
          </div>
          <span class="playhead" :style="{ left: `${playheadPercent}%` }"></span>
        </div>
      </div>
    </div>
  </section>
</template>

<style scoped>
.timeline {
  position: relative;
  display: flex;
  /* 0.3.0 修复：矮窗口下允许时间线收缩，保证底部 transport 条始终可见 */
  flex: 0 1 auto;
  min-height: 150px;
  overflow: hidden;
  flex-direction: column;
  border: 1px solid var(--border);
  border-top: 0;
  background: #111923;
  color: var(--text-secondary);
}

.timeline-context {
  display: flex;
  height: 26px;
  align-items: stretch;
  gap: 10px;
  padding: 0 8px;
  border-bottom: 1px solid rgba(148, 163, 184, 0.12);
  background: #0c131c;
}

.timeline-tab {
  display: flex;
  min-width: 170px;
  align-items: center;
  gap: 7px;
  padding: 0 12px;
  border-right: 1px solid rgba(148, 163, 184, 0.12);
  border-left: 2px solid #3d8de8;
  background: rgba(61, 141, 232, 0.08);
  color: #dce7f5;
  font-size: 10px;
}

.timeline-tab em {
  color: #6f8194;
  font-family: var(--mono);
  font-size: 8px;
  font-style: normal;
}

.source-chip {
  align-self: center;
  padding: 2px 7px;
  border: 1px solid rgba(91, 112, 135, 0.22);
  border-radius: 3px;
  color: #687b90;
  font-size: 8px;
}

.timeline-actions {
  display: flex;
  align-items: center;
  gap: 5px;
}

.timeline-action {
  display: inline-flex;
  height: 20px;
  align-items: center;
  gap: 4px;
  padding: 0 7px;
  border: 1px solid rgba(91, 112, 135, 0.28);
  border-radius: 4px;
  background: rgba(16, 28, 41, 0.85);
  color: #a8bacd;
  font-size: 9px;
  cursor: pointer;
}

.timeline-action:hover:not(:disabled) {
  border-color: rgba(96, 165, 250, 0.5);
  color: #dcecff;
}

.timeline-action:disabled {
  opacity: 0.35;
  cursor: default;
}

.timeline-duration {
  margin-left: auto;
  align-self: center;
  color: #65788d;
  font-family: var(--mono);
  font-size: 9px;
}

.ruler-row,
.track-row {
  display: grid;
  min-width: 0;
  grid-template-columns: clamp(146px, 20vw, 232px) minmax(0, 1fr);
}

.ruler-row {
  position: relative;
  z-index: 12;
  height: 28px;
  border-bottom: 1px solid rgba(148, 163, 184, 0.16);
  background: #101821;
}

.ruler-head {
  display: flex;
  align-items: center;
  padding-left: 15px;
  border-right: 1px solid rgba(148, 163, 184, 0.16);
  color: #5e7186;
  font-size: 8px;
  letter-spacing: 0.6px;
}

.track-container {
  position: relative;
  min-width: 0;
  overflow: visible;
  cursor: crosshair;
}

.tick {
  position: absolute;
  top: 0;
  display: flex;
  height: 100%;
  align-items: flex-start;
  gap: 4px;
  pointer-events: none;
  transform: translateX(-50%);
}

.tick i {
  width: 1px;
  height: 6px;
  background: rgba(148, 163, 184, 0.34);
}

.tick em {
  color: #718397;
  font-family: var(--mono);
  font-size: 9px;
  font-style: normal;
  white-space: nowrap;
}

.tracks {
  position: relative;
  z-index: 1;
  display: flex;
  max-height: min(58vh, 620px);
  flex-direction: column;
  overflow-x: hidden;
  overflow-y: auto;
  scrollbar-gutter: stable;
}

.track-row {
  border-bottom: 1px solid rgba(148, 163, 184, 0.12);
}

.track-row-v2 {
  height: var(--track-height);
}

.track-row-v1 {
  height: var(--track-height);
}

.track-row-a1 {
  height: var(--audio-height);
}

.track-head {
  display: flex;
  height: 100%;
  min-width: 0;
  min-height: 0;
  flex-direction: column;
  justify-content: center;
  overflow: hidden;
  gap: 3px;
  padding: 7px 11px;
  border-right: 1px solid rgba(148, 163, 184, 0.16);
  background: #111923;
}

.track-head strong {
  overflow: hidden;
  color: #b9c7d7;
  font-size: 10px;
  font-weight: 600;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.track-head small {
  overflow: hidden;
  color: #687b90;
  font-size: 8px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.track-head.compact {
  gap: 0;
  padding-top: 2px;
  padding-bottom: 2px;
}

.track-head.compact .head-topline {
  min-height: 16px;
}

.track-head.compact .track-badge {
  min-width: 24px;
  height: 16px;
  font-size: 8px;
}

.track-head.compact .head-control {
  width: 16px;
  height: 16px;
  font-size: 9px;
}

.track-head.compact strong {
  font-size: 9px;
  line-height: 11px;
}

.track-head.compact small {
  font-size: 7px;
  line-height: 9px;
}

.audio-head.compact small {
  display: none;
}

.head-topline {
  display: flex;
  min-width: 0;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.track-badge {
  display: inline-grid;
  min-width: 28px;
  height: 19px;
  padding: 0 5px;
  border-radius: 3px;
  font-family: var(--mono);
  font-size: 9px;
  font-weight: 700;
  place-items: center;
}

.video-badge {
  border: 1px solid rgba(94, 155, 230, 0.5);
  background: rgba(49, 107, 173, 0.2);
  color: #8bb9ed;
}

.audio-badge {
  border: 1px solid rgba(72, 184, 143, 0.5);
  background: rgba(43, 145, 109, 0.2);
  color: #8ad9bb;
}

.head-actions {
  display: flex;
  align-items: center;
  gap: 2px;
}

.head-control {
  display: grid;
  width: 20px;
  height: 20px;
  padding: 0;
  border: 1px solid transparent;
  border-radius: 3px;
  background: transparent;
  color: #64778b;
  font-family: var(--mono);
  font-size: 11px;
  place-items: center;
}

.head-control:hover:not(:disabled) {
  border-color: rgba(148, 163, 184, 0.24);
  background: rgba(148, 163, 184, 0.08);
  color: #bac7d6;
}

.head-control.active {
  color: #72b4ff;
}

.head-control.muted-control {
  color: #455467;
  opacity: 0.65;
}

.letter-control {
  border-color: rgba(148, 163, 184, 0.16);
  font-size: 8px;
}

.letter-control.active {
  border-color: rgba(234, 179, 8, 0.55);
  background: rgba(234, 179, 8, 0.12);
  color: #f4c84a;
}

.lane {
  position: relative;
  min-width: 0;
  overflow: hidden;
  background-color: #111923;
  background-image: linear-gradient(
    to right,
    rgba(148, 163, 184, 0.09) 1px,
    transparent 1px
  );
  background-size: var(--second-px) 100%;
}

.v2-lane {
  height: 100%;
  padding: 4px 0;
  background-color: #101923;
}

.v1-lane {
  height: 100%;
  padding: 4px 0;
  background-color: #111923;
}

.a1-lane {
  height: 100%;
  padding: 4px 0;
  background-color: #101b18;
}

.v2-clip,
.v1-clip {
  position: absolute;
  top: 4px;
  bottom: 4px;
  min-width: 2px;
  overflow: hidden;
  border-radius: 4px;
}

.v2-clip {
  border: 1px solid rgba(99, 151, 207, 0.56);
  background: #1a3047;
  cursor: pointer;
}

.v2-clip.selected {
  border-color: #e7f2ff;
  box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.34);
  z-index: 3;
}

.v2-clip.current {
  border-color: #f4c84a;
}

.v2-tiles {
  position: absolute;
  inset: 0 0 18px;
  display: flex;
  overflow: hidden;
  background: #0a1119;
}

.v2-tiles img {
  width: 90px;
  min-width: 1px;
  height: 100%;
  flex: 1 1 0;
  border-right: 1px solid rgba(0, 0, 0, 0.34);
  object-fit: cover;
  user-select: none;
}

.v2-fallback {
  position: absolute;
  inset: 0 0 18px;
  display: grid;
  background:
    linear-gradient(135deg, rgba(69, 118, 168, 0.24), rgba(25, 48, 71, 0.38)),
    #152435;
  color: #7395b8;
  font-family: var(--mono);
  font-size: 10px;
  place-items: center;
}

.v2-caption {
  position: absolute;
  right: 0;
  bottom: 0;
  left: 0;
  display: flex;
  height: 18px;
  align-items: center;
  gap: 5px;
  padding: 0 5px;
  background: rgba(33, 64, 91, 0.9);
  color: #cfdce9;
  font-size: 8px;
}

.v2-caption span {
  overflow: hidden;
  min-width: 0;
  flex: 1;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.v2-caption em {
  color: #89a1b8;
  font-family: var(--mono);
  font-size: 7px;
  font-style: normal;
  white-space: nowrap;
}

.v1-clip {
  border: 1px solid rgba(185, 145, 214, 0.72);
  background:
    linear-gradient(180deg, rgba(175, 126, 202, 0.9), rgba(112, 77, 137, 0.82));
  cursor: pointer;
}

.v1-clip.selected {
  border-color: #f7fbff;
  box-shadow:
    inset 0 0 0 1px rgba(255, 255, 255, 0.48),
    0 0 0 1px rgba(255, 255, 255, 0.28);
  z-index: 4;
}

.v1-clip.partner-selected:not(.selected) {
  border-color: rgba(244, 200, 74, 0.82);
  box-shadow: inset 0 0 0 1px rgba(244, 200, 74, 0.35);
}

.v1-clip.current {
  background:
    linear-gradient(180deg, rgba(196, 151, 221, 0.96), rgba(126, 87, 153, 0.9));
}

.v1-clip.dragging {
  filter: brightness(1.15);
}

.v1-copy {
  display: flex;
  height: 100%;
  min-width: 0;
  flex-direction: column;
  justify-content: center;
  gap: 2px;
  padding: 3px 9px;
  pointer-events: none;
}

.v1-index {
  color: rgba(247, 242, 250, 0.7);
  font-family: var(--mono);
  font-size: 8px;
}

.v1-copy strong {
  overflow: hidden;
  color: #fbf7fd;
  font-size: 9px;
  font-weight: 600;
  line-height: 1.15;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.v1-copy small {
  overflow: hidden;
  color: rgba(240, 228, 247, 0.74);
  font-family: var(--mono);
  font-size: 7px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.trim-handle {
  position: absolute;
  top: 0;
  bottom: 0;
  z-index: 7;
  width: 7px;
  padding: 0;
  border: 0;
  background: transparent;
  cursor: col-resize;
}

.trim-handle::after {
  position: absolute;
  top: 24%;
  bottom: 24%;
  width: 2px;
  border-radius: 1px;
  background: rgba(255, 255, 255, 0.8);
  content: '';
  opacity: 0;
  transition: opacity 120ms ease;
}

.trim-left {
  left: 0;
}

.trim-left::after {
  left: 2px;
}

.trim-right {
  right: 0;
}

.trim-right::after {
  right: 2px;
}

.v1-clip:hover .trim-handle::after,
.v1-clip.selected .trim-handle::after {
  opacity: 1;
}

.selection-range {
  position: absolute;
  top: 0;
  bottom: 0;
  z-index: 1;
  border-right: 1px solid rgba(74, 222, 128, 0.64);
  border-left: 1px solid rgba(74, 222, 128, 0.64);
  background: rgba(34, 197, 94, 0.13);
  pointer-events: none;
}

.marker-pin {
  position: absolute;
  top: 0;
  z-index: 9;
  width: 1px;
  height: 9px;
  padding: 0;
  border: 0;
  background: #f4c84a;
  cursor: pointer;
}

.marker-pin span {
  position: absolute;
  top: 0;
  left: -3px;
  width: 7px;
  height: 5px;
  border-radius: 0 0 2px 2px;
  background: inherit;
}

.marker-pin.note {
  background: #57d7a6;
}

.audio-clip {
  position: absolute;
  inset: 4px 0;
  overflow: hidden;
  border: 1px solid rgba(99, 197, 157, 0.62);
  border-radius: 4px;
  background: #245c47;
}

.audio-canvas {
  display: block;
  width: 100%;
  height: 100%;
}

.audio-caption {
  position: absolute;
  right: 7px;
  bottom: 4px;
  left: 8px;
  display: flex;
  align-items: center;
  gap: 6px;
  overflow: hidden;
  color: rgba(236, 255, 247, 0.92);
  font-size: 8px;
  text-shadow: 0 1px 2px rgba(0, 0, 0, 0.65);
  white-space: nowrap;
}

.audio-caption em {
  color: rgba(208, 238, 226, 0.68);
  font-family: var(--mono);
  font-size: 7px;
  font-style: normal;
}

.audio-loading-dot {
  width: 4px;
  height: 4px;
  flex: 0 0 auto;
  border-radius: 50%;
  background: #f4c84a;
  animation: audio-pulse 900ms ease-in-out infinite;
}

.a1-lane.muted .audio-clip,
.track-muted .audio-clip {
  opacity: 0.42;
}

.a1-lane.solo .audio-clip {
  border-color: #f4c84a;
  box-shadow: inset 0 0 0 1px rgba(244, 200, 74, 0.22);
}

.lane-empty {
  position: absolute;
  top: 50%;
  left: 50%;
  color: #4e6277;
  font-size: 9px;
  pointer-events: none;
  transform: translate(-50%, -50%);
  white-space: nowrap;
}

.hidden-note {
  color: #667b90;
}

.track-hidden .lane {
  opacity: 0.48;
}

.playhead {
  position: absolute;
  top: 0;
  bottom: 0;
  z-index: 15;
  width: 1px;
  background: #f2f7fd;
  pointer-events: none;
  transform: translateX(-50%);
}

.playhead::before {
  position: absolute;
  top: 0;
  left: -2px;
  width: 5px;
  height: 5px;
  border-radius: 1px;
  background: #f2f7fd;
  content: '';
}

.playhead-ruler {
  top: 0;
  bottom: 0;
}

.zoom-ctl {
  position: absolute;
  top: 4px;
  right: 7px;
  z-index: 80;
}

.zoom-btn {
  display: flex;
  height: 20px;
  align-items: center;
  gap: 4px;
  padding: 0 8px;
  border: 1px solid rgba(100, 116, 139, 0.35);
  border-radius: 999px;
  background: rgba(38, 52, 73, 0.9);
  color: #788ca1;
  font-family: var(--mono);
  font-size: 8px;
  white-space: nowrap;
}

.zoom-btn:hover,
.zoom-btn.active {
  border-color: rgba(148, 163, 184, 0.58);
  color: #b7c5d5;
}

.zoom-btn.dragging {
  border-color: rgba(96, 165, 250, 0.5);
  color: #72b4ff;
}

.zoom-pop {
  position: absolute;
  top: calc(100% + 6px);
  right: 0;
  z-index: 90;
  display: flex;
  width: 280px;
  flex-direction: column;
  gap: 8px;
  padding: 10px;
  border: 1px solid var(--border-strong);
  border-radius: 8px;
  background: #141e2a;
  box-shadow: 0 12px 32px rgba(0, 0, 0, 0.5);
}

.zoom-row {
  display: grid;
  grid-template-columns: 54px minmax(0, 1fr) 46px;
  align-items: center;
  gap: 6px;
}

.zoom-row > span {
  color: #718397;
  font-size: 9px;
}

.zoom-row input[type='range'] {
  width: 100%;
  min-width: 0;
  accent-color: #4b95e8;
}

.zoom-num {
  width: 46px;
  height: 24px;
  padding: 0 4px;
  border: 1px solid var(--border);
  border-radius: 4px;
  outline: 0;
  background: var(--bg-raised);
  color: var(--text-secondary);
  font-family: var(--mono);
  font-size: 9px;
  text-align: right;
}

.zoom-num:focus {
  border-color: var(--border-strong);
}

.zoom-pop-foot {
  display: flex;
  align-items: center;
  gap: 8px;
}

.zoom-reset {
  height: 24px;
  padding: 0 8px;
  border: 1px solid var(--border);
  border-radius: 4px;
  background: var(--bg-raised);
  color: var(--text-muted);
  font-size: 8px;
  white-space: nowrap;
}

.zoom-hint {
  color: #5f7084;
  font-size: 8px;
}

.navigator-row {
  display: grid;
  height: 24px;
  grid-template-columns: clamp(146px, 20vw, 232px) minmax(0, 1fr);
  border-bottom: 1px solid rgba(148, 163, 184, 0.14);
  background: #0e1620;
}

.navigator-label {
  display: flex;
  align-items: center;
  padding-left: 15px;
  border-right: 1px solid rgba(148, 163, 184, 0.16);
  color: #5e7186;
  font-size: 8px;
  letter-spacing: 0.6px;
}

.navigator-track {
  position: relative;
  display: flex;
  min-width: 0;
  align-items: center;
  padding: 0 12px;
}

.timeline-navigator-slider {
  width: 100%;
  height: 14px;
  margin: 0;
  accent-color: #4b95e8;
  cursor: ew-resize;
}

.timeline-navigator-slider:disabled {
  cursor: default;
  opacity: 0.35;
}

.navigator-range-label {
  position: absolute;
  right: 13px;
  bottom: -1px;
  padding: 0 3px;
  background: #0e1620;
  color: #5e7186;
  font-family: var(--mono);
  font-size: 7px;
  pointer-events: none;
}

@keyframes audio-pulse {
  50% {
    opacity: 0.35;
  }
}

@media (max-width: 980px) {
  .source-chip {
    display: none;
  }

  .ruler-row,
  .track-row,
  .navigator-row {
    grid-template-columns: 132px minmax(0, 1fr);
  }

  .track-head {
    padding-right: 7px;
    padding-left: 8px;
  }

  .v1-copy small {
    display: none;
  }
}
</style>
