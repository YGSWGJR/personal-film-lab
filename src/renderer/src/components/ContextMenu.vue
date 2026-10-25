<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue';

interface ContextMenuItem {
  label: string;
  danger?: boolean;
  disabled?: boolean;
  action: () => void;
}

const props = defineProps<{
  visible: boolean;
  x: number;
  y: number;
  items: ContextMenuItem[];
}>();

const emit = defineEmits<{
  close: [];
}>();

const menu = ref<HTMLElement | null>(null);
const position = reactive({ left: 0, top: 0 });

async function updatePosition(): Promise<void> {
  await nextTick();
  const width = menu.value?.offsetWidth ?? 220;
  const height = menu.value?.offsetHeight ?? Math.max(1, props.items.length) * 34 + 8;
  const padding = 8;
  position.left =
    props.x + width > window.innerWidth - padding
      ? Math.max(padding, props.x - width)
      : Math.max(padding, props.x);
  position.top =
    props.y + height > window.innerHeight - padding
      ? Math.max(padding, props.y - height)
      : Math.max(padding, props.y);
}

watch(
  () => [props.visible, props.x, props.y, props.items] as const,
  ([visible]) => {
    if (visible) void updatePosition();
  },
  { immediate: true },
);

function runItem(item: ContextMenuItem): void {
  if (item.disabled) return;
  emit('close');
  item.action();
}

function onPointerDown(event: PointerEvent): void {
  if (!props.visible || menu.value?.contains(event.target as Node)) return;
  emit('close');
}

function onKeydown(event: KeyboardEvent): void {
  if (props.visible && event.key === 'Escape') emit('close');
}

function closeOnViewportChange(): void {
  if (props.visible) emit('close');
}

onMounted(() => {
  window.addEventListener('pointerdown', onPointerDown, true);
  window.addEventListener('keydown', onKeydown, true);
  window.addEventListener('blur', closeOnViewportChange);
  window.addEventListener('resize', closeOnViewportChange);
  window.addEventListener('scroll', closeOnViewportChange, true);
});

onBeforeUnmount(() => {
  window.removeEventListener('pointerdown', onPointerDown, true);
  window.removeEventListener('keydown', onKeydown, true);
  window.removeEventListener('blur', closeOnViewportChange);
  window.removeEventListener('resize', closeOnViewportChange);
  window.removeEventListener('scroll', closeOnViewportChange, true);
});
</script>

<template>
  <Teleport to="body">
    <transition name="context-menu">
      <div
        v-if="visible"
        ref="menu"
        class="context-menu"
        :style="{ left: `${position.left}px`, top: `${position.top}px` }"
        role="menu"
        @pointerdown.stop
      >
        <button
          v-for="item in items"
          :key="item.label"
          type="button"
          role="menuitem"
          :class="{ danger: item.danger }"
          :disabled="item.disabled"
          @click.stop="runItem(item)"
        >
          {{ item.label }}
        </button>
      </div>
    </transition>
  </Teleport>
</template>

<style scoped>
.context-menu {
  position: fixed;
  z-index: 120;
  display: flex;
  width: 232px;
  max-width: calc(100vw - 16px);
  flex-direction: column;
  gap: 2px;
  padding: 5px;
  border: 1px solid rgba(148, 163, 184, 0.7);
  border-radius: 7px;
  background: #f8fafc;
  box-shadow: 0 14px 38px rgba(2, 6, 23, 0.34);
}

.context-menu button {
  width: 100%;
  min-height: 30px;
  padding: 6px 9px;
  border: 0;
  border-radius: 4px;
  background: transparent;
  color: #334155;
  font-size: 11px;
  line-height: 1.45;
  text-align: left;
  white-space: normal;
}

.context-menu button:hover:not(:disabled) {
  background: #e2e8f0;
  color: #0f172a;
}

.context-menu button.danger {
  color: #be123c;
}

.context-menu button.danger:hover:not(:disabled) {
  background: #ffe4e6;
}

.context-menu button:disabled {
  color: #94a3b8;
}

.context-menu-enter-active,
.context-menu-leave-active {
  transition:
    opacity 100ms ease,
    transform 100ms ease;
}

.context-menu-enter-from,
.context-menu-leave-to {
  opacity: 0;
  transform: translateY(-3px) scale(0.98);
}
</style>
