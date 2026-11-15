<script setup lang="ts">
import { computed } from 'vue';
import type { Project, ProjectMediaItem } from '../../../shared/types';

const props = defineProps<{
  project: Project;
  busy?: boolean;
}>();

const emit = defineEmits<{
  select: [mediaId: string];
  add: [];
  center: [];
}>();

const mediaItems = computed(() => props.project.mediaItems ?? []);

function displayName(media: ProjectMediaItem): string {
  const fromFilename = media.filename?.trim();
  if (fromFilename) return fromFilename;
  const source = media.source.path ?? media.source.url ?? '';
  const fromSource = source.split(/[\\/]/u).at(-1)?.trim();
  return fromSource || `视频 ${media.index}`;
}

function titleOf(media: ProjectMediaItem): string {
  return [
    `V${media.index} · ${displayName(media)}`,
    media.source.path ?? media.source.url ?? '',
    `${(media.durationMs / 1000).toFixed(1)} 秒`,
  ]
    .filter(Boolean)
    .join('\n');
}
</script>

<template>
  <div class="project-media-bar">
    <button type="button" class="media-center-btn" @click="emit('center')">项目中心</button>
    <div class="media-tabs" role="tablist" aria-label="项目视频">
      <button
        v-for="media in mediaItems"
        :key="media.id"
        type="button"
        role="tab"
        class="media-tab"
        :class="{ active: project.activeMediaId === media.id }"
        :aria-selected="project.activeMediaId === media.id"
        :title="titleOf(media)"
        @click="emit('select', media.id)"
      >
        <small>V{{ media.index }}</small>
        <span>{{ displayName(media) }}</span>
      </button>
      <span v-if="mediaItems.length === 0" class="media-empty">当前项目还没有视频</span>
    </div>
    <button type="button" class="media-add-btn" :disabled="busy" @click="emit('add')">
      + 追加视频
    </button>
  </div>
</template>

<style scoped>
.project-media-bar {
  display: flex;
  align-items: center;
  gap: 10px;
  min-height: 38px;
  padding: 5px 12px;
  border-bottom: 1px solid rgba(148, 163, 184, 0.18);
  background: color-mix(in srgb, var(--panel, #111722) 92%, #000 8%);
}

.media-center-btn,
.media-add-btn,
.media-tab {
  border: 1px solid rgba(148, 163, 184, 0.24);
  border-radius: 8px;
  background: rgba(255, 255, 255, 0.035);
  color: var(--text, #e5edf8);
  font: inherit;
}

.media-center-btn,
.media-add-btn {
  flex: 0 0 auto;
  height: 28px;
  padding: 0 10px;
  cursor: pointer;
}

.media-add-btn {
  border-color: rgba(90, 162, 255, 0.45);
  color: #9fc7ff;
}

.media-tabs {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  flex: 1;
  overflow-x: auto;
  scrollbar-width: thin;
}

.media-tab {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  max-width: 230px;
  height: 28px;
  padding: 0 10px 0 7px;
  cursor: pointer;
}

.media-tab small {
  color: #8ea5c5;
  font-size: 10px;
  letter-spacing: 0.04em;
}

.media-tab span {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.media-tab.active {
  border-color: rgba(90, 162, 255, 0.78);
  background: rgba(90, 162, 255, 0.15);
  box-shadow: inset 0 -2px #5aa2ff;
}

.media-empty {
  color: var(--muted, #8493a8);
  font-size: 12px;
}

button:disabled {
  opacity: 0.55;
  cursor: default;
}
</style>
