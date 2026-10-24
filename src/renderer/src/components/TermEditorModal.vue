<script setup lang="ts">
import { reactive, watch } from 'vue';
import type { Term } from '../../../shared/types';

const props = defineProps<{
  open: boolean;
  term: Term | null;
  saving: boolean;
}>();

const emit = defineEmits<{
  close: [];
  save: [value: { term: string; definition: string; category: string }];
  delete: [id: string];
}>();

const form = reactive({
  term: '',
  definition: '',
  category: 'custom',
});

watch(
  () => [props.open, props.term] as const,
  ([open, term]) => {
    if (!open) return;
    form.term = term?.term ?? '';
    form.definition = term?.definition ?? '';
    form.category = term?.category ?? 'custom';
  },
  { immediate: true },
);

function submit(): void {
  if (!form.term.trim() || !form.definition.trim() || props.saving) return;
  emit('save', {
    term: form.term.trim(),
    definition: form.definition.trim(),
    category: form.category.trim() || 'custom',
  });
}
</script>

<template>
  <transition name="modal">
    <div v-if="open" class="modal-mask" @pointerdown.self="emit('close')">
      <form class="term-modal" @submit.prevent="submit">
        <header class="modal-head">
          <div>
            <p>{{ term ? 'EDIT TERM' : 'NEW TERM' }}</p>
            <h2>{{ term ? '编辑术语' : '新建术语' }}</h2>
          </div>
          <button type="button" aria-label="关闭" @click="emit('close')">×</button>
        </header>

        <label>
          <span>术语名</span>
          <input v-model="form.term" maxlength="200" placeholder="例如：视线匹配" autofocus />
        </label>
        <label>
          <span>分类</span>
          <input v-model="form.category" maxlength="50" placeholder="custom" />
        </label>
        <label>
          <span>释义</span>
          <textarea v-model="form.definition" maxlength="20000" rows="5" placeholder="输入术语定义"></textarea>
        </label>

        <footer>
          <button
            v-if="term"
            class="danger"
            type="button"
            :disabled="saving"
            @click="emit('delete', term.id)"
          >
            删除
          </button>
          <span></span>
          <button type="button" :disabled="saving" @click="emit('close')">取消</button>
          <button
            class="primary"
            type="submit"
            :disabled="saving || !form.term.trim() || !form.definition.trim()"
          >
            {{ saving ? '保存中…' : '保存' }}
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
  background: rgba(2, 6, 23, 0.6);
  place-items: center;
  z-index: 80;
}

.term-modal {
  width: 480px;
  max-width: calc(100vw - 32px);
  padding: 16px;
  border: 1px solid var(--border);
  border-radius: 10px;
  background: var(--bg-panel);
  box-shadow: 0 24px 80px rgba(0, 0, 0, 0.48);
}

.modal-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  margin-bottom: 16px;
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

.modal-head > button:hover {
  background: var(--bg-hover);
}

label {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-top: 12px;
  color: var(--text-muted);
  font-size: 11px;
}

input,
textarea {
  width: 100%;
  padding: 0 8px;
  border: 1px solid var(--border);
  border-radius: 6px;
  outline: 0;
  background: var(--bg-raised);
  color: var(--text-secondary);
  font: inherit;
  font-size: 12px;
}

input {
  height: 28px;
}

textarea {
  resize: vertical;
  padding-top: 8px;
  line-height: 1.5;
}

input:focus,
textarea:focus {
  border-color: var(--border-strong);
  box-shadow: 0 0 0 2px rgba(251, 191, 36, 0.34);
}

footer {
  display: flex;
  gap: 8px;
  margin-top: 16px;
}

footer span {
  flex: 1;
}

footer button {
  height: 28px;
  padding: 0 12px;
  border: 0;
  border-radius: 6px;
  background: var(--bg-raised);
  color: var(--text-secondary);
  font-size: 12px;
}

footer button:hover:not(:disabled) {
  background: var(--bg-hover);
}

footer .primary {
  background: var(--red);
  color: #fff;
  font-weight: 600;
}

footer .danger {
  color: var(--danger);
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
