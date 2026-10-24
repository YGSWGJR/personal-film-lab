<script setup lang="ts">
import { computed, ref } from 'vue';
import AppIcon from './AppIcon.vue';
import type { DetailTerm, WorkspaceShot } from '../types/workspace';
import type { Tag } from '../../../shared/types';

const props = defineProps<{
  shot: WorkspaceShot | null;
  note: string;
  terms: DetailTerm[];
  tags: Tag[];
  thumbnail: string;
  saving: boolean;
  demoMode: boolean;
}>();

const emit = defineEmits<{
  updateNote: [value: string];
  insertTerm: [term: DetailTerm];
  capture: [];
  saveNote: [];
  collapse: [];
  toggleTag: [tag: Tag];
}>();

const locked = ref(true);
const termsOpen = ref(true);
const activeTool = ref<'box' | 'arrow' | 'text' | 'none'>('box');

const categoryOrder = ['景别', '机位', '运镜', '光线', '声音', '剪辑'];
const assignedTagIds = computed(() => new Set(props.shot?.tagIds ?? []));
const tagGroups = computed(() => {
  const grouped = new Map<string, Tag[]>();
  for (const tag of props.tags) {
    const list = grouped.get(tag.category) ?? [];
    list.push(tag);
    grouped.set(tag.category, list);
  }
  return [...grouped.entries()]
    .sort(([left], [right]) => {
      const leftOrder = categoryOrder.indexOf(left);
      const rightOrder = categoryOrder.indexOf(right);
      return (leftOrder < 0 ? 99 : leftOrder) - (rightOrder < 0 ? 99 : rightOrder);
    })
    .map(([category, items]) => ({
      category,
      items: [...items].sort((left, right) => left.sortOrder - right.sortOrder),
    }));
});

const visibleTerms = computed(() => props.terms.slice(0, 4));

function timeRange(shot: WorkspaceShot): string {
  const start = formatRange(shot.startMs);
  const end = formatRange(shot.endMs);
  return `${start} – ${end}`;
}

function formatRange(ms: number): string {
  const total = Math.floor(ms / 1000);
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  const millis = Math.floor(ms % 1000);
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}.${String(millis).padStart(3, '0')}`;
}

function onNoteInput(event: Event): void {
  emit('updateNote', (event.target as HTMLTextAreaElement).value);
}
</script>

<template>
  <aside class="detail-panel panel-base">
    <div v-if="shot" class="detail-scroll">
      <header class="detail-head">
        <div class="shot-id">镜头 {{ String(shot.index).padStart(2, '0') }}</div>
        <span class="shot-range">{{ timeRange(shot) }}</span>
        <button class="lock-button" :class="{ locked }" type="button" @click="locked = !locked">
          <AppIcon name="bookmark" :size="12" />
          {{ locked ? '已锁定' : '未锁定' }}
        </button>
        <button class="collapse-button" type="button" title="收起镜头详情" @click="emit('collapse')">
          <AppIcon name="chevron-right" :size="14" />
        </button>
      </header>

      <section class="still">
        <img :src="thumbnail" :alt="`${shot.title} 静帧`" />
        <svg class="annotation-demo" viewBox="0 0 160 90" aria-hidden="true">
          <rect x="66" y="45" width="32" height="18" rx="1" />
          <line x1="98" y1="54" x2="126" y2="30" />
          <polyline points="119,30 126,30 126,37" />
        </svg>
        <span class="still-caption">镜头 {{ String(shot.index).padStart(2, '0') }} · {{ shot.shotSize }}</span>
      </section>

      <div class="annotation-tools">
        <button type="button" @click="emit('capture')">截图</button>
        <button :class="{ active: activeTool === 'box' }" type="button" @click="activeTool = 'box'">框选</button>
        <button :class="{ active: activeTool === 'arrow' }" type="button" @click="activeTool = 'arrow'">箭头</button>
        <button :class="{ active: activeTool === 'text' }" type="button" @click="activeTool = 'text'">文字</button>
      </div>

      <div class="tag-grid">
        <section v-for="group in tagGroups" :key="group.category" class="tag-group">
          <div class="tag-title">{{ group.category }}</div>
          <div class="chips">
            <button
              v-for="tag in group.items"
              :key="tag.id"
              class="chip"
              :class="{ on: assignedTagIds.has(tag.id) }"
              type="button"
              @click="emit('toggleTag', tag)"
            >
              {{ tag.name }}
            </button>
            <button class="chip add" type="button" title="新增自定义标签">+</button>
          </div>
        </section>
      </div>

      <section class="note-section">
        <div class="section-title">
          <span>镜头笔记</span>
          <span class="save-state" :class="{ saving }">{{ saving ? '保存中…' : demoMode ? '示例内容' : '自动保存' }}</span>
        </div>
        <textarea
          :value="note"
          placeholder="记录构图、表演、声音或剪辑上的观察…"
          @input="onNoteInput"
          @blur="emit('saveNote')"
        ></textarea>
      </section>

      <section class="term-section">
        <button class="term-head" type="button" @click="termsOpen = !termsOpen">
          <span>术语库</span>
          <AppIcon :name="termsOpen ? 'chevron-down' : 'chevron-right'" :size="14" />
        </button>
        <div v-if="termsOpen" class="term-list">
          <button
            v-for="term in visibleTerms"
            :key="term.id"
            class="term-item"
            type="button"
            :title="`${term.definition}\n点击插入笔记`"
            @click="emit('insertTerm', term)"
          >
            <span class="term-name">{{ term.term }}</span>
            <span class="term-definition">{{ term.definition }}</span>
          </button>
        </div>
      </section>
    </div>

    <div v-else class="detail-empty">
      <AppIcon name="camera" :size="24" />
      <strong>选择一个镜头</strong>
      <p>从镜头列表或时间轴选中后，在这里记录景别、静帧、标签与笔记。</p>
    </div>
  </aside>
</template>

<style scoped>
.detail-panel {
  display: flex;
  min-width: 0;
  min-height: 0;
  flex-direction: column;
  border-radius: 0 8px 8px 0;
}

.detail-scroll {
  min-height: 0;
  flex: 1;
  overflow-y: auto;
  padding: 12px;
}

.detail-head {
  display: flex;
  height: 28px;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
}

.shot-id {
  color: var(--text-primary);
  font-family: var(--mono);
  font-size: 12px;
  font-weight: 600;
  white-space: nowrap;
}

.shot-range {
  overflow: hidden;
  color: var(--text-muted);
  font-family: var(--mono);
  font-size: 11px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.lock-button {
  display: flex;
  min-width: 28px;
  height: 28px;
  align-items: center;
  gap: 4px;
  margin-left: auto;
  padding: 0 6px;
  border: 0;
  border-radius: 4px;
  background: transparent;
  color: var(--text-faint);
  font-size: 10px;
}

.collapse-button {
  display: grid;
  width: 28px;
  height: 28px;
  flex: 0 0 auto;
  padding: 0;
  border: 0;
  border-radius: 4px;
  background: transparent;
  color: var(--text-faint);
  place-items: center;
}

.collapse-button:hover {
  background: var(--bg-hover);
  color: var(--text-primary);
}

.lock-button:hover {
  background: var(--bg-hover);
}

.lock-button.locked {
  color: var(--amber);
}

.still {
  position: relative;
  width: 100%;
  overflow: hidden;
  aspect-ratio: 16 / 9;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--bg-deep);
}

.still img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.annotation-demo {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  fill: none;
  pointer-events: none;
  stroke: var(--red);
  stroke-width: 1.5;
}

.still-caption {
  position: absolute;
  bottom: 8px;
  left: 8px;
  padding: 2px 8px;
  border-radius: 4px;
  background: var(--red);
  color: #fff;
  font-size: 10px;
  font-weight: 600;
}

.annotation-tools {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 8px;
  margin: 8px 0 12px;
}

.annotation-tools button {
  height: 28px;
  border: 0;
  border-radius: 6px;
  background: var(--bg-raised);
  color: var(--text-secondary);
  font-size: 11px;
}

.annotation-tools button:hover,
.annotation-tools button.active {
  background: var(--bg-hover);
  color: var(--text-primary);
}

.tag-grid {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding-bottom: 12px;
  border-bottom: 1px solid var(--border);
}

.tag-title {
  margin-bottom: 6px;
  color: var(--text-secondary);
  font-size: 11px;
  font-weight: 600;
}

.chips {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.chip {
  display: inline-flex;
  height: 20px;
  align-items: center;
  padding: 0 8px;
  border: 1px solid transparent;
  border-radius: 4px;
  background: var(--bg-raised);
  color: var(--text-secondary);
  font-size: 10px;
  font-weight: 600;
}

.chip:hover {
  background: var(--bg-hover);
}

.chip.on {
  background: var(--red);
  color: #fff;
}

.chip.add {
  border-style: dashed;
  color: var(--text-muted);
}

.chip.add:hover {
  border-color: var(--border-strong);
  color: var(--text-primary);
}

.note-section {
  padding: 12px 0;
  border-bottom: 1px solid var(--border);
}

.section-title {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 8px;
  color: var(--text-secondary);
  font-size: 11px;
  font-weight: 600;
}

.save-state {
  color: var(--text-faint);
  font-size: 10px;
  font-weight: 400;
}

.save-state.saving {
  color: var(--amber);
}

.note-section textarea {
  width: 100%;
  min-height: 72px;
  resize: vertical;
  padding: 8px;
  border: 1px solid var(--border);
  border-radius: 6px;
  outline: 0;
  background: var(--bg-raised);
  color: var(--text-secondary);
  font-size: 12px;
  line-height: 1.5;
}

.note-section textarea:focus {
  border-color: var(--border-strong);
  box-shadow: 0 0 0 2px rgba(251, 191, 36, 0.34);
}

.term-section {
  padding-top: 8px;
}

.term-head {
  display: flex;
  width: 100%;
  height: 28px;
  align-items: center;
  justify-content: space-between;
  padding: 0;
  border: 0;
  background: transparent;
  color: var(--text-secondary);
  font-size: 11px;
  font-weight: 600;
}

.term-list {
  display: flex;
  flex-direction: column;
}

.term-item {
  display: flex;
  height: 24px;
  align-items: center;
  gap: 12px;
  border: 0;
  border-bottom: 1px solid rgba(71, 85, 105, 0.4);
  background: transparent;
  text-align: left;
}

.term-item:hover {
  background: var(--bg-hover);
}

.term-name {
  flex: 0 0 auto;
  color: var(--gold);
  font-size: 11px;
}

.term-definition {
  min-width: 0;
  overflow: hidden;
  color: var(--text-muted);
  font-size: 11px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.detail-empty {
  display: flex;
  min-height: 100%;
  align-items: center;
  justify-content: center;
  flex-direction: column;
  gap: 8px;
  padding: 24px;
  color: var(--text-faint);
  text-align: center;
}

.detail-empty strong {
  color: var(--text-secondary);
  font-size: 13px;
}

.detail-empty p {
  margin: 0;
  color: var(--text-muted);
  font-size: 12px;
  line-height: 1.5;
}
</style>
