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
  currentTimeMs: number;
  durationMs: number;
  fps: number;
  audioWaveform: AudioWaveform | null;
  audioLoading?: boolean;
  /** S36-3a：轨道高度（px），5 档 48/96/144/192/240。 */
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
  select: [shot: WorkspaceShot];
  boundaryChange: [change: BoundaryChange];
  boundaryCommit: [change: BoundaryChange];
  updateTrackHeight: [value: number];
  updatePxPerSecond: [value: number];
}>();

const filmTrackEl = ref<HTMLElement | null>(null);
const shotCanvasEl = ref<HTMLCanvasElement | null>(null);
const markerCanvasEl = ref<HTMLCanvasElement | null>(null);
const audioCanvasEl = ref<HTMLCanvasElement | null>(null);
const trackContainerEl = ref<HTMLElement | null>(null);
const draggingBoundary = ref<number | null>(null);
const viewStartMs = ref(0);
const trackWidthPx = ref(0);
let activeBoundary: number | null = null;
let latestBoundaryTime = 0;
let boundaryMinTime = 0;
let boundaryMaxTime = 0;
let drawFrame = 0;
let resizeObserver: ResizeObserver | null = null;
let scrubElement: HTMLElement | null = null;
let dividerStartY = 0;
let dividerStartHeight = 0;

const thumbnailImages = new Map<string, HTMLImageElement | null>();

const safeDuration = computed(() => Math.max(1, props.durationMs));
const visibleDurationMs = computed(() =>
  trackWidthPx.value > 0
    ? (trackWidthPx.value / Math.max(1, props.pxPerSecond)) * 1000
    : safeDuration.value,
);
const maxViewStartMs = computed(() => Math.max(0, safeDuration.value - visibleDurationMs.value));
const playheadPercent = computed(() =>
  clampPercent(((props.currentTimeMs - viewStartMs.value) / visibleDurationMs.value) * 100),
);

function clampPercent(value: number): number {
  return Math.max(0, Math.min(100, value));
}

function clampIndex(value: number, length: number): number {
  return Math.max(0, Math.min(length - 1, value));
}

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

function formatSecond(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  return `${pad2(hours)}:${pad2(minutes)}:${pad2(seconds)}`;
}

function formatTenSecond(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${pad2(seconds)}`;
}

const ticks = computed(() => {
  const width = trackWidthPx.value;
  const start = viewStartMs.value;
  const duration = visibleDurationMs.value;
  if (width <= 0 || !Number.isFinite(duration) || duration <= 0) return [];

  const frameMs = 1000 / Math.max(1, props.fps || 24);
  const msPerPixel = 1000 / Math.max(1, props.pxPerSecond);
  const minSpacingPx = 80;

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
    if (mode === 'second') return formatSecond(ms);
    return formatTenSecond(ms);
  };

  const list: Array<{ percent: number; label: string }> = [];
  let first = Math.ceil(start / interval) * interval;
  if (mode === 'frame') first = Math.ceil(start / frameMs) * frameMs;
  const end = start + duration;
  for (let t = first; t <= end; t += interval) {
    if (t < 0) continue;
    list.push({ percent: ((t - start) / duration) * 100, label: labelFor(t) });
    if (list.length > 300) break;
  }
  return list;
});

const densityLabel = computed(() => `${props.pxPerSecond} px/s`);
const heightLabel = computed(() => `${props.trackHeight}px`);

/** S36-8：音量式缩放控件状态。 */
const zoomOpen = ref(false);
const zoomDragging = ref(false);
const zoomHeightDraft = ref(String(props.trackHeight));
const zoomDensityDraft = ref(String(props.pxPerSecond));
const zoomHeightEditing = ref(false);
const zoomDensityEditing = ref(false);
const zoomCtlEl = ref<HTMLElement | null>(null);

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
  setPxPerSecond(value);
  zoomDensityDraft.value = String(snapToLevel(value, PX_PER_SEC_LEVELS));
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
  scheduleDraw();
}

function setPxPerSecond(nextPx: number, anchorClientX?: number): void {
  const clamped = snapToLevel(nextPx, PX_PER_SEC_LEVELS);
  if (clamped === props.pxPerSecond) return;
  const width = trackWidthPx.value;
  const ratio =
    width > 0 && anchorClientX !== undefined
      ? Math.max(
          0,
          Math.min(1, (anchorClientX - (trackContainerEl.value?.getBoundingClientRect().left ?? 0)) / width),
        )
      : 0.5;
  const anchorTime = viewStartMs.value + visibleDurationMs.value * ratio;
  emit('updatePxPerSecond', clamped);
  const nextVisible = width > 0 ? (width / clamped) * 1000 : safeDuration.value / clamped;
  viewStartMs.value = clampViewStart(anchorTime - nextVisible * ratio);
  scheduleDraw();
}

function stepPxPerSecond(direction: 1 | -1): number {
  const index = PX_PER_SEC_LEVELS.indexOf(props.pxPerSecond);
  const base = index >= 0 ? index : PX_PER_SEC_LEVELS.indexOf(96);
  const next = PX_PER_SEC_LEVELS[clampIndex(base + direction, PX_PER_SEC_LEVELS.length)];
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

function panView(event: WheelEvent): void {
  const delta =
    Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.shiftKey ? event.deltaY : 0;
  if (delta === 0) return;
  event.preventDefault();
  const rect = trackContainerEl.value?.getBoundingClientRect();
  if (!rect || rect.width <= 0) return;
  viewStartMs.value = clampViewStart(viewStartMs.value + (delta / rect.width) * visibleDurationMs.value);
  scheduleDraw();
}

function onRulerWheel(event: WheelEvent): void {
  if (event.ctrlKey || event.metaKey) {
    event.preventDefault();
    stepPxPerSecond(event.deltaY < 0 ? 1 : -1);
    return;
  }
  panView(event);
}

function onTracksWheel(event: WheelEvent): void {
  if (event.ctrlKey || event.metaKey) {
    event.preventDefault();
    stepTrackHeight(event.deltaY < 0 ? 1 : -1);
    return;
  }
  panView(event);
}

function beginDividerDrag(event: PointerEvent): void {
  event.preventDefault();
  dividerStartY = event.clientY;
  dividerStartHeight = props.trackHeight;
  window.addEventListener('pointermove', handleDividerMove);
  window.addEventListener('pointerup', finishDividerDrag, { once: true });
}

function handleDividerMove(event: PointerEvent): void {
  const delta = event.clientY - dividerStartY;
  const target = snapToLevel(dividerStartHeight + delta, TRACK_HEIGHT_LEVELS);
  if (target !== props.trackHeight) emit('updateTrackHeight', target);
}

function finishDividerDrag(): void {
  window.removeEventListener('pointermove', handleDividerMove);
}

function seekFromPointer(event: PointerEvent): void {
  beginScrub(event, filmTrackEl.value);
}

function seekFromAudioPointer(event: PointerEvent): void {
  beginScrub(event, audioCanvasEl.value);
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

function findShotIndexAtX(clientX: number): number {
  const canvas = shotCanvasEl.value;
  const rect = canvas?.getBoundingClientRect();
  if (!rect) return -1;
  const timeMs = timeFromClientX(clientX, canvas);
  let low = 0;
  let high = props.shots.length - 1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    const shot = props.shots[middle];
    if (timeMs < shot.startMs) high = middle - 1;
    else if (timeMs >= shot.endMs) low = middle + 1;
    else return middle;
  }
  return -1;
}

function findBoundaryAtX(clientX: number): number {
  const canvas = shotCanvasEl.value;
  const rect = canvas?.getBoundingClientRect();
  if (!rect) return -1;
  for (let index = 0; index < props.shots.length - 1; index += 1) {
    const boundaryX =
      rect.left +
      ((props.shots[index].endMs - viewStartMs.value) / visibleDurationMs.value) * rect.width;
    if (boundaryX < rect.left - 5 || boundaryX > rect.right + 5) continue;
    if (Math.abs(clientX - boundaryX) <= 5) return index;
  }
  return -1;
}

function onShotPointerDown(event: PointerEvent): void {
  event.preventDefault();
  const boundary = findBoundaryAtX(event.clientX);
  if (boundary >= 0) {
    beginBoundaryDrag(boundary, event);
    return;
  }
  const index = findShotIndexAtX(event.clientX);
  if (index >= 0) {
    const shot = props.shots[index];
    emit('select', shot);
    emit('seek', shot.startMs);
    return;
  }
  emit('seek', timeFromClientX(event.clientX, shotCanvasEl.value));
}

function onMarkerPointerDown(event: PointerEvent): void {
  const canvas = markerCanvasEl.value;
  const rect = canvas?.getBoundingClientRect();
  if (!rect || props.markers.length === 0) return;
  const targetX = event.clientX - rect.left;
  let nearest: TimelineMarker | null = null;
  let nearestDistance = Number.POSITIVE_INFINITY;
  for (const marker of props.markers) {
    const distance = Math.abs(
      ((marker.timeMs - viewStartMs.value) / visibleDurationMs.value) * rect.width - targetX,
    );
    if (distance < nearestDistance) {
      nearest = marker;
      nearestDistance = distance;
    }
  }
  if (nearest && nearestDistance <= 7) {
    const shot = props.shots.find((item) => item.id === nearest?.shotId);
    if (shot) emit('select', shot);
    emit('seek', nearest.timeMs);
    return;
  }
  emit('seek', timeFromClientX(event.clientX, canvas));
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
  scheduleDraw();
  window.addEventListener('pointermove', handleBoundaryMove);
  window.addEventListener('pointerup', finishBoundaryDrag, { once: true });
  handleBoundaryMove(event);
}

function handleBoundaryMove(event: PointerEvent): void {
  if (activeBoundary === null) return;
  const candidate = Math.max(
    boundaryMinTime,
    Math.min(boundaryMaxTime, timeFromClientX(event.clientX, shotCanvasEl.value)),
  );
  latestBoundaryTime = candidate;
  emit('boundaryChange', { index: activeBoundary, timeMs: candidate });
  scheduleDraw();
}

function finishBoundaryDrag(): void {
  window.removeEventListener('pointermove', handleBoundaryMove);
  if (activeBoundary !== null) {
    emit('boundaryCommit', { index: activeBoundary, timeMs: latestBoundaryTime });
  }
  activeBoundary = null;
  draggingBoundary.value = null;
  scheduleDraw();
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

function loadThumbnail(url: string): void {
  if (thumbnailImages.has(url)) {
    const cached = thumbnailImages.get(url);
    if (cached) scheduleDraw();
    return;
  }
  thumbnailImages.set(url, null);
  const image = new Image();
  image.onload = () => {
    thumbnailImages.set(url, image);
    scheduleDraw();
  };
  image.onerror = () => {
    thumbnailImages.set(url, null);
  };
  image.src = url;
}

function drawTimeline(): void {
  drawFrame = 0;
  const shotCanvas = shotCanvasEl.value;
  const markerCanvas = markerCanvasEl.value;
  const audioCanvas = audioCanvasEl.value;
  if (!shotCanvas || !markerCanvas || !audioCanvas) return;

  const shotContext = resizeCanvas(shotCanvas);
  const markerContext = resizeCanvas(markerCanvas);
  const audioContext = resizeCanvas(audioCanvas);
  if (!shotContext || !markerContext || !audioContext) return;

  const shotRect = shotCanvas.getBoundingClientRect();
  const markerRect = markerCanvas.getBoundingClientRect();
  const audioRect = audioCanvas.getBoundingClientRect();
  const shotWidth = shotRect.width;
  const shotHeight = shotRect.height;
  const markerWidth = markerRect.width;
  const markerHeight = markerRect.height;
  const audioWidth = audioRect.width;
  const audioHeight = audioRect.height;

  shotContext.clearRect(0, 0, shotWidth, shotHeight);
  markerContext.clearRect(0, 0, markerWidth, markerHeight);
  audioContext.clearRect(0, 0, audioWidth, audioHeight);

  const selectedId = props.selectedId;
  const currentTime = props.currentTimeMs;
  const viewEnd = viewStartMs.value + visibleDurationMs.value;

  if (props.inPointMs !== null && props.outPointMs !== null) {
    const leftMs = Math.min(props.inPointMs, props.outPointMs);
    const rightMs = Math.max(props.inPointMs, props.outPointMs);
    if (rightMs > viewStartMs.value && leftMs < viewEnd) {
      const x1 = ((leftMs - viewStartMs.value) / visibleDurationMs.value) * shotWidth;
      const x2 = ((rightMs - viewStartMs.value) / visibleDurationMs.value) * shotWidth;
      shotContext.fillStyle = 'rgba(34, 197, 94, 0.18)';
      shotContext.fillRect(Math.max(0, x1), 0, Math.max(1, x2 - x1), shotHeight);
    }
  }

  shotContext.imageSmoothingEnabled = true;
  shotContext.imageSmoothingQuality = 'high';

  for (let index = 0; index < props.shots.length; index += 1) {
    const shot = props.shots[index];
    if (shot.endMs < viewStartMs.value || shot.startMs > viewEnd) continue;
    const x = ((shot.startMs - viewStartMs.value) / visibleDurationMs.value) * shotWidth;
    const rawWidth = ((shot.endMs - shot.startMs) / visibleDurationMs.value) * shotWidth;
    const width = Math.max(1, rawWidth - 0.7);
    const isCurrent = currentTime >= shot.startMs && currentTime < shot.endMs;
    const isSelected = shot.id === selectedId;

    if (shot.thumbnail && !thumbnailImages.has(shot.thumbnail)) loadThumbnail(shot.thumbnail);
    const image = shot.thumbnail ? thumbnailImages.get(shot.thumbnail) : undefined;
    if (image) {
      shotContext.drawImage(image, x + 1, 1, Math.max(1, width - 2), Math.max(1, shotHeight - 2));
    } else {
      shotContext.fillStyle = isCurrent ? '#fbbf24' : '#f59e0b';
      shotContext.fillRect(x, 0, width, shotHeight);
    }

    shotContext.fillStyle = '#0f172a';
    shotContext.fillRect(x + Math.max(1, width - 0.7), 0, 0.7, shotHeight);

    if (isSelected) {
      shotContext.strokeStyle = '#ffffff';
      shotContext.lineWidth = 2;
      shotContext.strokeRect(x + 1, 1, Math.max(1, width - 2), Math.max(1, shotHeight - 2));
    }

    if (width >= 23 && props.trackHeight >= 96) {
      shotContext.fillStyle = isCurrent ? '#1f2937' : '#ffffff';
      shotContext.font = '600 10px "Cascadia Mono", Consolas, monospace';
      shotContext.textAlign = 'center';
      shotContext.textBaseline = 'middle';
      shotContext.fillText(String(shot.index).padStart(2, '0'), x + width / 2, shotHeight / 2);
    }
  }

  if (draggingBoundary.value !== null) {
    const shot = props.shots[draggingBoundary.value];
    if (shot) {
      const x = ((shot.endMs - viewStartMs.value) / visibleDurationMs.value) * shotWidth;
      shotContext.strokeStyle = '#fbbf24';
      shotContext.lineWidth = 2;
      shotContext.beginPath();
      shotContext.moveTo(x, 0);
      shotContext.lineTo(x, shotHeight);
      shotContext.stroke();
    }
  }

  const playheadX = ((currentTime - viewStartMs.value) / visibleDurationMs.value) * shotWidth;
  shotContext.strokeStyle = '#ffffff';
  shotContext.lineWidth = 1;
  shotContext.beginPath();
  shotContext.moveTo(playheadX, 0);
  shotContext.lineTo(playheadX, shotHeight);
  shotContext.stroke();

  markerContext.strokeStyle = 'rgba(71, 85, 105, 0.6)';
  markerContext.lineWidth = 1;
  markerContext.setLineDash([3, 3]);
  markerContext.beginPath();
  markerContext.moveTo(0, markerHeight / 2);
  markerContext.lineTo(markerWidth, markerHeight / 2);
  markerContext.stroke();
  markerContext.setLineDash([]);

  markerContext.fillStyle = '#22c55e';
  for (const marker of props.markers) {
    if (marker.timeMs < viewStartMs.value || marker.timeMs > viewEnd) continue;
    const x = ((marker.timeMs - viewStartMs.value) / visibleDurationMs.value) * markerWidth;
    markerContext.fillRect(x - 1, Math.max(2, markerHeight / 2 - 5), 2, Math.min(10, markerHeight - 4));
  }

  markerContext.strokeStyle = '#ffffff';
  markerContext.lineWidth = 1;
  markerContext.beginPath();
  markerContext.moveTo(playheadX, 0);
  markerContext.lineTo(playheadX, markerHeight);
  markerContext.stroke();

  const audioCenterY = audioHeight / 2;
  audioContext.strokeStyle = 'rgba(100, 116, 139, 0.52)';
  audioContext.lineWidth = 1;
  audioContext.setLineDash([3, 3]);
  audioContext.beginPath();
  audioContext.moveTo(0, audioCenterY);
  audioContext.lineTo(audioWidth, audioCenterY);
  audioContext.stroke();
  audioContext.setLineDash([]);

  if (props.audioWaveform) {
    const bucketWidthMs = props.audioWaveform.bucketMs;
    const halfHeight = Math.max(2, audioHeight / 2 - 2);
    for (const bucket of props.audioWaveform.buckets) {
      if (
        bucket.startMs + bucketWidthMs < viewStartMs.value ||
        bucket.startMs > viewEnd
      ) {
        continue;
      }
      const x = ((bucket.startMs - viewStartMs.value) / visibleDurationMs.value) * audioWidth;
      const width = Math.max(1, (bucketWidthMs / visibleDurationMs.value) * audioWidth - 0.35);
      const peakHeight = Math.max(0.5, bucket.peak * halfHeight);
      const rmsHeight = Math.max(0.5, bucket.rms * halfHeight);
      audioContext.fillStyle = 'rgba(56, 189, 248, 0.24)';
      audioContext.fillRect(x, audioCenterY - peakHeight, width, peakHeight * 2);
      audioContext.fillStyle = 'rgba(125, 211, 252, 0.68)';
      audioContext.fillRect(x, audioCenterY - rmsHeight, width, rmsHeight * 2);
    }
  }

  audioContext.strokeStyle = '#ef4444';
  audioContext.lineWidth = 1;
  audioContext.beginPath();
  audioContext.moveTo(playheadX, 0);
  audioContext.lineTo(playheadX, audioHeight);
  audioContext.stroke();
}

function scheduleDraw(): void {
  if (drawFrame) return;
  drawFrame = requestAnimationFrame(drawTimeline);
}

watch(
  () => [
    props.shots,
    props.markers,
    props.audioWaveform,
    props.selectedId,
    props.currentTimeMs,
    props.durationMs,
    props.trackHeight,
    props.pxPerSecond,
    props.inPointMs,
    props.outPointMs,
    draggingBoundary.value,
    viewStartMs.value,
    trackWidthPx.value,
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
    scheduleDraw();
  },
);

function measureTrackWidth(): void {
  const rect = trackContainerEl.value?.getBoundingClientRect();
  trackWidthPx.value = rect && rect.width > 0 ? rect.width : 0;
}

onMounted(async () => {
  await nextTick();
  document.addEventListener('pointerdown', onDocumentPointerDown);
  measureTrackWidth();
  // px/s 档位不再「整条时间线适配一屏」，初始视窗对准播放头，避免播放头在视野外。
  viewStartMs.value = clampViewStart(props.currentTimeMs - visibleDurationMs.value * 0.12);
  resizeObserver = new ResizeObserver(() => {
    measureTrackWidth();
    scheduleDraw();
  });
  if (trackContainerEl.value) resizeObserver.observe(trackContainerEl.value);
  if (shotCanvasEl.value) resizeObserver.observe(shotCanvasEl.value);
  if (markerCanvasEl.value) resizeObserver.observe(markerCanvasEl.value);
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
  window.removeEventListener('pointermove', handleDividerMove);
  window.removeEventListener('pointerup', finishDividerDrag);
});
</script>

<template>
  <section class="timeline" :style="{ '--track-height': `${trackHeight}px` }">
    <div class="ruler-row" @wheel="onRulerWheel">
      <span class="label">缩放</span>
      <div ref="trackContainerEl" class="track-container">
        <span v-for="tick in ticks" :key="`${tick.percent}-${tick.label}`" class="tick" :style="{ left: `${tick.percent}%` }">
          <i></i><em>{{ tick.label }}</em>
        </span>
        <div ref="zoomCtlEl" class="zoom-ctl">
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
                min="48"
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
                min="48"
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

    <div class="tracks" @wheel="onTracksWheel">
      <div class="track-row">
        <span class="label">影片</span>
        <button
          ref="filmTrackEl"
          class="track film"
          type="button"
          aria-label="影片层，点击跳转播放位置"
          @pointerdown="seekFromPointer"
        >
          <span class="film-base"></span>
          <span class="film-progress" :style="{ width: `${playheadPercent}%` }"></span>
          <span class="playhead" :style="{ left: `${playheadPercent}%` }"></span>
        </button>
      </div>

      <div class="track-divider" role="separator" aria-label="拖动分隔条调节轨道高度" @pointerdown="beginDividerDrag"></div>

      <div class="track-row">
        <span class="label">镜头</span>
        <div class="track canvas-track shot-track">
          <canvas
            ref="shotCanvasEl"
            class="timeline-canvas"
            role="img"
            :aria-label="`${shots.length} 个镜头分段，点击跳转，拖动边界微调`"
            @pointerdown="onShotPointerDown"
          ></canvas>
        </div>
      </div>

      <div class="track-divider" role="separator" aria-label="拖动分隔条调节轨道高度" @pointerdown="beginDividerDrag"></div>

      <div class="track-row">
        <span class="label">标注</span>
        <div class="track canvas-track marker-track">
          <canvas
            ref="markerCanvasEl"
            class="timeline-canvas"
            role="img"
            :aria-label="`${markers.length} 个截图或笔记标记`"
            @pointerdown="onMarkerPointerDown"
          ></canvas>
        </div>
      </div>

      <div class="track-divider" role="separator" aria-label="拖动分隔条调节轨道高度" @pointerdown="beginDividerDrag"></div>

      <div class="track-row">
        <span class="label audio-label">
          音频
          <i v-if="audioLoading" class="audio-loading-dot"></i>
        </span>
        <div class="track canvas-track audio-track">
          <canvas
            ref="audioCanvasEl"
            class="timeline-canvas"
            role="img"
            :aria-label="audioWaveform ? `${audioWaveform.buckets.length} 个音频包络分桶` : '音频波形加载中或不可用'"
            @pointerdown="seekFromAudioPointer"
          ></canvas>
        </div>
      </div>
    </div>
  </section>
</template>

<style scoped>
.timeline {
  display: flex;
  flex: 0 0 auto;
  flex-direction: column;
  gap: 2px;
  padding: 4px 12px;
  border: 1px solid var(--border);
  border-top: 0;
  border-radius: 0;
  background: var(--bg-panel);
}

.tracks {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.ruler-row,
.track-row {
  display: grid;
  min-width: 0;
  grid-template-columns: 40px minmax(0, 1fr);
  align-items: center;
}

.ruler-row {
  height: 16px;
}

.track-container {
  position: relative;
  height: 16px;
}

.label {
  color: var(--text-faint);
  font-size: 10px;
}

.zoom-ctl {
  position: absolute;
  top: -4px;
  right: 0;
  z-index: 20;
}

.zoom-btn {
  display: flex;
  height: 20px;
  align-items: center;
  gap: 4px;
  padding: 0 8px;
  border: 1px solid rgba(100, 116, 139, 0.35);
  border-radius: 999px;
  background: rgba(38, 52, 73, 0.78);
  color: var(--text-faint);
  font-family: var(--mono);
  font-size: 8px;
  white-space: nowrap;
}

.zoom-btn:hover,
.zoom-btn.active {
  border-color: var(--border-strong);
  color: var(--text-secondary);
}

.zoom-btn.dragging {
  border-color: rgba(96, 165, 250, 0.5);
  color: var(--blue-hi);
}

.zoom-pop {
  position: absolute;
  top: calc(100% + 6px);
  right: 0;
  z-index: 60;
  display: flex;
  width: 280px;
  flex-direction: column;
  gap: 8px;
  padding: 10px;
  border: 1px solid var(--border-strong);
  border-radius: 8px;
  background: var(--bg-panel);
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.4);
}

.zoom-row {
  display: grid;
  grid-template-columns: 54px minmax(0, 1fr) 46px;
  align-items: center;
  gap: 6px;
}

.zoom-row > span {
  color: var(--text-faint);
  font-size: 9px;
}

.zoom-row input[type='range'] {
  width: 100%;
  min-width: 0;
  accent-color: var(--blue);
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
  color: var(--text-faint);
  font-size: 8px;
}

.tick {
  position: absolute;
  top: 0;
  display: flex;
  align-items: center;
  gap: 4px;
  transform: translateX(-50%);
}

.tick i {
  width: 1px;
  height: 4px;
  background: var(--border);
}

.tick em {
  color: var(--text-faint);
  font-family: var(--mono);
  font-size: 10px;
  font-style: normal;
  white-space: nowrap;
}

.track {
  position: relative;
  min-width: 0;
  padding: 0;
  border: 0;
  background: transparent;
}

.film {
  height: var(--track-height);
}

.film-base,
.film-progress {
  position: absolute;
  top: 50%;
  left: 0;
  height: 12px;
  border-radius: 3px;
  transform: translateY(-50%);
}

.film-base {
  width: 100%;
  background: rgba(59, 130, 246, 0.2);
}

.film-progress {
  background: var(--blue-hi);
}

.canvas-track {
  height: var(--track-height);
  cursor: pointer;
}

.track-divider {
  height: 5px;
  margin-left: 40px;
  border-radius: 2px;
  background: transparent;
  cursor: row-resize;
  transition: background 120ms ease;
}

.track-divider:hover {
  background: rgba(148, 163, 184, 0.28);
}

.audio-label {
  display: flex;
  align-items: center;
  gap: 3px;
}

.audio-loading-dot {
  width: 4px;
  height: 4px;
  border-radius: 50%;
  background: var(--amber);
  animation: audio-pulse 900ms ease-in-out infinite;
}

.audio-track .timeline-canvas {
  cursor: crosshair;
}

@keyframes audio-pulse {
  50% {
    opacity: 0.35;
  }
}

.timeline-canvas {
  display: block;
  width: 100%;
  height: 100%;
}

.shot-track .timeline-canvas {
  cursor: col-resize;
}

.marker-track .timeline-canvas {
  cursor: crosshair;
}

.playhead {
  position: absolute;
  top: -4px;
  bottom: -4px;
  width: 1px;
  background: #fff;
  pointer-events: none;
  transform: translateX(-50%);
  z-index: 3;
}

.playhead::before {
  position: absolute;
  top: -1px;
  left: -2px;
  width: 5px;
  height: 5px;
  border-radius: 1px;
  background: #fff;
  content: '';
}

.playhead-ruler {
  top: 10px;
  bottom: auto;
  height: 6px;
}
</style>
