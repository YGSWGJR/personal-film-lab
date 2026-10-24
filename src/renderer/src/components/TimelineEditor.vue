<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import type { BoundaryChange, TimelineMarker, WorkspaceShot } from '../types/workspace';

const props = defineProps<{
  shots: WorkspaceShot[];
  markers: TimelineMarker[];
  selectedId: string | null;
  currentTimeMs: number;
  durationMs: number;
  fps: number;
}>();

const emit = defineEmits<{
  seek: [timeMs: number];
  select: [shot: WorkspaceShot];
  boundaryChange: [change: BoundaryChange];
  boundaryCommit: [change: BoundaryChange];
}>();

const filmTrackEl = ref<HTMLElement | null>(null);
const shotCanvasEl = ref<HTMLCanvasElement | null>(null);
const markerCanvasEl = ref<HTMLCanvasElement | null>(null);
const draggingBoundary = ref<number | null>(null);
let activeBoundary: number | null = null;
let latestBoundaryTime = 0;
let boundaryMinTime = 0;
let boundaryMaxTime = 0;
let drawFrame = 0;
let resizeObserver: ResizeObserver | null = null;

const safeDuration = computed(() => Math.max(1, props.durationMs));
const playheadPercent = computed(() => clampPercent((props.currentTimeMs / safeDuration.value) * 100));
const ticks = computed(() =>
  Array.from({ length: 7 }, (_, index) => {
    const percent = index * (100 / 6);
    return { percent, label: formatTime((safeDuration.value * percent) / 100) };
  }),
);

function clampPercent(value: number): number {
  return Math.max(0, Math.min(100, value));
}

function formatTime(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

function timeFromClientX(clientX: number, element: HTMLElement | null): number {
  const rect = element?.getBoundingClientRect();
  if (!rect || rect.width <= 0) return 0;
  const raw = ((clientX - rect.left) / rect.width) * safeDuration.value;
  const frameMs = 1000 / Math.max(1, props.fps || 24);
  const frameAlignedMs = Math.round(raw / frameMs) * frameMs;
  return Math.max(0, Math.min(Math.round(safeDuration.value), Math.round(frameAlignedMs)));
}

function seekFromPointer(event: PointerEvent): void {
  emit('seek', timeFromClientX(event.clientX, filmTrackEl.value));
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
    const boundaryX = rect.left + (props.shots[index].endMs / safeDuration.value) * rect.width;
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
    const distance = Math.abs((marker.timeMs / safeDuration.value) * rect.width - targetX);
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

function drawTimeline(): void {
  drawFrame = 0;
  const shotCanvas = shotCanvasEl.value;
  const markerCanvas = markerCanvasEl.value;
  if (!shotCanvas || !markerCanvas) return;

  const shotContext = resizeCanvas(shotCanvas);
  const markerContext = resizeCanvas(markerCanvas);
  if (!shotContext || !markerContext) return;

  const shotRect = shotCanvas.getBoundingClientRect();
  const markerRect = markerCanvas.getBoundingClientRect();
  const shotWidth = shotRect.width;
  const markerWidth = markerRect.width;
  shotContext.clearRect(0, 0, shotWidth, 28);
  markerContext.clearRect(0, 0, markerWidth, 24);

  const selectedId = props.selectedId;
  const currentTime = props.currentTimeMs;
  for (let index = 0; index < props.shots.length; index += 1) {
    const shot = props.shots[index];
    const x = (shot.startMs / safeDuration.value) * shotWidth;
    const rawWidth = ((shot.endMs - shot.startMs) / safeDuration.value) * shotWidth;
    const width = Math.max(1, rawWidth - 0.7);
    const isCurrent = currentTime >= shot.startMs && currentTime < shot.endMs;
    const isSelected = shot.id === selectedId;

    shotContext.fillStyle = isCurrent ? '#fbbf24' : '#f59e0b';
    shotContext.fillRect(x, 0, width, 28);
    shotContext.fillStyle = '#0f172a';
    shotContext.fillRect(x + Math.max(1, width - 0.7), 0, 0.7, 28);

    if (isSelected) {
      shotContext.strokeStyle = '#ffffff';
      shotContext.lineWidth = 2;
      shotContext.strokeRect(x + 1, 1, Math.max(1, width - 2), 26);
    }

    if (width >= 23) {
      shotContext.fillStyle = isCurrent ? '#1f2937' : '#ffffff';
      shotContext.font = '600 10px "Cascadia Mono", Consolas, monospace';
      shotContext.textAlign = 'center';
      shotContext.textBaseline = 'middle';
      shotContext.fillText(String(shot.index).padStart(2, '0'), x + width / 2, 14);
    }
  }

  if (draggingBoundary.value !== null) {
    const shot = props.shots[draggingBoundary.value];
    if (shot) {
      const x = (shot.endMs / safeDuration.value) * shotWidth;
      shotContext.strokeStyle = '#fbbf24';
      shotContext.lineWidth = 2;
      shotContext.beginPath();
      shotContext.moveTo(x, 0);
      shotContext.lineTo(x, 28);
      shotContext.stroke();
    }
  }

  const playheadX = (currentTime / safeDuration.value) * shotWidth;
  shotContext.strokeStyle = '#ffffff';
  shotContext.lineWidth = 1;
  shotContext.beginPath();
  shotContext.moveTo(playheadX, 0);
  shotContext.lineTo(playheadX, 28);
  shotContext.stroke();

  markerContext.strokeStyle = 'rgba(71, 85, 105, 0.6)';
  markerContext.lineWidth = 1;
  markerContext.setLineDash([3, 3]);
  markerContext.beginPath();
  markerContext.moveTo(0, 12.5);
  markerContext.lineTo(markerWidth, 12.5);
  markerContext.stroke();
  markerContext.setLineDash([]);

  markerContext.fillStyle = '#22c55e';
  for (const marker of props.markers) {
    const x = (marker.timeMs / safeDuration.value) * markerWidth;
    markerContext.fillRect(x - 1, 2, 2, 10);
  }

  markerContext.strokeStyle = '#ffffff';
  markerContext.lineWidth = 1;
  markerContext.beginPath();
  markerContext.moveTo(playheadX, 0);
  markerContext.lineTo(playheadX, 24);
  markerContext.stroke();
}

function scheduleDraw(): void {
  if (drawFrame) return;
  drawFrame = requestAnimationFrame(drawTimeline);
}

watch(
  () => [
    props.shots,
    props.markers,
    props.selectedId,
    props.currentTimeMs,
    props.durationMs,
    draggingBoundary.value,
  ],
  scheduleDraw,
);

onMounted(async () => {
  await nextTick();
  resizeObserver = new ResizeObserver(scheduleDraw);
  if (shotCanvasEl.value) resizeObserver.observe(shotCanvasEl.value);
  if (markerCanvasEl.value) resizeObserver.observe(markerCanvasEl.value);
  scheduleDraw();
});

onBeforeUnmount(() => {
  if (drawFrame) cancelAnimationFrame(drawFrame);
  resizeObserver?.disconnect();
  resizeObserver = null;
  window.removeEventListener('pointermove', handleBoundaryMove);
  window.removeEventListener('pointerup', finishBoundaryDrag);
});
</script>

<template>
  <section class="timeline">
    <div class="ruler-row">
      <span class="label"></span>
      <div class="track-container">
        <span v-for="tick in ticks" :key="tick.percent" class="tick" :style="{ left: `${tick.percent}%` }">
          <i></i><em>{{ tick.label }}</em>
        </span>
        <span class="playhead playhead-ruler" :style="{ left: `${playheadPercent}%` }"></span>
      </div>
    </div>

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
  </section>
</template>

<style scoped>
.timeline {
  display: flex;
  height: 100px;
  flex: 0 0 auto;
  flex-direction: column;
  justify-content: center;
  gap: 2px;
  padding: 4px 12px;
  border: 1px solid var(--border);
  border-top: 0;
  border-radius: 0;
  background: var(--bg-panel);
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

.tick {
  position: absolute;
  top: 0;
  display: flex;
  align-items: center;
  gap: 4px;
  transform: translateX(-50%);
}

.tick:first-of-type {
  transform: none;
}

.tick:last-of-type {
  transform: translateX(-100%);
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
}

.track {
  position: relative;
  min-width: 0;
  padding: 0;
  border: 0;
  background: transparent;
}

.film {
  height: 24px;
}

.film-base,
.film-progress {
  position: absolute;
  top: 4px;
  bottom: 4px;
  left: 0;
  border-radius: 3px;
}

.film-base {
  width: 100%;
  background: rgba(59, 130, 246, 0.2);
}

.film-progress {
  background: var(--blue-hi);
}

.canvas-track {
  height: 28px;
  cursor: pointer;
}

.marker-track {
  height: 24px;
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
