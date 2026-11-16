<script setup lang="ts">
import type { ProjectSession } from '../project-sessions';

defineProps<{ sessions: ProjectSession[]; activeId: string | null; busy?: boolean }>();
const emit = defineEmits<{ select: [id: string]; close: [id: string]; toggleTasks: [id: string] }>();

function middleClose(event: MouseEvent, id: string): void {
  if (event.button !== 1) return;
  event.preventDefault();
  emit('close', id);
}
</script>

<template>
  <nav class="project-tabs" aria-label="打开的项目">
    <div
      v-for="session in sessions"
      :key="session.id"
      class="project-tab"
      :class="{ active: activeId === session.id }"
      @auxclick="middleClose($event, session.id)"
      @mousedown.middle.prevent
    >
      <button
        type="button"
        class="project-tab-select"
        :data-project-id="session.id"
        :aria-current="activeId === session.id ? 'page' : undefined"
        :title="session.name"
        :disabled="busy"
        @click="emit('select', session.id)"
      >
        <span class="project-tab-name">{{ session.name }}</span>
        <span v-if="session.dirty" class="project-tab-dirty" aria-label="有未保存修改" title="有未保存修改"></span>
      </button>
      <button
        v-if="session.taskCount"
        type="button"
        class="project-tab-tasks"
        :title="session.tasksPaused ? '恢复排队任务' : '暂停排队任务 · ' + session.taskCount + ' 项任务'"
        :aria-label="session.tasksPaused ? '恢复排队任务' : '暂停排队任务'"
        :aria-pressed="session.tasksPaused"
        @click="emit('toggleTasks', session.id)"
      >{{ session.tasksPaused ? 'Ⅱ' : session.taskCount }}</button>
      <button
        type="button"
        class="project-tab-close"
        :aria-label="'关闭 ' + session.name"
        :disabled="busy"
        @click="emit('close', session.id)"
      >×</button>
    </div>
  </nav>
</template>

<style scoped>
.project-tabs {
  display: flex;
  gap: 5px;
  padding: 4px 10px 0;
  overflow-x: auto;
  flex-shrink: 0;
  background: var(--bg, #17191e);
  border-bottom: 1px solid #343741;
}

.project-tab {
  display: flex;
  max-width: 220px;
  min-width: 80px;
  align-items: center;
  border: 1px solid transparent;
  border-bottom: 0;
  border-radius: 5px 5px 0 0;
  color: #b9bec9;
  background: #20232a;
}

.project-tab.active {
  background: #292d36;
  color: #f1f4fa;
  border-color: #414657;
  box-shadow: inset 0 2px #7d9cf9;
}

.project-tab-select, .project-tab-close {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 8px;
  border: 0;
  color: inherit;
  background: transparent;
  font: inherit;
  white-space: nowrap;
  cursor: pointer;
}

.project-tab-select { min-width: 0; flex: 1; }
.project-tab-name { overflow: hidden; text-overflow: ellipsis; }
.project-tab-close { padding-inline: 6px; }
.project-tab-close:hover, .project-tab-select:hover { color: #fff; }
.project-tab-dirty { width: 6px; height: 6px; border-radius: 50%; flex: none; background: #f4b764; }
.project-tab-tasks { padding-inline: 4px; border: 0; border-radius: 5px; background: #3e4b68; color: #dce6ff; cursor: pointer; }
</style>
