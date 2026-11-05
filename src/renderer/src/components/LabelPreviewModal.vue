<script setup lang="ts">
import { computed } from 'vue';
import type { LabelPreviewResult } from '../../../shared/types';

/**
 * S41：标签识别结果预览弹窗。
 * - 只展示 AI 预测摘要，不写库；关闭即取消，不改变已落库切分与人工标注。
 * - 支持全选/清空/逐镜头选择；两种应用策略：覆盖全部 / 保留人工标注应用其余。
 */
const props = defineProps<{
  open: boolean;
  preview: LabelPreviewResult | null;
  selectedIds: string[];
  applying: boolean;
}>();

const emit = defineEmits<{
  close: [];
  toggle: [shotId: string, checked: boolean];
  apply: [policy: 'overwrite-all' | 'preserve-manual'];
}>();

const shots = computed(() => props.preview?.shots ?? []);
const selectedSet = computed(() => new Set(props.selectedIds));
const allSelected = computed(
  () => shots.value.length > 0 && selectedSet.value.size === shots.value.length,
);

function summary(prediction: LabelPreviewResult['shots'][number]): string {
  const tags = Object.entries(prediction.predicted.tags)
    .filter(([, names]) => Array.isArray(names) && names.length > 0)
    .map(([category, names]) => `${category}:${(names as string[]).join('/')}`)
    .join(' · ');
  return tags || '—';
}

function timeRange(prediction: LabelPreviewResult['shots'][number]): string {
  const format = (ms: number): string => {
    const total = Math.floor(ms / 1000);
    const m = Math.floor(total / 60);
    const s = total % 60;
    return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  };
  return `${format(prediction.startMs)} – ${format(prediction.endMs)}`;
}
</script>

<template>
  <teleport to="body">
    <transition name="toast">
      <div v-if="open" class="label-preview-mask" @click.self="emit('close')">
        <div class="label-preview" role="dialog" aria-modal="true" aria-label="标签识别结果">
          <header class="label-preview-head">
            <div>
              <h2>标签识别结果</h2>
              <p>共 {{ shots.length }} 个镜头 · 应用前不会写入数据库</p>
            </div>
            <button type="button" class="label-preview-close" aria-label="关闭" @click="emit('close')">×</button>
          </header>

          <div class="label-preview-toolbar">
            <label class="label-preview-select-all">
              <input
                type="checkbox"
                :checked="allSelected"
                @change="emit('toggle', '__all__', ($event.target as HTMLInputElement).checked)"
              />
              全选
            </label>
            <span>{{ selectedIds.length }} / {{ shots.length }} 已选择</span>
          </div>

          <div class="label-preview-list">
            <label v-for="prediction in shots" :key="prediction.shotId" class="label-preview-row">
              <input
                type="checkbox"
                :checked="selectedSet.has(prediction.shotId)"
                @change="emit('toggle', prediction.shotId, ($event.target as HTMLInputElement).checked)"
              />
              <span class="row-index">#{{ prediction.index }}</span>
              <span class="row-time">{{ timeRange(prediction) }}</span>
              <span class="row-fields">
                <span>景别：{{ prediction.predicted.shotSize ?? '—' }}</span>
                <span>摄法：{{ prediction.predicted.cameraMethod ?? '—' }}</span>
                <span class="row-remark">{{ prediction.predicted.remark ?? '—' }}</span>
              </span>
              <span class="row-tags">{{ summary(prediction) }}</span>
            </label>
            <p v-if="shots.length === 0" class="label-preview-empty">没有可应用的识别结果。</p>
          </div>

          <footer class="label-preview-actions">
            <button type="button" class="ghost" :disabled="applying" @click="emit('close')">
              关闭（不写库）
            </button>
            <button
              type="button"
              class="secondary"
              :disabled="applying || selectedIds.length === 0"
              @click="emit('apply', 'preserve-manual')"
            >
              保留我的标注，应用其余
            </button>
            <button
              type="button"
              class="danger"
              :disabled="applying || selectedIds.length === 0"
              @click="emit('apply', 'overwrite-all')"
            >
              覆盖全部选中镜头
            </button>
          </footer>
        </div>
      </div>
    </transition>
  </teleport>
</template>

<style scoped>
.label-preview-mask {
  position: fixed;
  inset: 0;
  z-index: 110;
  display: grid;
  place-items: center;
  padding: 24px;
  background: rgba(2, 6, 23, 0.7);
}

.label-preview {
  display: flex;
  flex-direction: column;
  width: min(860px, calc(100vw - 48px));
  max-height: calc(100vh - 64px);
  border: 1px solid rgba(148, 163, 184, 0.24);
  border-radius: 12px;
  background: var(--bg-panel, #101828);
  box-shadow: 0 28px 90px rgba(0, 0, 0, 0.52);
}

.label-preview-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  padding: 16px 20px 8px;
}

.label-preview-head h2 {
  margin: 0;
  font-size: 16px;
}

.label-preview-head p {
  margin: 4px 0 0;
  font-size: 12px;
  opacity: 0.66;
}

.label-preview-close {
  border: none;
  background: transparent;
  color: inherit;
  font-size: 18px;
  cursor: pointer;
}

.label-preview-toolbar {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 4px 20px 8px;
  font-size: 12px;
  opacity: 0.85;
}

.label-preview-list {
  flex: 1;
  overflow-y: auto;
  padding: 0 12px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.label-preview-row {
  display: grid;
  grid-template-columns: auto auto auto 1fr 1fr;
  align-items: center;
  gap: 10px;
  padding: 8px 10px;
  border: 1px solid rgba(148, 163, 184, 0.16);
  border-radius: 8px;
  font-size: 12px;
  cursor: pointer;
}

.row-index {
  font-weight: 600;
  opacity: 0.8;
}

.row-time {
  font-variant-numeric: tabular-nums;
  opacity: 0.72;
}

.row-fields {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.row-remark {
  opacity: 0.72;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.row-tags {
  opacity: 0.8;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.label-preview-empty {
  padding: 24px;
  text-align: center;
  opacity: 0.6;
}

.label-preview-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  padding: 12px 20px 16px;
}

.label-preview-actions button {
  padding: 8px 14px;
  border-radius: 8px;
  border: 1px solid rgba(148, 163, 184, 0.3);
  background: transparent;
  color: inherit;
  cursor: pointer;
  font-size: 13px;
}

.label-preview-actions button:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

.label-preview-actions .danger {
  border-color: rgba(225, 29, 72, 0.5);
  color: #fb7185;
}

.label-preview-actions .secondary {
  border-color: rgba(56, 189, 248, 0.45);
  color: #7dd3fc;
}
</style>
