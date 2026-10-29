<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from 'vue';
import AppIcon from './AppIcon.vue';
import type { DetailTerm, WorkspaceShot } from '../types/workspace';
import type { Annotation, Still, Tag } from '../../../shared/types';
import { formatTimeMs } from '../../../shared/time';

const props = defineProps<{
  shot: WorkspaceShot | null;
  note: string;
  terms: DetailTerm[];
  tags: Tag[];
  still: Still | null;
  thumbnail: string;
  saving: boolean;
  demoMode: boolean;
  emptyImage: string;
}>();

const emit = defineEmits<{
  updateNote: [value: string];
  insertTerm: [term: DetailTerm];
  capture: [];
  saveNote: [];
  collapse: [];
  toggleTag: [tag: Tag];
  setAnnotations: [annotations: Annotation[]];
  createTag: [value: { category: string; name: string }];
  deleteTag: [tag: Tag];
  deleteCategory: [category: string];
  createCategory: [value: { category: string; name: string }];
  createTerm: [];
  editTerm: [term: DetailTerm];
  importTerms: [];
  exportTerms: [];
  contextMenu: [still: Still, position: { x: number; y: number }];
}>();

const locked = ref(true);
const termsOpen = ref(true);
const activeTool = ref<'box' | 'arrow' | 'text' | 'none'>('box');
const drawing = ref<{
  tool: 'box' | 'arrow';
  start: { x: number; y: number };
  current: { x: number; y: number };
} | null>(null);
const textEditor = ref<{ x: number; y: number; value: string } | null>(null);
const stillRoot = ref<HTMLElement | null>(null);
const tagDraft = ref<{ category: string; name: string } | null>(null);
const categoryDraft = ref<{ name: string; tagName: string } | null>(null);

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

const visibleTerms = computed(() =>
  [...props.terms].sort((left, right) => left.category.localeCompare(right.category) || left.sortOrder - right.sortOrder),
);
const demoAnnotations: Annotation[] = [
  { type: 'box', x: 0.42, y: 0.55, w: 0.2, h: 0.12, color: '#e11d48', label: null },
  { type: 'arrow', points: [[0.42, 0.55], [0.72, 0.3]], color: '#f59e0b', label: null },
];
const visibleAnnotations = computed<Annotation[]>(() => {
  const base = props.still?.annotations ?? (props.demoMode ? demoAnnotations : []);
  if (!drawing.value) return base;
  return [...base, draftAnnotation(drawing.value)];
});

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

function normalizedPoint(event: PointerEvent): { x: number; y: number } {
  const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
  return {
    x: Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)),
    y: Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height)),
  };
}

function onStillPointerDown(event: PointerEvent): void {
  if (event.button !== 0 || !props.still || activeTool.value === 'none') return;
  const point = normalizedPoint(event);
  if (activeTool.value === 'text') {
    textEditor.value = { ...point, value: '' };
    return;
  }
  drawing.value = { tool: activeTool.value, start: point, current: point };
  (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
  window.addEventListener('pointerup', finishDrawingFromWindow, { once: true });
}

function onStillPointerMove(event: PointerEvent): void {
  if (!drawing.value) return;
  drawing.value = { ...drawing.value, current: normalizedPoint(event) };
}

function onStillPointerUp(event: PointerEvent): void {
  if (!drawing.value) return;
  finishDrawing();
  try {
    (event.currentTarget as HTMLElement).releasePointerCapture(event.pointerId);
  } catch {
    // pointer 已释放
  }
}

function finishDrawingFromWindow(event: PointerEvent): void {
  if (!drawing.value || !stillRoot.value) return;
  const rect = stillRoot.value.getBoundingClientRect();
  drawing.value = {
    ...drawing.value,
    current: {
      x: Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)),
      y: Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height)),
    },
  };
  finishDrawing();
}

function finishDrawing(): void {
  if (!drawing.value) return;
  const annotation = draftAnnotation(drawing.value);
  drawing.value = null;
  const tooSmall =
    annotation.type === 'box'
      ? Number(annotation.w) < 0.01 || Number(annotation.h) < 0.01
      : Math.hypot(
          (annotation.points?.[1]?.[0] ?? 0) - (annotation.points?.[0]?.[0] ?? 0),
          (annotation.points?.[1]?.[1] ?? 0) - (annotation.points?.[0]?.[1] ?? 0),
        ) < 0.01;
  if (!tooSmall && props.still) {
    emit('setAnnotations', [...props.still.annotations, annotation]);
  }
}

function draftAnnotation(draft: NonNullable<typeof drawing.value>): Annotation {
  if (draft.tool === 'box') {
    return {
      type: 'box',
      x: Math.min(draft.start.x, draft.current.x),
      y: Math.min(draft.start.y, draft.current.y),
      w: Math.abs(draft.current.x - draft.start.x),
      h: Math.abs(draft.current.y - draft.start.y),
      color: '#e11d48',
      label: null,
    };
  }
  return {
    type: 'arrow',
    points: [
      [draft.start.x, draft.start.y],
      [draft.current.x, draft.current.y],
    ],
    color: '#f59e0b',
    label: null,
  };
}

function commitTextAnnotation(): void {
  const editor = textEditor.value;
  const value = editor?.value.trim();
  if (editor && value && props.still) {
    emit('setAnnotations', [
      ...props.still.annotations,
      { type: 'text', x: editor.x, y: editor.y, color: '#f8fafc', label: value },
    ]);
  }
  textEditor.value = null;
}

function beginCustomTag(category: string): void {
  tagDraft.value = { category, name: '' };
}

function submitCustomTag(): void {
  const name = tagDraft.value?.name.trim();
  if (!tagDraft.value || !name) return;
  emit('createTag', { category: tagDraft.value.category, name });
  tagDraft.value = null;
}

function submitNewCategory(): void {
  if (!categoryDraft.value) return;
  const category = categoryDraft.value.name.trim();
  const name = categoryDraft.value.tagName.trim();
  if (!category || !name) return;
  emit('createCategory', { category, name });
  categoryDraft.value = null;
}

onBeforeUnmount(() => {
  window.removeEventListener('pointerup', finishDrawingFromWindow);
});
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

      <section
        ref="stillRoot"
        class="still"
        :class="{ annotating: still && activeTool !== 'none' }"
        @pointerdown="onStillPointerDown"
        @pointermove="onStillPointerMove"
        @pointerup="onStillPointerUp"
        @contextmenu.prevent="still && emit('contextMenu', still, { x: $event.clientX, y: $event.clientY })"
      >
        <img :src="thumbnail" :alt="`${shot.title} 静帧`" />
        <svg class="annotation-layer" viewBox="0 0 1000 562.5" preserveAspectRatio="none" aria-hidden="true">
          <template v-for="(annotation, index) in visibleAnnotations" :key="index">
            <rect
              v-if="annotation.type === 'box'"
              :x="(annotation.x ?? 0) * 1000"
              :y="(annotation.y ?? 0) * 562.5"
              :width="(annotation.w ?? 0) * 1000"
              :height="(annotation.h ?? 0) * 562.5"
              :stroke="annotation.color ?? '#e11d48'"
            />
            <g v-else-if="annotation.type === 'arrow'" :stroke="annotation.color ?? '#f59e0b'">
              <line
                :x1="(annotation.points?.[0]?.[0] ?? 0) * 1000"
                :y1="(annotation.points?.[0]?.[1] ?? 0) * 562.5"
                :x2="(annotation.points?.[1]?.[0] ?? 0) * 1000"
                :y2="(annotation.points?.[1]?.[1] ?? 0) * 562.5"
              />
              <circle
                :cx="(annotation.points?.[1]?.[0] ?? 0) * 1000"
                :cy="(annotation.points?.[1]?.[1] ?? 0) * 562.5"
                r="5"
                :fill="annotation.color ?? '#f59e0b'"
              />
            </g>
            <text
              v-else-if="annotation.type === 'text'"
              :x="(annotation.x ?? 0) * 1000"
              :y="(annotation.y ?? 0) * 562.5"
              :fill="annotation.color ?? '#f8fafc'"
            >{{ annotation.label }}</text>
          </template>
        </svg>
        <span class="still-caption">
          镜头 {{ String(shot.index).padStart(2, '0') }} · {{ shot.shotSize }}
          <template v-if="still"> · {{ formatTimeMs(still.timeMs) }}</template>
        </span>
        <div
          v-if="textEditor"
          class="text-editor"
          :style="{ left: `${textEditor.x * 100}%`, top: `${textEditor.y * 100}%` }"
          @pointerdown.stop
        >
          <input
            v-model="textEditor.value"
            type="text"
            placeholder="输入标注文字"
            autofocus
            @keydown.enter.prevent="commitTextAnnotation"
            @keydown.esc="textEditor = null"
            @blur="commitTextAnnotation"
          />
        </div>
      </section>

      <div class="annotation-tools">
        <button type="button" @click="emit('capture')">截图</button>
        <button :disabled="!still" :class="{ active: activeTool === 'box' }" type="button" @click="activeTool = 'box'">框选</button>
        <button :disabled="!still" :class="{ active: activeTool === 'arrow' }" type="button" @click="activeTool = 'arrow'">箭头</button>
        <button :disabled="!still" :class="{ active: activeTool === 'text' }" type="button" @click="activeTool = 'text'">文字</button>
      </div>

      <div class="tag-grid">
        <section v-for="group in tagGroups" :key="group.category" class="tag-group">
          <div class="tag-title">
            {{ group.category }}
            <span
              v-if="!categoryOrder.includes(group.category)"
              class="title-del"
              title="删除分类"
              @click="emit('deleteCategory', group.category)"
            >×</span>
          </div>
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
              <span
                v-if="!tag.builtin"
                class="chip-del"
                title="删除标签"
                @click.stop="emit('deleteTag', tag)"
              >×</span>
            </button>
            <button class="chip add" type="button" title="新增自定义标签" @click="beginCustomTag(group.category)">+</button>
          </div>
          <form
            v-if="tagDraft?.category === group.category"
            class="custom-tag-form"
            @submit.prevent="submitCustomTag"
          >
            <input
              v-model="tagDraft.name"
              maxlength="100"
              :placeholder="`新增${group.category}标签`"
              autofocus
              @keydown.esc="tagDraft = null"
            />
            <button class="primary" type="submit" :disabled="!tagDraft.name.trim()">添加</button>
            <button type="button" @click="tagDraft = null">取消</button>
          </form>
        </section>
        <section class="tag-group new-cat">
          <template v-if="categoryDraft">
            <form class="custom-tag-form" @submit.prevent="submitNewCategory">
              <input
                v-model="categoryDraft.name"
                maxlength="20"
                placeholder="分类名（如 特效）"
                autofocus
                @keydown.esc="categoryDraft = null"
              />
              <input
                v-model="categoryDraft.tagName"
                maxlength="100"
                placeholder="该分类下首个标签（如 光晕）"
                @keydown.esc="categoryDraft = null"
              />
              <button class="primary" type="submit" :disabled="!categoryDraft.name.trim() || !categoryDraft.tagName.trim()">创建</button>
              <button type="button" @click="categoryDraft = null">取消</button>
            </form>
          </template>
          <button
            v-else
            class="chip add"
            type="button"
            title="新建分类"
            @click="categoryDraft = { name: '', tagName: '' }"
          >+ 新建分类</button>
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
        <div class="term-head">
          <button class="term-toggle" type="button" @click="termsOpen = !termsOpen">
            <span>术语库</span>
            <span class="term-count">{{ terms.length }}</span>
            <AppIcon :name="termsOpen ? 'chevron-down' : 'chevron-right'" :size="14" />
          </button>
          <div class="term-actions">
            <button type="button" @click="emit('importTerms')">导入</button>
            <button type="button" @click="emit('exportTerms')">导出</button>
            <button type="button" title="新建术语" @click="emit('createTerm')">+</button>
          </div>
        </div>
        <div v-if="termsOpen" class="term-list">
          <div
            v-for="term in visibleTerms"
            :key="term.id"
            class="term-item"
            :title="`${term.definition}\n点击插入笔记`"
          >
            <button class="term-insert" type="button" @click="emit('insertTerm', term)">
              <span class="term-name">{{ term.term }}</span>
              <span class="term-definition">{{ term.definition }}</span>
            </button>
            <button class="term-edit" type="button" title="编辑术语" @click="emit('editTerm', term)">✎</button>
          </div>
        </div>
      </section>
    </div>

    <div v-else class="detail-empty">
      <img :src="emptyImage" alt="" />
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

.still.annotating {
  cursor: crosshair;
}

.annotation-layer {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  fill: none;
  pointer-events: none;
  stroke-width: 2;
}

.annotation-layer text {
  font-family: "Microsoft YaHei", "PingFang SC", sans-serif;
  font-size: 18px;
  font-weight: 600;
  paint-order: stroke;
  stroke: rgba(15, 23, 42, 0.85);
  stroke-width: 3px;
}

.text-editor {
  position: absolute;
  width: 150px;
  transform: translateY(-100%);
  z-index: 3;
}

.text-editor input {
  width: 100%;
  height: 28px;
  padding: 0 8px;
  border: 1px solid var(--border-strong);
  border-radius: 4px;
  outline: 0;
  background: rgba(30, 41, 59, 0.96);
  color: var(--text-primary);
  font-size: 12px;
  box-shadow: 0 0 0 2px rgba(251, 191, 36, 0.4);
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

.title-del {
  margin-left: 6px;
  color: var(--text-muted);
  cursor: pointer;
  opacity: 0;
  pointer-events: none;
  transition: color 120ms ease, opacity 120ms ease;
}

.tag-title:hover .title-del {
  opacity: 1;
  pointer-events: auto;
}

.title-del:hover {
  color: var(--red);
}

.chips {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.chip {
  position: relative;
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

.chip-del {
  position: absolute;
  top: -4px;
  right: -4px;
  width: 16px;
  height: 16px;
  border-radius: 50%;
  background: var(--bg-raised);
  color: var(--text-muted);
  cursor: pointer;
  font-size: 11px;
  line-height: 16px;
  opacity: 0;
  pointer-events: none;
  text-align: center;
  transition: color 120ms ease, opacity 120ms ease;
}

.chip:hover .chip-del {
  opacity: 1;
  pointer-events: auto;
}

.chip-del:hover {
  color: var(--red);
}

.chip.add {
  border-style: dashed;
  color: var(--text-muted);
}

.chip.add:hover {
  border-color: var(--border-strong);
  color: var(--text-primary);
}

.custom-tag-form {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto auto;
  gap: 8px;
  margin-top: 8px;
}

.new-cat {
  padding: 8px;
  border: 1px dashed var(--border-strong);
  border-radius: 6px;
}

.new-cat .custom-tag-form {
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
  margin-top: 0;
}

.custom-tag-form input {
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

.custom-tag-form input:focus {
  border-color: var(--border-strong);
  box-shadow: 0 0 0 2px rgba(251, 191, 36, 0.3);
}

.custom-tag-form button {
  height: 28px;
  padding: 0 8px;
  border: 0;
  border-radius: 6px;
  background: var(--bg-raised);
  color: var(--text-muted);
  font-size: 10px;
}

.custom-tag-form button.primary {
  background: var(--red);
  color: #fff;
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
  gap: 8px;
  padding: 0;
  color: var(--text-secondary);
  font-size: 11px;
  font-weight: 600;
}

.term-toggle {
  display: flex;
  min-width: 0;
  align-items: center;
  gap: 6px;
  padding: 0;
  border: 0;
  background: transparent;
  color: inherit;
  font: inherit;
}

.term-count {
  color: var(--text-faint);
  font-family: var(--mono);
  font-size: 10px;
}

.term-actions {
  display: flex;
  align-items: center;
  gap: 4px;
}

.term-actions button {
  height: 28px;
  padding: 0 6px;
  border: 0;
  border-radius: 4px;
  background: transparent;
  color: var(--text-muted);
  font-size: 10px;
}

.term-actions button:hover {
  background: var(--bg-hover);
  color: var(--text-primary);
}

.term-list {
  display: flex;
  max-height: 160px;
  flex-direction: column;
  overflow-y: auto;
}

.term-item {
  display: flex;
  min-height: 28px;
  align-items: center;
  gap: 4px;
  border-bottom: 1px solid rgba(71, 85, 105, 0.4);
}

.term-item:hover {
  background: var(--bg-hover);
}

.term-insert {
  display: flex;
  min-width: 0;
  height: 28px;
  flex: 1;
  align-items: center;
  gap: 12px;
  padding: 0;
  border: 0;
  background: transparent;
  text-align: left;
}

.term-edit {
  width: 28px;
  height: 28px;
  flex: 0 0 auto;
  padding: 0;
  border: 0;
  border-radius: 4px;
  background: transparent;
  color: var(--text-faint);
  font-size: 12px;
}

.term-edit:hover {
  color: var(--text-primary);
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

.detail-empty img {
  width: min(220px, 86%);
  max-height: 162px;
  border: 1px solid var(--border);
  border-radius: 8px;
  object-fit: cover;
  opacity: 0.84;
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
