<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import type { Project, ProjectMediaItem } from '../../../shared/types';

const props = defineProps<{
  open: boolean;
  projects: Project[];
  currentProject: Project | null;
  busy?: boolean;
}>();

const emit = defineEmits<{
  close: [];
  openProject: [projectId: string];
  createEmpty: [];
  importNew: [];
  appendMedia: [projectId: string];
  relinkMedia: [projectId: string, mediaId: string];
}>();

const selectedProjectId = ref<string | null>(null);

watch(
  () => [props.open, props.currentProject?.id, props.projects.map((item) => item.id).join('|')] as const,
  () => {
    if (!props.open) return;
    selectedProjectId.value =
      props.currentProject?.id ??
      props.projects[0]?.id ??
      null;
  },
  { immediate: true },
);

const selectedProject = computed(
  () => props.projects.find((item) => item.id === selectedProjectId.value) ?? null,
);

function mediaName(media: ProjectMediaItem): string {
  return (
    media.filename?.trim() ||
    media.source.path?.split(/[\\/]/u).at(-1) ||
    media.source.url ||
    `视频 ${media.index}`
  );
}

function countShots(project: Project): string {
  return project.mediaItems.length > 0 ? `${project.mediaItems.length} 个视频` : '空项目';
}
</script>

<template>
  <Teleport to="body">
    <div v-if="open" class="project-center-mask" @click.self="emit('close')">
      <section class="project-center" role="dialog" aria-modal="true" aria-label="项目中心">
        <header>
          <div>
            <h2>项目中心</h2>
            <p>项目可以包含多个视频；镜头、标签、静帧和播放位置按视频隔离。</p>
          </div>
          <button type="button" class="close-btn" aria-label="关闭项目中心" @click="emit('close')">×</button>
        </header>

        <div class="center-body">
          <aside class="project-list">
            <div class="section-title">
              <b>全部项目</b>
              <span>{{ projects.length }}</span>
            </div>
            <button
              v-for="project in projects"
              :key="project.id"
              type="button"
              class="project-row"
              :class="{ active: selectedProjectId === project.id }"
              @click="selectedProjectId = project.id"
            >
              <strong>{{ project.name }}</strong>
              <small>{{ countShots(project) }}</small>
            </button>
            <p v-if="projects.length === 0" class="empty-copy">还没有项目，可以从右侧新建。</p>
          </aside>

          <main class="project-detail">
            <div class="actions">
              <button type="button" :disabled="busy" @click="emit('createEmpty')">新建空项目</button>
              <button type="button" class="primary" :disabled="busy" @click="emit('importNew')">
                导入影片到新项目
              </button>
            </div>

            <template v-if="selectedProject">
              <div class="project-heading">
                <div>
                  <h3>{{ selectedProject.name }}</h3>
                  <small>创建于 {{ new Date(selectedProject.createdAt).toLocaleString('zh-CN') }}</small>
                </div>
                <button
                  type="button"
                  :disabled="busy"
                  @click="emit('openProject', selectedProject.id)"
                >
                  打开项目
                </button>
              </div>

              <div class="section-title media-title">
                <b>项目视频</b>
                <button
                  type="button"
                  :disabled="busy"
                  @click="emit('appendMedia', selectedProject.id)"
                >
                  + 追加视频
                </button>
              </div>

              <div v-if="selectedProject.mediaItems.length > 0" class="media-list">
                <article
                  v-for="media in selectedProject.mediaItems"
                  :key="media.id"
                  class="media-card"
                  :class="{ active: selectedProject.activeMediaId === media.id }"
                >
                  <span class="media-index">V{{ media.index }}</span>
                  <div class="media-copy">
                    <b>{{ mediaName(media) }}</b>
                    <small :title="media.source.path ?? media.source.url ?? ''">
                      {{ media.source.path ?? media.source.url ?? '路径未设置' }}
                    </small>
                    <small>
                      {{ (media.durationMs / 1000).toFixed(1) }} 秒
                      · {{ media.width ?? '?' }}×{{ media.height ?? '?' }}
                      · {{ media.fps ? media.fps.toFixed(2) : '?' }} fps
                    </small>
                  </div>
                  <button
                    type="button"
                    class="relink-btn"
                    :disabled="busy"
                    @click="emit('relinkMedia', selectedProject.id, media.id)"
                  >
                    重定位
                  </button>
                </article>
              </div>
              <p v-else class="empty-copy">
                这是空项目。可以先保存项目，再导入或追加视频。
              </p>
            </template>

            <p v-else class="empty-detail">选择左侧项目查看详情。</p>
          </main>
        </div>
      </section>
    </div>
  </Teleport>
</template>

<style scoped>
.project-center-mask {
  position: fixed;
  inset: 0;
  z-index: 120;
  display: grid;
  place-items: center;
  background: rgba(3, 7, 14, 0.76);
  backdrop-filter: blur(7px);
}

.project-center {
  width: min(980px, calc(100vw - 48px));
  height: min(680px, calc(100vh - 64px));
  overflow: hidden;
  display: flex;
  flex-direction: column;
  border: 1px solid rgba(125, 157, 199, 0.28);
  border-radius: 18px;
  background: #101620;
  color: #e9f0fb;
  box-shadow: 0 24px 80px rgba(0, 0, 0, 0.58);
}

header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 20px;
  padding: 22px 24px 18px;
  border-bottom: 1px solid rgba(148, 163, 184, 0.18);
}

h2,
h3,
p {
  margin: 0;
}

header p {
  margin-top: 7px;
  color: #91a2ba;
  font-size: 13px;
}

.close-btn {
  border: 0;
  background: transparent;
  color: #9fb1c9;
  font-size: 28px;
  cursor: pointer;
}

.center-body {
  min-height: 0;
  flex: 1;
  display: grid;
  grid-template-columns: 280px 1fr;
}

.project-list {
  min-height: 0;
  overflow-y: auto;
  padding: 18px;
  border-right: 1px solid rgba(148, 163, 184, 0.16);
  background: rgba(255, 255, 255, 0.018);
}

.section-title {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  margin-bottom: 12px;
  color: #b8c7da;
  font-size: 12px;
  letter-spacing: 0.04em;
}

.project-row {
  width: 100%;
  display: grid;
  gap: 5px;
  text-align: left;
  padding: 12px;
  margin-bottom: 8px;
  border: 1px solid transparent;
  border-radius: 10px;
  background: transparent;
  color: inherit;
  cursor: pointer;
}

.project-row.active {
  border-color: rgba(90, 162, 255, 0.46);
  background: rgba(90, 162, 255, 0.1);
}

.project-row strong {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.project-row small,
.project-heading small,
.media-copy small {
  color: #8798ae;
}

.project-detail {
  min-width: 0;
  overflow-y: auto;
  padding: 22px 24px;
}

.actions {
  display: flex;
  gap: 10px;
  justify-content: flex-end;
}

.actions button,
.project-heading button,
.media-title button,
.relink-btn {
  padding: 8px 13px;
  border: 1px solid rgba(148, 163, 184, 0.28);
  border-radius: 8px;
  background: rgba(255, 255, 255, 0.035);
  color: inherit;
  cursor: pointer;
}

.actions .primary {
  border-color: #3e8f57;
  background: #2d8747;
}

.project-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 20px;
  padding: 26px 0 18px;
}

.project-heading small {
  display: block;
  margin-top: 7px;
}

.media-title {
  margin-top: 8px;
}

.media-list {
  display: grid;
  gap: 10px;
}

.media-card {
  display: grid;
  grid-template-columns: 44px minmax(0, 1fr) auto;
  align-items: center;
  gap: 12px;
  padding: 13px;
  border: 1px solid rgba(148, 163, 184, 0.18);
  border-radius: 11px;
  background: rgba(255, 255, 255, 0.022);
}

.media-card.active {
  border-color: rgba(90, 162, 255, 0.45);
  background: rgba(90, 162, 255, 0.07);
}

.media-index {
  display: grid;
  place-items: center;
  width: 40px;
  height: 40px;
  border-radius: 9px;
  background: #182437;
  color: #9cc8ff;
  font-weight: 700;
}

.media-copy {
  min-width: 0;
  display: grid;
  gap: 4px;
}

.media-copy small {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.empty-copy,
.empty-detail {
  padding: 22px 0;
  color: #8292a7;
  line-height: 1.7;
}

button:disabled {
  opacity: 0.5;
  cursor: default;
}
</style>
