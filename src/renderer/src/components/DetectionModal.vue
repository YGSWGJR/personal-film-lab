<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import AppIcon from './AppIcon.vue';
import emptyShotsImage from '../../../../assets/design/design_empty_shots_1024x768.png';
import type { DetectProgressEvent, DetectResult } from '../../../shared/types';

const props = defineProps<{
  open: boolean;
  projectName: string;
  running: boolean;
  applying: boolean;
  progress: DetectProgressEvent | null;
  gpuLabel: string;
  result: DetectResult | null;
  error: string | null;
  engine?: 'ai' | 'opencv';
}>();

const emit = defineEmits<{
  close: [];
  cancel: [];
  retry: [];
  apply: [shotIds: string[], sceneIds: string[]];
}>();

const selectedIds = ref<string[]>([]);
const hasDetection = computed(() => Boolean(props.result && props.result.shots.length > 1));
const selectedCount = computed(() => selectedIds.value.length);

watch(
  () => props.result,
  (result) => {
    selectedIds.value = result?.shots.map((shot) => shot.id) ?? [];
  },
  { immediate: true },
);

function toggleShot(id: string): void {
  selectedIds.value = selectedIds.value.includes(id)
    ? selectedIds.value.filter((item) => item !== id)
    : [...selectedIds.value, id];
}

function toggleAll(): void {
  if (!props.result) return;
  selectedIds.value =
    selectedIds.value.length === props.result.shots.length
      ? []
      : props.result.shots.map((shot) => shot.id);
}

function formatTime(ms: number): string {
  const total = Math.floor(ms / 1000);
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

function applyResult(): void {
  if (!props.result || selectedIds.value.length === 0) return;
  emit('apply', [...selectedIds.value], props.result.scenes.map((scene) => scene.id));
}
</script>

<template>
  <transition name="modal">
    <div v-if="open && running" class="detect-capsule" role="status" aria-live="polite">
      <span class="capsule-dot"></span>
      <div class="capsule-copy">
        <strong>检测中 {{ progress?.percent ?? 0 }}%</strong>
        <div class="capsule-track"><i :style="{ width: `${progress?.percent ?? 0}%` }"></i></div>
      </div>
      <button type="button" class="capsule-close" title="收起，后台继续检测" @click="emit('close')">
        收起
      </button>
      <button type="button" class="capsule-cancel" @click="emit('cancel')">取消</button>
    </div>

    <div v-else-if="open" class="modal-mask" @pointerdown.self="emit('close')">
      <section class="detect-modal">
        <header class="modal-head">
          <div>
            <p>SHOT DETECTION</p>
            <h2>镜头检测</h2>
            <span>
              {{ projectName }} ·
              {{ engine === 'ai' ? '本地 Qwen3-VL + OpenCV' : 'OpenCV（备用）' }}
            </span>
          </div>
          <button type="button" aria-label="关闭" @click="emit('close')">×</button>
        </header>

        <div v-if="error" class="detect-error">
          <AppIcon name="more" :size="28" />
          <strong>检测未完成</strong>
          <p>{{ error }}</p>
          <div>
            <button type="button" @click="emit('close')">关闭</button>
            <button class="primary" type="button" @click="emit('retry')">重新检测</button>
          </div>
        </div>

        <div v-else-if="result" class="detect-result">
          <div class="result-summary">
            <div><span>候选镜头</span><strong>{{ result.shots.length }}</strong></div>
            <div><span>场景分组</span><strong>{{ result.scenes.length }}</strong></div>
            <div><span>采样</span><strong>500 ms</strong></div>
          </div>

          <div v-if="!hasDetection" class="no-cut">
            <img :src="emptyShotsImage" alt="" />
            <strong>未检出镜头</strong>
            <p>请调低 sensitivity，或增大 intervalMs 后重试。</p>
            <button class="primary" type="button" @click="emit('retry')">重新检测</button>
          </div>

          <template v-else>
            <div class="preview-head">
              <strong>预览镜头</strong>
              <span>已选 {{ selectedCount }} / {{ result.shots.length }}</span>
              <button type="button" @click="toggleAll">
                {{ selectedCount === result.shots.length ? '清空' : '全选' }}
              </button>
            </div>
            <div class="preview-list">
              <label v-for="shot in result.shots" :key="shot.id" class="preview-row">
                <input type="checkbox" :checked="selectedIds.includes(shot.id)" @change="toggleShot(shot.id)" />
                <span class="preview-index">{{ String(shot.index).padStart(2, '0') }}</span>
                <span class="preview-range">{{ formatTime(shot.startMs) }} – {{ formatTime(shot.endMs) }}</span>
                <span class="preview-ai">
                  {{ shot.remark || (shot.shotSize ? `本地模型：${shot.shotSize}` : '等待本地模型分析') }}
                </span>
                <span>{{ (shot.durationMs / 1000).toFixed(1) }} 秒</span>
              </label>
            </div>
            <footer class="result-actions">
              <button type="button" @click="emit('close')">取消</button>
              <button type="button" @click="emit('retry')">重新检测</button>
              <button class="primary" type="button" :disabled="selectedCount === 0 || applying" @click="applyResult">
                {{ applying ? '正在应用…' : `应用 ${selectedCount} 个镜头` }}
              </button>
            </footer>
          </template>
        </div>
      </section>
    </div>
  </transition>
</template>

<style scoped>
.detect-capsule {
  position: fixed;
  top: 8px;
  right: 16px;
  z-index: 120;
  display: flex;
  max-width: min(460px, calc(100vw - 32px));
  align-items: center;
  gap: 8px;
  padding: 7px 10px;
  border: 1px solid var(--border-strong);
  border-radius: 999px;
  background: var(--bg-panel);
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.35);
}

.capsule-dot {
  width: 6px;
  height: 6px;
  flex: 0 0 auto;
  border-radius: 50%;
  background: var(--amber);
  animation: capsule-pulse 1s ease-in-out infinite;
}

.capsule-copy {
  display: flex;
  min-width: 120px;
  flex-direction: column;
  gap: 3px;
}

.capsule-copy strong {
  color: var(--text-secondary);
  font-size: 10px;
  font-weight: 600;
}

.capsule-track {
  width: 140px;
  height: 3px;
  overflow: hidden;
  border-radius: 2px;
  background: var(--bg-raised);
}

.capsule-track i {
  display: block;
  height: 100%;
  border-radius: 2px;
  background: var(--blue-hi);
  transition: width 180ms ease;
}

.capsule-close,
.capsule-cancel {
  height: 24px;
  padding: 0 8px;
  border: 1px solid var(--border);
  border-radius: 999px;
  background: var(--bg-raised);
  color: var(--text-muted);
  font-size: 9px;
}

.capsule-cancel {
  border-color: rgba(239, 68, 68, 0.35);
  color: #fca5a5;
}

@keyframes capsule-pulse {
  50% {
    opacity: 0.35;
  }
}

.modal-mask {
  position: fixed;
  inset: 0;
  display: grid;
  padding: 16px;
  background: rgba(2, 6, 23, 0.64);
  place-items: center;
  z-index: 90;
}

.detect-modal {
  display: flex;
  width: 620px;
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

.modal-head button {
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

.modal-head button:hover:not(:disabled) {
  background: var(--bg-hover);
}

.detect-running {
  display: grid;
  grid-template-columns: 150px minmax(0, 1fr);
  gap: 24px;
  align-items: center;
  padding: 24px;
}

.detect-running img {
  width: 150px;
  height: 150px;
  border: 1px solid var(--border);
  border-radius: 8px;
  object-fit: cover;
}

.running-copy {
  display: flex;
  min-width: 0;
  flex-direction: column;
}

.scan-label {
  color: var(--text-muted);
  font-size: 11px;
}

.running-copy strong {
  margin-top: 4px;
  color: var(--text-primary);
  font-family: var(--mono);
  font-size: 30px;
  font-weight: 500;
}

.running-copy p {
  margin: 8px 0 0;
  color: var(--text-faint);
  font-size: 10px;
}

.running-copy .gpu-status {
  margin-top: 7px;
  color: var(--blue-hi);
  font-family: var(--mono);
  font-size: 9px;
}

.progress-track {
  height: 5px;
  margin-top: 12px;
  overflow: hidden;
  border-radius: 3px;
  background: var(--bg-raised);
}

.progress-track i {
  display: block;
  height: 100%;
  background: var(--amber);
  transition: width 160ms ease;
}

.cancel-scan {
  grid-column: 1 / -1;
  justify-self: end;
  height: 28px;
  padding: 0 12px;
  border: 0;
  border-radius: 6px;
  background: var(--bg-raised);
  color: var(--text-secondary);
  font-size: 11px;
}

.detect-error,
.no-cut {
  display: flex;
  min-height: 300px;
  align-items: center;
  justify-content: center;
  flex-direction: column;
  gap: 8px;
  padding: 24px;
  color: var(--text-muted);
  text-align: center;
}

.detect-error strong,
.no-cut strong {
  color: var(--text-primary);
  font-size: 14px;
}

.detect-error p,
.no-cut p {
  margin: 0;
  color: var(--text-muted);
  font-size: 11px;
}

.detect-error div {
  display: flex;
  gap: 8px;
  margin-top: 8px;
}

.detect-error button,
.no-cut button {
  height: 28px;
  padding: 0 12px;
  border: 0;
  border-radius: 6px;
  background: var(--bg-raised);
  color: var(--text-secondary);
}

.detect-error .primary,
.no-cut .primary {
  background: var(--red);
  color: #fff;
}

.no-cut img {
  width: min(300px, 80%);
  max-height: 180px;
  border-radius: 8px;
  object-fit: cover;
}

.detect-result {
  display: flex;
  min-height: 0;
  flex-direction: column;
}

.result-summary {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 8px;
  padding: 12px 16px;
  border-bottom: 1px solid var(--border);
}

.result-summary div {
  display: flex;
  flex-direction: column;
  gap: 3px;
  padding: 8px;
  border-radius: 6px;
  background: var(--bg-raised);
}

.result-summary span {
  color: var(--text-faint);
  font-size: 10px;
}

.result-summary strong {
  color: var(--text-primary);
  font-family: var(--mono);
  font-size: 18px;
  font-weight: 500;
}

.preview-head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 12px 16px 8px;
  color: var(--text-secondary);
  font-size: 11px;
}

.preview-head span {
  color: var(--text-faint);
}

.preview-head button {
  margin-left: auto;
  padding: 0;
  border: 0;
  background: transparent;
  color: var(--blue-hi);
  font-size: 10px;
}

.preview-list {
  min-height: 0;
  max-height: 340px;
  overflow-y: auto;
  border-top: 1px solid var(--border);
  border-bottom: 1px solid var(--border);
}

.preview-row {
  display: grid;
  min-height: 38px;
  grid-template-columns: 20px 30px 96px minmax(0, 1fr) 58px;
  align-items: center;
  gap: 8px;
  padding: 0 16px;
  border-bottom: 1px solid rgba(71, 85, 105, 0.4);
  color: var(--text-muted);
  font-family: var(--mono);
  font-size: 10px;
}

.preview-row:hover {
  background: var(--bg-hover);
}

.preview-row input {
  accent-color: var(--red);
}

.preview-index {
  color: var(--text-secondary);
}

.preview-range {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.preview-ai {
  overflow: hidden;
  color: var(--text-secondary);
  font-family: var(--sans, sans-serif);
  font-size: 9px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.result-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  padding: 12px 16px;
}

.result-actions button {
  height: 28px;
  padding: 0 12px;
  border: 0;
  border-radius: 6px;
  background: var(--bg-raised);
  color: var(--text-secondary);
  font-size: 11px;
}

.result-actions button:hover:not(:disabled) {
  background: var(--bg-hover);
}

.result-actions .primary {
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
