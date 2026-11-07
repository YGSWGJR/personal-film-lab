<template>
  <aside class="wnp panel-base" :class="{ collapsed }">
    <header class="wnp-head">
      <b>节点标注</b>
      <button type="button" class="wnp-fold" :title="collapsed ? '展开面板' : '折叠面板'" @click="collapsed = !collapsed">
        {{ collapsed ? '‹' : '›' }}
      </button>
    </header>
    <div v-if="collapsed" class="wnp-collapsed-hint">{{ node ? node.title || '未命名节点' : '未选中' }}</div>
    <div v-else-if="!node" class="wnp-empty">
      在画布上点选一个节点，在这里编辑名称、时长、标签与笔记。
      <small>改动即存，无需手动保存。</small>
    </div>
    <div v-else class="wnp-body">
      <label class="wnp-field">
        <span>名称</span>
        <input v-model="titleDraft" maxlength="200" placeholder="节点名称" @input="queueSave" />
      </label>
      <label class="wnp-field">
        <span>持续时间（秒）</span>
        <input v-model="durationDraft" type="number" min="0.2" max="600" step="0.1" @input="queueSave" />
      </label>
      <section v-for="group in tagGroups" :key="group.category" class="wnp-tags">
        <span class="wnp-cat">{{ group.category }}</span>
        <div class="wnp-chips">
          <button
            v-for="tag in group.items"
            :key="tag.id"
            type="button"
            class="chip"
            :class="{ on: isTagged(group.category, tag.name) }"
            @click="toggleTag(group.category, tag.name)"
          >
            {{ tag.name }}
          </button>
        </div>
      </section>
      <label class="wnp-field">
        <span>笔记</span>
        <textarea v-model="noteDraft" rows="5" placeholder="这个节点的拍摄意图、备注…" @input="queueSave"></textarea>
      </label>
      <p class="wnp-state" :class="saveState">{{ stateText }}</p>
    </div>
  </aside>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import type { Tag, WallBoardNodeInfo } from '../../../shared/types';

/**
 * 批次3：分镜墙内嵌节点标注面板（独立分镜本专用，不写 shots 表）。
 * 选中即载入、改动即存（字段防抖 500ms；标签即时 upsert）。
 */
const props = defineProps<{
  boardId: string;
  node: WallBoardNodeInfo | null;
}>();

const emit = defineEmits<{ changed: [] }>();

const CATEGORY_ORDER = ['景别', '机位', '运镜', '光线', '声音', '剪辑'];

const collapsed = ref(false);
const titleDraft = ref('');
const durationDraft = ref('3');
const noteDraft = ref('');
const presets = ref<Tag[]>([]);
const assigned = ref<Set<string>>(new Set());
const saveState = ref<'idle' | 'pending' | 'saved' | 'error'>('idle');
let flushTimer = 0;
let dirty = false;

const tagGroups = computed(() => {
  const known = new Set(CATEGORY_ORDER);
  const extra = [...new Set(presets.value.map((t) => t.category))].filter((c) => !known.has(c));
  const categories = [...CATEGORY_ORDER, ...extra];
  return categories
    .map((category) => ({
      category,
      items: presets.value.filter((t) => t.category === category).sort((a, b) => a.sortOrder - b.sortOrder),
    }))
    .filter((group) => group.items.length > 0);
});

const stateText = computed(() => {
  if (saveState.value === 'pending') return '保存中…';
  if (saveState.value === 'saved') return '已自动保存';
  if (saveState.value === 'error') return '保存失败，请重试';
  return '改动即存';
});

onMounted(async () => {
  const res = await window.api.tag.list();
  if (res.ok) presets.value = res.data;
  if (props.node) {
    syncFromNode();
    void loadAssigned();
  }
});

onBeforeUnmount(() => clearTimeout(flushTimer));

watch(
  () => props.node,
  (node) => {
    syncFromNode();
    if (node) void loadAssigned();
  },
);

function syncFromNode(): void {
  const node = props.node;
  if (!node) return;
  // 焦点在输入框时不覆盖草稿（防打字被打断）
  const active = document.activeElement;
  if (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement) return;
  titleDraft.value = node.title;
  durationDraft.value = String(Math.round(node.durationMs / 100) / 10);
  noteDraft.value = node.note;
  dirty = false;
}

async function loadAssigned(): Promise<void> {
  const node = props.node;
  if (!node || !props.boardId) {
    assigned.value = new Set();
    return;
  }
  const res = await window.api.wall.listNodeTags({ boardId: props.boardId });
  if (!res.ok) return;
  const list = res.data[node.id] ?? [];
  assigned.value = new Set(list.map((t) => tagKey(t.category, t.name)));
}

function tagKey(category: string, name: string): string {
  return category + '\n' + name;
}

function isTagged(category: string, name: string): boolean {
  return assigned.value.has(tagKey(category, name));
}

function queueSave(): void {
  dirty = true;
  saveState.value = 'pending';
  clearTimeout(flushTimer);
  flushTimer = window.setTimeout(() => void flushSave(), 500);
}

function parseDurationMs(raw: string): number | null {
  const sec = Number.parseFloat(raw);
  if (!Number.isFinite(sec) || sec < 0.2) return null;
  return Math.min(600_000, Math.round(sec * 1000));
}

async function flushSave(): Promise<void> {
  clearTimeout(flushTimer);
  const node = props.node;
  if (!node || !dirty) {
    saveState.value = 'idle';
    return;
  }
  const patch: { title?: string; durationMs?: number; note?: string } = {};
  const title = titleDraft.value.trim();
  if (title !== node.title) patch.title = title;
  const durMs = parseDurationMs(durationDraft.value);
  if (durMs !== null && durMs !== node.durationMs) patch.durationMs = durMs;
  if (noteDraft.value !== node.note) patch.note = noteDraft.value;
  if (Object.keys(patch).length === 0) {
    dirty = false;
    saveState.value = 'idle';
    return;
  }
  const res = await window.api.wall.updateNode({ nodeId: node.id, patch });
  if (!res.ok) {
    saveState.value = 'error';
    return;
  }
  dirty = false;
  saveState.value = 'saved';
  emit('changed');
}

async function toggleTag(category: string, name: string): Promise<void> {
  const node = props.node;
  if (!node || !props.boardId) return;
  const key = tagKey(category, name);
  const had = assigned.value.has(key);
  const next = new Set(assigned.value);
  if (had) next.delete(key);
  else next.add(key);
  assigned.value = next;
  const res = had
    ? await window.api.wall.removeNodeTag({ boardId: props.boardId, nodeId: node.id, category, name })
    : await window.api.wall.addNodeTag({ boardId: props.boardId, nodeId: node.id, category, name });
  if (!res.ok) {
    // 失败回滚本地状态
    const revert = new Set(assigned.value);
    if (had) revert.add(key);
    else revert.delete(key);
    assigned.value = revert;
  }
}
</script>

<style scoped>
.wnp {
  position: fixed;
  top: 52px;
  right: 12px;
  bottom: 36px;
  width: 300px;
  z-index: 65;
  display: flex;
  flex-direction: column;
  font-size: 12px;
  box-shadow: 0 8px 28px rgba(0, 0, 0, 0.35);
}

.wnp.collapsed {
  width: 44px;
}

.wnp-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 10px;
  border-bottom: 1px solid var(--border);
  flex: 0 0 auto;
}

.wnp-fold {
  border: 1px solid var(--border);
  background: transparent;
  color: var(--text-faint);
  border-radius: 4px;
  width: 22px;
  height: 22px;
  cursor: pointer;
  line-height: 1;
}

.wnp-fold:hover {
  color: var(--text);
  border-color: var(--text-faint);
}

.wnp-collapsed-hint {
  flex: 1;
  display: flex;
  align-items: flex-end;
  justify-content: center;
  padding: 8px 0;
  color: var(--text-faint);
  writing-mode: vertical-rl;
  overflow: hidden;
  white-space: nowrap;
}

.wnp-empty {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 16px;
  text-align: center;
  color: var(--text-faint);
}

.wnp-body {
  flex: 1;
  overflow-y: auto;
  padding: 10px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.wnp-field {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.wnp-field span {
  color: var(--text-faint);
}

.wnp-field input,
.wnp-field textarea {
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--bg-deep, #0a0e16);
  color: var(--text);
  padding: 6px 8px;
  font-size: 12px;
  font-family: inherit;
  resize: vertical;
}

.wnp-field input:focus,
.wnp-field textarea:focus {
  outline: none;
  border-color: var(--blue-hi, #5aa2ff);
}

.wnp-tags {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.wnp-cat {
  color: var(--text-faint);
}

.wnp-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.wnp-chips .chip {
  border: 1px solid var(--border);
  border-radius: 999px;
  background: transparent;
  color: var(--text);
  padding: 2px 10px;
  font-size: 11px;
  cursor: pointer;
}

.wnp-chips .chip:hover {
  border-color: var(--text-faint);
}

.wnp-chips .chip.on {
  background: var(--green, #34d399);
  border-color: var(--green, #34d399);
  color: #06281c;
}

.wnp-state {
  margin: 0;
  color: var(--text-faint);
  font-size: 11px;
  min-height: 14px;
}

.wnp-state.error {
  color: #ff7a7a;
}

.wnp-state.saved {
  color: var(--green, #34d399);
}
</style>
