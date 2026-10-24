<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue';
import type {
  ExportProgressEvent,
  StoryboardFormat,
  StoryboardHeader,
  StoryboardImageStrategy,
} from '../../../shared/types';
import type { WorkspaceShot } from '../types/workspace';

const props = defineProps<{
  open: boolean;
  projectName: string;
  shots: WorkspaceShot[];
  busy: boolean;
  progress: ExportProgressEvent | null;
}>();

const emit = defineEmits<{
  close: [];
  submit: [
    value: {
      format: StoryboardFormat;
      shotIds: string[];
      headers: StoryboardHeader[];
      imageStrategy: StoryboardImageStrategy;
    },
  ];
}>();

const defaults: StoryboardHeader[] = [
  { key: 'index', label: '镜号' },
  { key: 'duration', label: '时长' },
  { key: 'thumbnail', label: '缩略图' },
  { key: 'shotSize', label: '景别' },
  { key: 'cameraMethod', label: '摄法 / 运镜' },
  { key: 'image', label: '画面内容' },
  { key: 'dialogue', label: '台词' },
  { key: 'remark', label: '备注' },
];

const selectedIds = ref<string[]>([]);
const headers = reactive<StoryboardHeader[]>(defaults.map((item) => ({ ...item })));
const format = ref<StoryboardFormat>('pdf');
const imageStrategy = ref<StoryboardImageStrategy>('both');

const allSelected = computed(
  () => props.shots.length > 0 && selectedIds.value.length === props.shots.length,
);

watch(
  () => [props.open, props.shots] as const,
  ([open, shots]) => {
    if (!open) return;
    selectedIds.value = shots.map((shot) => shot.id);
  },
  { immediate: true },
);

function toggleShot(id: string): void {
  if (selectedIds.value.includes(id)) {
    selectedIds.value = selectedIds.value.filter((item) => item !== id);
  } else {
    selectedIds.value = [...selectedIds.value, id];
  }
}

function toggleAll(): void {
  selectedIds.value = allSelected.value ? [] : props.shots.map((shot) => shot.id);
}

function formatDuration(ms: number): string {
  const total = Math.round(ms / 100);
  return `${String(Math.floor(total / 600)).padStart(2, '0')}:${String(Math.floor((total % 600) / 10)).padStart(2, '0')}.${total % 10}`;
}

function submit(): void {
  if (props.busy || selectedIds.value.length === 0) return;
  emit('submit', {
    format: format.value,
    shotIds: selectedIds.value,
    headers: headers.map((header) => ({ ...header })),
    imageStrategy: imageStrategy.value,
  });
}
</script>

<template>
  <transition name="modal">
    <div v-if="open" class="modal-mask" @pointerdown.self="!busy && emit('close')">
      <form class="export-modal" @submit.prevent="submit">
        <header class="modal-head">
          <div>
            <p>STORYBOARD EXPORT</p>
            <h2>导出分镜本</h2>
            <span>{{ projectName }}</span>
          </div>
          <button type="button" aria-label="关闭" :disabled="busy" @click="emit('close')">×</button>
        </header>

        <div class="export-grid">
          <section class="scope-panel">
            <div class="section-head">
              <strong>镜头范围</strong>
              <button type="button" @click="toggleAll">{{ allSelected ? '清空' : '全选' }}</button>
            </div>
            <div class="shot-options">
              <label v-for="shot in shots" :key="shot.id" class="shot-option">
                <input
                  type="checkbox"
                  :checked="selectedIds.includes(shot.id)"
                  @change="toggleShot(shot.id)"
                />
                <span class="shot-index">{{ String(shot.index).padStart(2, '0') }}</span>
                <img :src="shot.thumbnail" alt="" />
                <span class="shot-copy">
                  <strong>{{ shot.title }}</strong>
                  <small>{{ shot.shotSize }} · {{ formatDuration(shot.durationMs) }}</small>
                </span>
              </label>
            </div>
            <div class="selection-count">已选择 {{ selectedIds.length }} / {{ shots.length }} 个镜头</div>
          </section>

          <section class="settings-panel">
            <div class="setting-block">
              <div class="section-head"><strong>文件格式</strong></div>
              <div class="choice-grid two">
                <button
                  class="choice"
                  :class="{ active: format === 'pdf' }"
                  type="button"
                  @click="format = 'pdf'"
                >
                  <strong>PDF</strong>
                  <span>A4 竖版 · 固定排版</span>
                </button>
                <button
                  class="choice"
                  :class="{ active: format === 'docx' }"
                  type="button"
                  @click="format = 'docx'"
                >
                  <strong>Word</strong>
                  <span>.docx 可编辑表格</span>
                </button>
              </div>
            </div>

            <div class="setting-block">
              <div class="section-head"><strong>图片策略</strong></div>
              <div class="choice-grid three">
                <button class="choice" :class="{ active: imageStrategy === 'both' }" type="button" @click="imageStrategy = 'both'">
                  <strong>双图</strong><span>缩略图 + 大图</span>
                </button>
                <button class="choice" :class="{ active: imageStrategy === 'thumbnail' }" type="button" @click="imageStrategy = 'thumbnail'">
                  <strong>缩略图</strong><span>紧凑分镜表</span>
                </button>
                <button class="choice" :class="{ active: imageStrategy === 'full' }" type="button" @click="imageStrategy = 'full'">
                  <strong>画面大图</strong><span>侧重画面内容</span>
                </button>
              </div>
            </div>

            <div class="setting-block headers-block">
              <div class="section-head"><strong>自定义表头</strong><span>八列</span></div>
              <div class="header-grid">
                <label v-for="header in headers" :key="header.key">
                  <span>{{ header.key }}</span>
                  <input v-model="header.label" maxlength="80" />
                </label>
              </div>
            </div>
          </section>
        </div>

        <div v-if="busy" class="progress-panel">
          <div><span>{{ progress?.message ?? '正在准备导出' }}</span><strong>{{ progress?.percent ?? 0 }}%</strong></div>
          <div class="progress-track"><i :style="{ width: `${progress?.percent ?? 0}%` }"></i></div>
        </div>

        <footer class="modal-actions">
          <span>镜头序号、时长和媒体字段直接读取项目数据</span>
          <button type="button" :disabled="busy" @click="emit('close')">取消</button>
          <button class="primary" type="submit" :disabled="busy || selectedIds.length === 0">
            {{ busy ? '正在导出…' : `导出 ${format === 'pdf' ? 'PDF' : 'Word'}` }}
          </button>
        </footer>
      </form>
    </div>
  </transition>
</template>

<style scoped>
.modal-mask {
  position: fixed;
  inset: 0;
  display: grid;
  padding: 16px;
  background: rgba(2, 6, 23, 0.64);
  place-items: center;
  z-index: 90;
}

.export-modal {
  display: flex;
  width: 760px;
  max-width: calc(100vw - 32px);
  max-height: calc(100vh - 32px);
  flex-direction: column;
  overflow: hidden;
  border: 1px solid var(--border);
  border-radius: 10px;
  background: var(--bg-panel);
  box-shadow: 0 28px 90px rgba(0, 0, 0, 0.5);
}

.modal-head {
  display: flex;
  flex: 0 0 auto;
  align-items: flex-start;
  justify-content: space-between;
  padding: 16px;
  border-bottom: 1px solid var(--border);
}

.modal-head p {
  margin: 0 0 4px;
  color: var(--text-faint);
  font-size: 10px;
  letter-spacing: 1.2px;
}

.modal-head h2 {
  margin: 0;
  color: var(--text-primary);
  font-size: 14px;
  font-weight: 600;
}

.modal-head span {
  display: block;
  margin-top: 4px;
  color: var(--text-muted);
  font-size: 11px;
}

.modal-head > button {
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

.modal-head > button:hover:not(:disabled) {
  background: var(--bg-hover);
}

.export-grid {
  display: grid;
  min-height: 0;
  flex: 1;
  grid-template-columns: 270px minmax(0, 1fr);
}

.scope-panel,
.settings-panel {
  min-height: 0;
  padding: 12px;
}

.scope-panel {
  border-right: 1px solid var(--border);
}

.section-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 8px;
  color: var(--text-secondary);
  font-size: 11px;
}

.section-head span {
  color: var(--text-faint);
  font-size: 10px;
}

.section-head button {
  padding: 0;
  border: 0;
  background: transparent;
  color: var(--blue-hi);
  font-size: 10px;
}

.shot-options {
  max-height: 360px;
  overflow-y: auto;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--bg-deep);
}

.shot-option {
  display: grid;
  height: 44px;
  grid-template-columns: 16px 24px 64px minmax(0, 1fr);
  align-items: center;
  gap: 8px;
  padding: 0 8px;
  border-bottom: 1px solid rgba(71, 85, 105, 0.45);
  color: var(--text-secondary);
}

.shot-option:last-child {
  border-bottom: 0;
}

.shot-option:hover {
  background: var(--bg-hover);
}

.shot-option input {
  accent-color: var(--red);
}

.shot-index {
  font-family: var(--mono);
  font-size: 11px;
}

.shot-option img {
  width: 64px;
  height: 36px;
  border-radius: 4px;
  object-fit: cover;
}

.shot-copy {
  display: flex;
  min-width: 0;
  flex-direction: column;
  gap: 2px;
}

.shot-copy strong {
  overflow: hidden;
  color: var(--text-secondary);
  font-size: 11px;
  font-weight: 500;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.shot-copy small {
  color: var(--text-faint);
  font-size: 10px;
}

.selection-count {
  margin-top: 8px;
  color: var(--text-muted);
  font-size: 10px;
}

.settings-panel {
  overflow-y: auto;
}

.setting-block + .setting-block {
  margin-top: 16px;
}

.choice-grid {
  display: grid;
  gap: 8px;
}

.choice-grid.two {
  grid-template-columns: 1fr 1fr;
}

.choice-grid.three {
  grid-template-columns: repeat(3, 1fr);
}

.choice {
  display: flex;
  min-height: 54px;
  flex-direction: column;
  justify-content: center;
  gap: 3px;
  padding: 8px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--bg-raised);
  color: var(--text-muted);
  text-align: left;
}

.choice strong {
  color: var(--text-secondary);
  font-size: 12px;
  font-weight: 600;
}

.choice span {
  font-size: 10px;
}

.choice:hover,
.choice.active {
  border-color: var(--red);
  background: var(--red-soft);
}

.choice.active strong {
  color: #fff;
}

.header-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px;
}

.header-grid label {
  display: flex;
  min-width: 0;
  flex-direction: column;
  gap: 4px;
}

.header-grid label span {
  color: var(--text-faint);
  font-family: var(--mono);
  font-size: 9px;
}

.header-grid input {
  height: 28px;
  min-width: 0;
  padding: 0 8px;
  border: 1px solid var(--border);
  border-radius: 6px;
  outline: 0;
  background: var(--bg-raised);
  color: var(--text-secondary);
  font: inherit;
  font-size: 11px;
}

.header-grid input:focus {
  border-color: var(--border-strong);
  box-shadow: 0 0 0 2px rgba(251, 191, 36, 0.3);
}

.progress-panel {
  flex: 0 0 auto;
  padding: 8px 16px 12px;
  border-top: 1px solid var(--border);
}

.progress-panel > div:first-child {
  display: flex;
  justify-content: space-between;
  color: var(--text-muted);
  font-size: 10px;
}

.progress-panel strong {
  color: var(--text-secondary);
  font-family: var(--mono);
}

.progress-track {
  height: 4px;
  margin-top: 6px;
  overflow: hidden;
  border-radius: 2px;
  background: var(--bg-raised);
}

.progress-track i {
  display: block;
  height: 100%;
  border-radius: inherit;
  background: var(--red);
  transition: width 160ms ease;
}

.modal-actions {
  display: flex;
  min-height: 54px;
  flex: 0 0 auto;
  align-items: center;
  gap: 8px;
  padding: 12px 16px;
  border-top: 1px solid var(--border);
}

.modal-actions > span {
  flex: 1;
  color: var(--text-faint);
  font-size: 10px;
}

.modal-actions button {
  height: 28px;
  padding: 0 12px;
  border: 0;
  border-radius: 6px;
  background: var(--bg-raised);
  color: var(--text-secondary);
  font-size: 11px;
}

.modal-actions button:hover:not(:disabled) {
  background: var(--bg-hover);
}

.modal-actions .primary {
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
</style>
