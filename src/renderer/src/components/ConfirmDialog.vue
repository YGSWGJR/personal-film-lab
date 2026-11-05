<script setup lang="ts">
import { watch } from 'vue';
import AppIcon from './AppIcon.vue';

/**
 * 危险操作统一确认弹窗（S36-1b）。
 * - 复用 SettingsModal 的 Modal 视觉模式，teleport 到 body 保证 z-index 高于其他弹窗；
 * - Esc 取消、Enter 确认（窗口级监听，App 全局快捷键在弹窗打开时让位）；
 * - 固定警示文案：此操作不可恢复，文件将永久删除，不进回收站。
 */
const props = defineProps<{
  open: boolean;
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  warning?: string;
}>();

const emit = defineEmits<{
  cancel: [];
  confirm: [];
}>();

function handleKeydown(event: KeyboardEvent): void {
  if (!props.open) return;
  if (event.key === 'Escape') {
    event.preventDefault();
    event.stopPropagation();
    emit('cancel');
    return;
  }
  if (event.key === 'Enter') {
    event.preventDefault();
    event.stopPropagation();
    emit('confirm');
  }
}

watch(
  () => props.open,
  (open) => {
    if (open) window.addEventListener('keydown', handleKeydown);
    else window.removeEventListener('keydown', handleKeydown);
  },
  { immediate: true },
);
</script>

<template>
  <teleport to="body">
    <transition name="confirm-dialog">
      <div v-if="open" class="confirm-dialog-mask" @pointerdown.self="emit('cancel')">
        <div
          class="confirm-dialog"
          role="alertdialog"
          aria-modal="true"
          :aria-label="title"
        >
          <div class="confirm-dialog-head">
            <span class="confirm-dialog-icon">
              <AppIcon name="more" :size="18" />
            </span>
            <div class="confirm-dialog-copy">
              <h2 class="confirm-dialog-title">{{ title }}</h2>
              <p class="confirm-dialog-message">{{ message }}</p>
            </div>
          </div>
          <p class="confirm-dialog-warning">
            {{ warning ?? '此操作不可恢复，文件将永久删除，不进回收站。' }}
          </p>
          <div class="confirm-dialog-actions">
            <button type="button" class="confirm-dialog-cancel" @click="emit('cancel')">
              {{ cancelLabel ?? '取消' }}
            </button>
            <button type="button" class="confirm-dialog-confirm" @click="emit('confirm')">
              {{ confirmLabel ?? '删除' }}
            </button>
          </div>
        </div>
      </div>
    </transition>
  </teleport>
</template>

<style scoped>
.confirm-dialog-mask {
  position: fixed;
  inset: 0;
  display: grid;
  padding: 16px;
  background: rgba(2, 6, 23, 0.66);
  place-items: center;
  /* 高于 SettingsModal（z-index 90）等所有业务弹窗 */
  z-index: 120;
}

.confirm-dialog {
  display: flex;
  width: 400px;
  max-width: calc(100vw - 32px);
  flex-direction: column;
  gap: 12px;
  padding: 16px;
  border: 1px solid rgba(225, 29, 72, 0.32);
  border-radius: 10px;
  background: var(--bg-panel);
  box-shadow: 0 28px 90px rgba(0, 0, 0, 0.52);
}

.confirm-dialog-head {
  display: flex;
  align-items: flex-start;
  gap: 10px;
}

.confirm-dialog-icon {
  display: grid;
  width: 30px;
  height: 30px;
  flex: 0 0 auto;
  border: 1px solid rgba(225, 29, 72, 0.35);
  border-radius: 7px;
  background: rgba(225, 29, 72, 0.1);
  color: var(--red);
  place-items: center;
}

.confirm-dialog-copy {
  display: flex;
  min-width: 0;
  flex-direction: column;
  gap: 4px;
}

.confirm-dialog-title {
  margin: 0;
  color: var(--text-primary);
  font-size: 13px;
  font-weight: 600;
}

.confirm-dialog-message {
  margin: 0;
  color: var(--text-secondary);
  font-size: 11px;
  line-height: 1.6;
  overflow-wrap: anywhere;
}

.confirm-dialog-warning {
  margin: 0;
  padding: 8px 10px;
  border: 1px solid rgba(225, 29, 72, 0.3);
  border-radius: 6px;
  background: rgba(225, 29, 72, 0.08);
  color: #fda4af;
  font-size: 10px;
  line-height: 1.55;
}

.confirm-dialog-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}

.confirm-dialog-actions button {
  height: 30px;
  padding: 0 14px;
  border: 0;
  border-radius: 5px;
  font-size: 11px;
}

.confirm-dialog-cancel {
  background: var(--bg-raised);
  color: var(--text-secondary);
}

.confirm-dialog-cancel:hover {
  background: var(--bg-hover);
}

.confirm-dialog-confirm {
  background: var(--red);
  color: #fff;
  font-weight: 600;
}

.confirm-dialog-confirm:hover {
  filter: brightness(1.1);
}

.confirm-dialog-enter-active,
.confirm-dialog-leave-active {
  transition: opacity 140ms ease;
}

.confirm-dialog-enter-from,
.confirm-dialog-leave-to {
  opacity: 0;
}
</style>
