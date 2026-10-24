<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import AppIcon from './AppIcon.vue';
import ScopeCanvas from './ScopeCanvas.vue';
import type { ScopeAnalysis } from '../../../shared/types';
import type { ScopeMode } from '../types/scope';

const props = defineProps<{
  open: boolean;
  analysis: ScopeAnalysis | null;
  loading: boolean;
  error: string | null;
}>();

const emit = defineEmits<{
  toggle: [];
}>();

const activeMode = ref<ScopeMode>('histogram');
const references = ref(true);
const tabs: Array<{ mode: ScopeMode; label: string; short: string }> = [
  { mode: 'histogram', label: '直方图', short: 'HIST' },
  { mode: 'waveform', label: '波形图', short: 'WAVE' },
  { mode: 'vectorscope', label: '矢量图', short: 'VECT' },
  { mode: 'parade', label: '分量图', short: 'RGB' },
  { mode: 'cie', label: 'CIE 1931', short: 'CIE' },
];
const activeLabel = computed(() => tabs.find((tab) => tab.mode === activeMode.value)?.label ?? '');

watch(
  () => props.open,
  (open) => {
    if (!open) references.value = true;
  },
);
</script>

<template>
  <section class="scopes-panel" :class="{ collapsed: !open }">
    <header class="scopes-head">
      <div class="scopes-title">
        <i></i>
        <span>SCOPES</span>
        <em>{{ activeLabel }}</em>
      </div>
      <nav v-if="open" class="scope-tabs" aria-label="示波器类型">
        <button
          v-for="tab in tabs"
          :key="tab.mode"
          type="button"
          :class="{ active: activeMode === tab.mode }"
          :title="tab.label"
          @click="activeMode = tab.mode"
        >
          <span>{{ tab.label }}</span>
          <small>{{ tab.short }}</small>
        </button>
      </nav>
      <div class="scope-actions">
        <button
          v-if="open"
          type="button"
          class="reference-toggle"
          :class="{ active: references }"
          @click="references = !references"
        >
          参考线
        </button>
        <button type="button" :title="open ? '收起示波器' : '展开示波器'" @click="emit('toggle')">
          <AppIcon :name="open ? 'chevron-down' : 'chevron-right'" :size="13" />
        </button>
      </div>
    </header>

    <div v-if="open" class="scope-viewport">
      <ScopeCanvas :mode="activeMode" :analysis="analysis" :references="references" />
      <div v-if="!analysis && !loading" class="scope-empty">
        <strong>NO SIGNAL</strong>
        <span>导入影片后实时分析当前帧</span>
      </div>
      <div v-if="loading" class="scope-loading">
        <i></i>
        <span>ANALYZING FRAME</span>
      </div>
      <span v-if="error" class="scope-error">{{ error }}</span>
    </div>
  </section>
</template>

<style scoped>
.scopes-panel {
  display: flex;
  height: 174px;
  flex: 0 0 auto;
  min-height: 0;
  flex-direction: column;
  overflow: hidden;
  border: 1px solid var(--border);
  border-top: 0;
  background: #080d14;
}

.scopes-panel.collapsed {
  height: 29px;
}

.scopes-head {
  display: grid;
  height: 29px;
  flex: 0 0 auto;
  grid-template-columns: auto minmax(0, 1fr) auto;
  align-items: center;
  gap: 12px;
  padding: 0 8px 0 10px;
  border-bottom: 1px solid rgba(71, 85, 105, 0.62);
  background: #111a27;
}

.scopes-title,
.scope-actions {
  display: flex;
  align-items: center;
  gap: 7px;
}

.scopes-title i {
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: var(--amber);
  box-shadow: 0 0 8px rgba(245, 158, 11, 0.55);
}

.scopes-title span {
  color: var(--text-secondary);
  font-family: var(--mono);
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 1px;
}

.scopes-title em {
  color: var(--text-faint);
  font-size: 9px;
  font-style: normal;
}

.scope-tabs {
  display: flex;
  min-width: 0;
  align-items: center;
  justify-content: center;
  gap: 2px;
}

.scope-tabs button {
  display: flex;
  height: 22px;
  align-items: center;
  gap: 4px;
  padding: 0 7px;
  border: 0;
  border-radius: 4px;
  background: transparent;
  color: var(--text-faint);
  font-size: 9px;
}

.scope-tabs button small {
  color: #53647a;
  font-family: var(--mono);
  font-size: 7px;
}

.scope-tabs button:hover,
.scope-tabs button.active {
  background: rgba(96, 165, 250, 0.1);
  color: var(--blue-hi);
}

.scope-tabs button.active small {
  color: var(--amber);
}

.reference-toggle,
.scope-actions button {
  height: 22px;
  padding: 0 7px;
  border: 1px solid transparent;
  border-radius: 4px;
  background: transparent;
  color: var(--text-faint);
  font-size: 9px;
}

.reference-toggle.active {
  border-color: rgba(245, 158, 11, 0.26);
  background: rgba(245, 158, 11, 0.08);
  color: var(--gold);
}

.scope-actions button:last-child {
  display: grid;
  width: 22px;
  padding: 0;
  place-items: center;
}

.reference-toggle:hover,
.scope-actions button:hover {
  background: var(--bg-hover);
  color: var(--text-secondary);
}

.scope-viewport {
  position: relative;
  min-height: 0;
  flex: 1;
}

.scope-empty,
.scope-loading {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-direction: column;
  gap: 5px;
  color: var(--text-faint);
  pointer-events: none;
}

.scope-empty strong {
  color: #506178;
  font-family: var(--mono);
  font-size: 13px;
  letter-spacing: 2px;
}

.scope-empty span,
.scope-loading span {
  font-size: 9px;
}

.scope-loading {
  background: rgba(8, 13, 20, 0.48);
  color: var(--amber);
  font-family: var(--mono);
  letter-spacing: 1px;
}

.scope-loading i {
  width: 14px;
  height: 14px;
  border: 1px solid rgba(245, 158, 11, 0.22);
  border-top-color: var(--amber);
  border-radius: 50%;
  animation: scope-spin 750ms linear infinite;
}

.scope-error {
  position: absolute;
  right: 8px;
  bottom: 6px;
  max-width: 60%;
  overflow: hidden;
  color: rgba(248, 113, 113, 0.82);
  font-size: 8px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

@keyframes scope-spin {
  to {
    transform: rotate(360deg);
  }
}

@media (max-width: 1260px) {
  .scope-tabs button span {
    display: none;
  }
}
</style>
