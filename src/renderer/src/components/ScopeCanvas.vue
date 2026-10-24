<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import type {
  ScopeAnalysis,
  ScopeParadePoint,
  ScopeWaveformPoint,
} from '../../../shared/types';
import type { ScopeMode } from '../types/scope';

const props = defineProps<{
  mode: ScopeMode;
  analysis: ScopeAnalysis | null;
  references: boolean;
}>();

const canvasEl = ref<HTMLCanvasElement | null>(null);
let resizeObserver: ResizeObserver | null = null;
let drawFrame = 0;

const gridColor = 'rgba(100, 116, 139, 0.22)';
const guideColor = 'rgba(148, 163, 184, 0.48)';

function scheduleDraw(): void {
  if (drawFrame) return;
  drawFrame = requestAnimationFrame(draw);
}

function setupContext(canvas: HTMLCanvasElement): CanvasRenderingContext2D | null {
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
  context.clearRect(0, 0, rect.width, rect.height);
  context.fillStyle = '#080d14';
  context.fillRect(0, 0, rect.width, rect.height);
  return context;
}

function draw(): void {
  drawFrame = 0;
  const canvas = canvasEl.value;
  const analysis = props.analysis;
  if (!canvas || !analysis) return;
  const context = setupContext(canvas);
  if (!context) return;
  const rect = canvas.getBoundingClientRect();
  drawGrid(context, rect.width, rect.height);

  if (props.mode === 'histogram') drawHistogram(context, rect.width, rect.height, analysis);
  else if (props.mode === 'waveform') drawWaveform(context, rect.width, rect.height, analysis.waveform);
  else drawParade(context, rect.width, rect.height, analysis);
}

function drawGrid(context: CanvasRenderingContext2D, width: number, height: number): void {
  if (!props.references) return;
  context.save();
  context.strokeStyle = gridColor;
  context.lineWidth = 1;
  context.setLineDash([2, 4]);
  for (let index = 1; index < 4; index += 1) {
    const x = (width * index) / 4;
    const y = (height * index) / 4;
    context.beginPath();
    context.moveTo(x, 0);
    context.lineTo(x, height);
    context.stroke();
    context.beginPath();
    context.moveTo(0, y);
    context.lineTo(width, y);
    context.stroke();
  }
  context.restore();
}

function drawHistogram(
  context: CanvasRenderingContext2D,
  width: number,
  height: number,
  analysis: ScopeAnalysis,
): void {
  const channels: Array<[number[], string]> = [
    [analysis.histogram.y, 'rgba(226, 232, 240, 0.78)'],
    [analysis.histogram.r, '#fb7185'],
    [analysis.histogram.g, '#4ade80'],
    [analysis.histogram.b, '#60a5fa'],
  ];
  context.save();
  context.globalCompositeOperation = 'screen';
  for (const [values, color] of channels) {
    if (!values.length) continue;
    context.beginPath();
    values.forEach((value, index) => {
      const x = (index / Math.max(1, values.length - 1)) * width;
      const y = height - Math.max(0, Math.min(1, value)) * (height - 8);
      if (index === 0) context.moveTo(x, y);
      else context.lineTo(x, y);
    });
    context.strokeStyle = color;
    context.lineWidth = 1.35;
    context.stroke();
  }
  context.restore();
  drawReference(context, width, height, 0.1, '10');
  drawReference(context, width, height, 0.9, '90');
}

function drawWaveform(
  context: CanvasRenderingContext2D,
  width: number,
  height: number,
  points: ScopeWaveformPoint[],
): void {
  if (points.length === 0) return;
  const top: Array<[number, number]> = [];
  const bottom: Array<[number, number]> = [];
  for (const point of points) {
    const x = point.x * width;
    top.push([x, (1 - point.max) * height]);
    bottom.push([x, (1 - point.min) * height]);
  }
  context.beginPath();
  top.forEach(([x, y], index) => (index === 0 ? context.moveTo(x, y) : context.lineTo(x, y)));
  [...bottom].reverse().forEach(([x, y]) => context.lineTo(x, y));
  context.closePath();
  context.fillStyle = 'rgba(96, 165, 250, 0.18)';
  context.fill();
  context.strokeStyle = 'rgba(147, 197, 253, 0.88)';
  context.lineWidth = 1;
  context.stroke();

  context.beginPath();
  points.forEach((point, index) => {
    const x = point.x * width;
    const y = (1 - point.mean) * height;
    if (index === 0) context.moveTo(x, y);
    else context.lineTo(x, y);
  });
  context.strokeStyle = 'rgba(251, 191, 36, 0.9)';
  context.stroke();
  drawReference(context, width, height, 0.9, '90');
  drawReference(context, width, height, 0.1, '10');
}

function drawParade(
  context: CanvasRenderingContext2D,
  width: number,
  height: number,
  analysis: ScopeAnalysis,
): void {
  const channels: Array<[ScopeParadePoint[], string, string]> = [
    [analysis.parade.r, '#fb7185', 'R'],
    [analysis.parade.g, '#4ade80', 'G'],
    [analysis.parade.b, '#60a5fa', 'B'],
  ];
  const cellWidth = width / channels.length;
  context.save();
  context.font = '9px "Cascadia Mono", Consolas, monospace';
  context.textAlign = 'left';
  channels.forEach(([points, color, label], channelIndex) => {
    const left = channelIndex * cellWidth;
    if (channelIndex > 0) {
      context.strokeStyle = guideColor;
      context.beginPath();
      context.moveTo(left, 0);
      context.lineTo(left, height);
      context.stroke();
    }
    if (props.references) {
      context.fillStyle = color;
      context.globalAlpha = 0.72;
      context.fillText(label, left + 5, 12);
      context.globalAlpha = 1;
    }
    for (let index = 0; index < points.length; index += 1) {
      const point = points[index];
      const x = left + (index / Math.max(1, points.length - 1)) * cellWidth;
      const yMax = (1 - point.max) * height;
      const yMin = (1 - point.min) * height;
      context.strokeStyle = color;
      context.globalAlpha = 0.38;
      context.beginPath();
      context.moveTo(x, yMax);
      context.lineTo(x, yMin);
      context.stroke();
      context.globalAlpha = 0.82;
      context.fillStyle = color;
      context.fillRect(x, (1 - point.mean) * height, 1, 1.5);
    }
  });
  context.restore();
}

function drawReference(
  context: CanvasRenderingContext2D,
  width: number,
  height: number,
  value: number,
  label: string,
): void {
  if (!props.references) return;
  context.save();
  context.strokeStyle = guideColor;
  context.setLineDash([3, 4]);
  context.beginPath();
  context.moveTo(0, (1 - value) * height);
  context.lineTo(width, (1 - value) * height);
  context.stroke();
  context.setLineDash([]);
  context.fillStyle = 'rgba(148, 163, 184, 0.7)';
  context.font = '8px "Cascadia Mono", Consolas, monospace';
  context.fillText(label, 4, (1 - value) * height - 3);
  context.restore();
}

watch(
  () => [props.mode, props.analysis, props.references],
  scheduleDraw,
  { deep: false },
);

onMounted(async () => {
  await nextTick();
  resizeObserver = new ResizeObserver(scheduleDraw);
  if (canvasEl.value) resizeObserver.observe(canvasEl.value);
  scheduleDraw();
});

onBeforeUnmount(() => {
  if (drawFrame) cancelAnimationFrame(drawFrame);
  resizeObserver?.disconnect();
  resizeObserver = null;
});
</script>

<template>
  <canvas ref="canvasEl" class="scope-canvas" :aria-label="`${mode} 示波器`"></canvas>
</template>

<style scoped>
.scope-canvas {
  display: block;
  width: 100%;
  height: 100%;
}
</style>
