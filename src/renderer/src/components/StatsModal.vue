<script setup lang="ts">
import { nextTick, onBeforeUnmount, ref, watch } from 'vue';
import * as echarts from 'echarts/core';
import { BarChart, LineChart, PieChart } from 'echarts/charts';
import { GridComponent, TooltipComponent } from 'echarts/components';
import { CanvasRenderer } from 'echarts/renderers';
import type { ECharts } from 'echarts/core';
import type {
  StatsProgress,
  StatsRhythmPoint,
  StatsTagDistributionItem,
} from '../../../shared/types';

echarts.use([BarChart, LineChart, PieChart, GridComponent, TooltipComponent, CanvasRenderer]);

const props = defineProps<{
  open: boolean;
  projectId: string | null;
  projectName: string;
}>();

const emit = defineEmits<{
  close: [];
}>();

const loading = ref(false);
const error = ref<string | null>(null);
const tags = ref<StatsTagDistributionItem[]>([]);
const rhythm = ref<StatsRhythmPoint[]>([]);
const progress = ref<StatsProgress | null>(null);
const progressChartEl = ref<HTMLElement | null>(null);
const tagChartEl = ref<HTMLElement | null>(null);
const rhythmChartEl = ref<HTMLElement | null>(null);
const charts: ECharts[] = [];
let resizeObserver: ResizeObserver | null = null;

const categoryColors: Record<StatsTagDistributionItem['category'], string> = {
  景别: '#e11d48',
  机位: '#60a5fa',
  运镜: '#f59e0b',
};

async function loadStats(): Promise<void> {
  if (!props.projectId) return;
  loading.value = true;
  error.value = null;
  try {
    const [tagResult, rhythmResult, progressResult] = await Promise.all([
      window.api.stats.tagDistribution({ projectId: props.projectId }),
      window.api.stats.rhythm({ projectId: props.projectId }),
      window.api.stats.progress({ projectId: props.projectId }),
    ]);
    const failed = [tagResult, rhythmResult, progressResult].find((result) => !result.ok);
    if (failed && !failed.ok) {
      error.value = `${failed.error.code}: ${failed.error.message}`;
      return;
    }
    if (tagResult.ok) tags.value = tagResult.data;
    if (rhythmResult.ok) rhythm.value = rhythmResult.data;
    if (progressResult.ok) progress.value = progressResult.data;
    loading.value = false;
    await nextTick();
    renderCharts();
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause);
  } finally {
    loading.value = false;
  }
}

function disposeCharts(): void {
  for (const chart of charts) chart.dispose();
  charts.length = 0;
}

function initChart(element: HTMLElement | null): ECharts | null {
  if (!element) return null;
  const existing = echarts.getInstanceByDom(element);
  if (existing) {
    charts.push(existing);
    return existing;
  }
  const chart = echarts.init(element, undefined, { renderer: 'canvas' });
  charts.push(chart);
  return chart;
}

function renderCharts(): void {
  disposeCharts();
  const progressChart = initChart(progressChartEl.value);
  const tagChart = initChart(tagChartEl.value);
  const rhythmChart = initChart(rhythmChartEl.value);
  if (!progressChart || !tagChart || !rhythmChart) return;

  const percent = progress.value?.percent ?? 0;
  progressChart.setOption({
    animationDuration: 380,
    tooltip: { show: false },
    series: [
      {
        type: 'pie',
        silent: true,
        radius: ['70%', '86%'],
        center: ['50%', '50%'],
        startAngle: 90,
        label: { show: false },
        data: [
          {
            value: percent,
            itemStyle: {
              color: percent >= 100 ? '#22c55e' : '#e11d48',
              borderRadius: 4,
            },
          },
          { value: Math.max(0, 100 - percent), itemStyle: { color: '#263449' } },
        ],
      },
    ],
  });

  const tagItems = tags.value.map((item) => ({
    name: `${item.category} · ${item.name}`,
    value: item.count,
    itemStyle: { color: categoryColors[item.category] },
  }));
  tagChart.setOption({
    animationDuration: 420,
    grid: { left: 94, right: 22, top: 14, bottom: 30 },
    tooltip: {
      trigger: 'axis',
      axisPointer: { type: 'shadow' },
      formatter: (params: Array<{ name: string; value: number }>) =>
        `${params[0]?.name ?? ''}<br/><strong>${params[0]?.value ?? 0} 个镜头</strong>`,
    },
    xAxis: {
      type: 'value',
      minInterval: 1,
      axisLabel: { color: '#64748b', fontSize: 9 },
      splitLine: { lineStyle: { color: 'rgba(71, 85, 105, 0.25)' } },
    },
    yAxis: {
      type: 'category',
      data: tagItems.map((item) => item.name),
      axisLabel: { color: '#94a3b8', fontSize: 9, width: 82, overflow: 'truncate' },
      axisTick: { show: false },
      axisLine: { lineStyle: { color: '#334155' } },
    },
    dataZoom: [
      { type: 'inside', yAxisIndex: 0, zoomOnMouseWheel: true, moveOnMouseWheel: true },
      {
        type: 'slider',
        yAxisIndex: 0,
        right: 3,
        width: 8,
        showDetail: false,
        borderColor: 'transparent',
        fillerColor: 'rgba(96, 165, 250, 0.18)',
        backgroundColor: 'rgba(15, 23, 42, 0.6)',
      },
    ],
    series: [
      {
        type: 'bar',
        barMaxWidth: 12,
        data: tagItems,
        label: {
          show: true,
          position: 'right',
          color: '#cbd5e1',
          fontSize: 9,
        },
        itemStyle: { borderRadius: [0, 3, 3, 0] },
      },
    ],
  });

  rhythmChart.setOption({
    animationDuration: 460,
    grid: { left: 42, right: 20, top: 30, bottom: 34 },
    tooltip: {
      trigger: 'axis',
      formatter: (params: Array<{ dataIndex: number; value: number }>) => {
        const point = rhythm.value[params[0]?.dataIndex ?? 0];
        return point
          ? `镜头 ${String(point.index).padStart(2, '0')}<br/><strong>${point.durationSeconds.toFixed(2)} 秒</strong>`
          : '';
      },
    },
    xAxis: {
      type: 'category',
      data: rhythm.value.map((point) => String(point.index).padStart(2, '0')),
      axisLabel: { color: '#64748b', fontSize: 9 },
      axisTick: { show: false },
      axisLine: { lineStyle: { color: '#334155' } },
    },
    yAxis: {
      type: 'value',
      name: '秒',
      nameTextStyle: { color: '#64748b', fontSize: 9 },
      axisLabel: { color: '#64748b', fontSize: 9 },
      splitLine: { lineStyle: { color: 'rgba(71, 85, 105, 0.25)' } },
    },
    series: [
      {
        type: 'line',
        data: rhythm.value.map((point) => point.durationSeconds),
        smooth: false,
        symbol: 'circle',
        symbolSize: rhythm.value.length > 80 ? 2 : 5,
        lineStyle: { color: '#60a5fa', width: 1.6 },
        itemStyle: { color: '#fbbf24' },
        areaStyle: {
          color: {
            type: 'linear',
            x: 0,
            y: 0,
            x2: 0,
            y2: 1,
            colorStops: [
              { offset: 0, color: 'rgba(96, 165, 250, 0.28)' },
              { offset: 1, color: 'rgba(96, 165, 250, 0.02)' },
            ],
          },
        },
        markLine: {
          silent: true,
          symbol: 'none',
          lineStyle: { color: 'rgba(251, 191, 36, 0.45)', type: 'dashed' },
          label: { color: '#94a3b8', fontSize: 9, formatter: '平均 {c}s' },
          data: [{ type: 'average', name: '平均时长' }],
        },
      },
    ],
  });
}

function resizeCharts(): void {
  for (const chart of charts) chart.resize();
}

watch(
  () => [props.open, props.projectId] as const,
  ([open]) => {
    if (!open) {
      disposeCharts();
      return;
    }
    void loadStats();
  },
  { immediate: true },
);

if (typeof ResizeObserver !== 'undefined') {
  resizeObserver = new ResizeObserver(resizeCharts);
}

watch(
  () => [progressChartEl.value, tagChartEl.value, rhythmChartEl.value] as const,
  (elements) => {
    if (!resizeObserver) return;
    resizeObserver.disconnect();
    for (const element of elements) {
      if (element) resizeObserver.observe(element);
    }
  },
  { flush: 'post' },
);

onBeforeUnmount(() => {
  resizeObserver?.disconnect();
  disposeCharts();
});
</script>

<template>
  <transition name="modal">
    <div v-if="open" class="modal-mask" @pointerdown.self="emit('close')">
      <section class="stats-modal">
        <header class="stats-head">
          <div>
            <p>LEARNING ANALYTICS</p>
            <h2>学习统计</h2>
            <span>{{ projectName }}</span>
          </div>
          <button type="button" aria-label="关闭" @click="emit('close')">×</button>
        </header>

        <div v-if="loading" class="stats-state">
          <i></i>
          <strong>正在聚合统计</strong>
        </div>
        <div v-else-if="error" class="stats-state error">
          <strong>统计加载失败</strong>
          <span>{{ error }}</span>
          <button type="button" @click="loadStats">重试</button>
        </div>
        <div v-else class="stats-body">
          <section class="stats-card progress-card">
            <div class="card-title">
              <span>个人拉片进度</span>
              <small>标签 / 笔记 / 正式静帧</small>
            </div>
            <div class="progress-visual">
              <div ref="progressChartEl" class="progress-chart"></div>
              <div class="progress-center">
                <strong>{{ progress?.percent ?? 0 }}%</strong>
                <span>完成度</span>
              </div>
            </div>
            <div class="progress-copy">
              <strong>{{ progress?.annotatedShots ?? 0 }}</strong>
              <span>/ {{ progress?.totalShots ?? 0 }} 个镜头已标注</span>
            </div>
          </section>

          <section class="stats-card tag-card">
            <div class="card-title">
              <span>镜头语言标签分布</span>
              <small>景别 · 机位 · 运镜</small>
            </div>
            <div ref="tagChartEl" class="tag-chart"></div>
          </section>

          <section class="stats-card rhythm-card">
            <div class="card-title">
              <span>镜头时长节奏</span>
              <small>横轴镜号 · 纵轴秒数</small>
            </div>
            <div ref="rhythmChartEl" class="rhythm-chart"></div>
          </section>
        </div>

        <footer class="stats-foot">
          <span>数据由当前项目 SQLite 实时聚合</span>
          <button type="button" @click="loadStats">刷新</button>
          <button class="primary" type="button" @click="emit('close')">关闭</button>
        </footer>
      </section>
    </div>
  </transition>
</template>

<style scoped>
.modal-mask {
  position: fixed;
  inset: 0;
  display: grid;
  padding: 16px;
  background: rgba(2, 6, 23, 0.68);
  place-items: center;
  z-index: 90;
}

.stats-modal {
  display: flex;
  width: 1020px;
  max-width: calc(100vw - 32px);
  max-height: calc(100vh - 32px);
  flex-direction: column;
  overflow: hidden;
  border: 1px solid var(--border);
  border-radius: 10px;
  background: var(--bg-panel);
  box-shadow: 0 30px 100px rgba(0, 0, 0, 0.58);
}

.stats-head {
  display: flex;
  flex: 0 0 auto;
  align-items: flex-start;
  justify-content: space-between;
  padding: 16px 18px;
  border-bottom: 1px solid var(--border);
}

.stats-head p {
  margin: 0 0 4px;
  color: var(--text-faint);
  font-size: 10px;
  letter-spacing: 1.3px;
}

.stats-head h2 {
  margin: 0;
  color: var(--text-primary);
  font-size: 15px;
  font-weight: 600;
}

.stats-head span {
  display: block;
  margin-top: 4px;
  color: var(--text-muted);
  font-size: 10px;
}

.stats-head button {
  display: grid;
  width: 28px;
  height: 28px;
  padding: 0;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--text-muted);
  font-size: 20px;
  place-items: center;
}

.stats-head button:hover {
  background: var(--bg-hover);
}

.stats-body {
  display: grid;
  min-height: 0;
  flex: 1;
  grid-template-columns: 285px minmax(0, 1fr);
  grid-template-rows: minmax(320px, 1fr) 260px;
  gap: 10px;
  overflow: auto;
  padding: 12px;
  background: #0b111b;
}

.stats-card {
  min-width: 0;
  overflow: hidden;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--bg-panel);
}

.progress-card {
  grid-row: 1 / span 2;
}

.rhythm-card {
  grid-column: 2;
}

.card-title {
  display: flex;
  height: 38px;
  align-items: center;
  justify-content: space-between;
  padding: 0 12px;
  border-bottom: 1px solid var(--border);
}

.card-title span {
  color: var(--text-secondary);
  font-size: 11px;
  font-weight: 600;
}

.card-title small {
  color: var(--text-faint);
  font-size: 9px;
}

.progress-visual {
  position: relative;
  height: 210px;
  margin: 12px;
}

.progress-chart {
  width: 100%;
  height: 100%;
}

.progress-center {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-direction: column;
  pointer-events: none;
}

.progress-center strong {
  color: var(--text-primary);
  font-family: var(--mono);
  font-size: 32px;
  font-weight: 500;
}

.progress-center span {
  color: var(--text-faint);
  font-size: 9px;
}

.progress-copy {
  display: flex;
  align-items: baseline;
  justify-content: center;
  gap: 5px;
  padding: 8px 12px 18px;
  color: var(--text-muted);
}

.progress-copy strong {
  color: var(--text-primary);
  font-family: var(--mono);
  font-size: 22px;
  font-weight: 500;
}

.progress-copy span {
  font-size: 10px;
}

.tag-chart {
  height: calc(100% - 38px);
}

.rhythm-chart {
  height: calc(100% - 38px);
}

.stats-state {
  display: flex;
  min-height: 460px;
  align-items: center;
  justify-content: center;
  flex-direction: column;
  gap: 9px;
  color: var(--text-muted);
}

.stats-state i {
  width: 24px;
  height: 24px;
  border: 2px solid rgba(245, 158, 11, 0.2);
  border-top-color: var(--amber);
  border-radius: 50%;
  animation: stats-spin 750ms linear infinite;
}

.stats-state strong {
  color: var(--text-secondary);
  font-size: 12px;
}

.stats-state span {
  font-size: 10px;
}

.stats-state button {
  height: 28px;
  margin-top: 6px;
  padding: 0 12px;
  border: 0;
  border-radius: 5px;
  background: var(--bg-raised);
  color: var(--text-secondary);
}

.stats-state.error strong {
  color: #fca5a5;
}

.stats-foot {
  display: flex;
  flex: 0 0 auto;
  align-items: center;
  gap: 8px;
  padding: 10px 14px;
  border-top: 1px solid var(--border);
}

.stats-foot span {
  flex: 1;
  color: var(--text-faint);
  font-size: 9px;
}

.stats-foot button {
  height: 28px;
  padding: 0 12px;
  border: 0;
  border-radius: 5px;
  background: var(--bg-raised);
  color: var(--text-secondary);
  font-size: 10px;
}

.stats-foot button:hover {
  background: var(--bg-hover);
}

.stats-foot button.primary {
  background: var(--red);
  color: #fff;
  font-weight: 600;
}

.modal-enter-active,
.modal-leave-active {
  transition: opacity 160ms ease;
}

.modal-enter-from,
.modal-leave-to {
  opacity: 0;
}

@keyframes stats-spin {
  to {
    transform: rotate(360deg);
  }
}

@media (max-width: 980px) {
  .stats-body {
    grid-template-columns: 240px minmax(0, 1fr);
  }
}
</style>
