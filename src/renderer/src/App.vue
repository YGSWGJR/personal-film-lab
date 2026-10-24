<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref } from 'vue';
import AppIcon from './components/AppIcon.vue';
import PlayerWorkspace from './components/PlayerWorkspace.vue';
import ShotDetailPanel from './components/ShotDetailPanel.vue';
import ShotListPanel from './components/ShotListPanel.vue';
import TermEditorModal from './components/TermEditorModal.vue';
import {
  createDemoMarkers,
  createDemoShots,
  createDemoTags,
  createDemoTerms,
  DEFAULT_TAG_GROUPS,
  DEMO_PROJECT,
  DEMO_THUMBNAILS,
} from './data/demo';
import type { SkeletonState } from './env';
import type { BoundaryChange, DetailTerm, TimelineMarker, WorkspaceShot } from './types/workspace';
import type {
  AppInfo,
  IpcResult,
  MediaInfo,
  Note,
  PlayerErrorEvent,
  PlayerState,
  Project,
  RenderBounds,
  Shot,
  Still,
  Tag,
  Term,
} from '../../shared/types';

const info = ref<AppInfo | null>(null);
const bridgeReady = ref(false);
const busy = ref(false);
const savingNote = ref(false);
const activeProject = ref<Project | null>(null);
const demoMode = ref(true);
const leftCollapsed = ref(false);
const rightCollapsed = ref(false);
const demoShots = createDemoShots();
const shots = ref<WorkspaceShot[]>(demoShots);
const markers = ref<TimelineMarker[]>(createDemoMarkers(demoShots));
const selectedId = ref<string | null>(demoShots[2]?.id ?? null);
const previewTimeMs = ref(demoShots[2]?.startMs ?? 0);
const notes = reactive<Record<string, string>>(
  Object.fromEntries(demoShots.map((shot) => [shot.id, shot.remark ?? ''])),
);
const noteIds = reactive<Record<string, string>>({});
const terms = ref<DetailTerm[]>(createDemoTerms());
const tags = ref<Tag[]>(createDemoTags());
const projectStills = ref<Still[]>([]);
const toast = ref<{ title: string; message: string; tone: 'default' | 'error' | 'success' } | null>(null);
let toastTimer: ReturnType<typeof setTimeout> | null = null;
let noteTimer: ReturnType<typeof setTimeout> | null = null;
let pendingNoteShotId: string | null = null;
const termEditorOpen = ref(false);
const editingTerm = ref<Term | null>(null);
const termSaving = ref(false);
const unsubscribers: Array<() => void> = [];

const player = reactive<PlayerState>({
  hasFile: false,
  timeMs: 0,
  durationMs: 0,
  paused: true,
  ended: false,
  volume: 1,
  width: 0,
  height: 0,
  fps: 0,
});

const skeleton: SkeletonState = {
  ready: false,
  title: document.title,
  bridge: false,
  ipcOk: false,
  apiKeys: '',
  info: null,
  error: null,
};
window.__SKELETON_STATE__ = skeleton;

const selectedShot = computed(() => shots.value.find((shot) => shot.id === selectedId.value) ?? null);
const selectedNote = computed(() => (selectedId.value ? notes[selectedId.value] ?? '' : ''));
const selectedStill = computed(() => {
  if (!selectedShot.value) return null;
  return (
    projectStills.value
      .filter((still) => still.shotId === selectedShot.value?.id)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0] ?? null
  );
});
const poster = computed(() =>
  selectedStill.value ? assetUrl(selectedStill.value) : selectedShot.value?.thumbnail ?? DEMO_THUMBNAILS[2],
);
const displayDurationMs = computed(() => {
  if (player.hasFile && player.durationMs > 0) return player.durationMs;
  if (!demoMode.value && activeProject.value?.media.durationMs) return activeProject.value.media.durationMs;
  const lastShotEnd = shots.value.at(-1)?.endMs ?? 0;
  return Math.max(DEMO_PROJECT.durationMs, lastShotEnd);
});
const displayTimeMs = computed(() => (player.hasFile ? player.timeMs : previewTimeMs.value));
const shotListTitle = computed(() => (demoMode.value ? '示例镜头' : activeProject.value?.name ?? '镜头列表'));
const topTimecode = computed(
  () => `${formatReadout(displayTimeMs.value)} / ${formatReadout(displayDurationMs.value)}`,
);
const workbenchColumns = computed(
  () => `${leftCollapsed.value ? 0 : 260}px minmax(480px, 1fr) ${rightCollapsed.value ? 0 : 300}px`,
);

function formatReadout(ms: number): string {
  const totalSeconds = Math.floor(Math.max(0, ms) / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const millis = Math.floor(Math.max(0, ms) % 1000);
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}.${String(millis).padStart(3, '0')}`;
}

function assetUrl(still: Still): string {
  const filePath = still.thumbPath || still.filePath;
  const encodedPath = filePath
    .split(/[\\/]/u)
    .filter(Boolean)
    .map((part) => encodeURIComponent(part))
    .join('/');
  return `lapian-asset://${still.projectId}/${encodedPath}`;
}

function showToast(message: string, tone: 'default' | 'error' | 'success' = 'default', title?: string): void {
  toast.value = {
    title: title ?? (tone === 'error' ? '操作未完成' : tone === 'success' ? '已完成' : '提示'),
    message,
    tone,
  };
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toast.value = null;
  }, 4200);
}

function unwrap<T>(result: IpcResult<T>): T | null {
  if (result.ok) return result.data;
  showToast(result.error.message, 'error', result.error.code);
  return null;
}

function seedDemoNoteMap(items: WorkspaceShot[], loaded: Note[]): void {
  for (const shot of items) {
    const note = loaded.find((item) => item.shotId === shot.id);
    notes[shot.id] = note?.text ?? '';
    if (note) noteIds[shot.id] = note.id;
  }
}

function shotTitleFor(shot: Shot, index: number, sampleProject: boolean): string {
  if (sampleProject) {
    const seed = createDemoShots(shot.projectId);
    return seed[index % seed.length]?.title ?? `镜头 ${shot.index}`;
  }
  if (shot.shotSize) return `${shot.shotSize} · ${String(shot.index).padStart(2, '0')}`;
  return `镜头 ${String(shot.index).padStart(2, '0')}`;
}

function mapShots(project: Project, items: Shot[], stills: Still[]): WorkspaceShot[] {
  const sampleProject = isSampleMedia(project.source.path ?? project.media.filename ?? '');
  const demoSeed = createDemoShots(project.id);
  return items.map((shot, index) => {
    const still = stills.find((item) => item.shotId === shot.id);
    return {
      ...shot,
      thumbnail: sampleProject
        ? demoSeed[index % demoSeed.length]?.thumbnail ?? DEMO_THUMBNAILS[index % DEMO_THUMBNAILS.length]
        : DEMO_THUMBNAILS[index % DEMO_THUMBNAILS.length],
      title: shotTitleFor(shot, index, sampleProject),
      scene: sampleProject ? demoSeed[index % demoSeed.length]?.scene ?? '镜头序列' : `镜头序列 · ${Math.floor(index / 4) + 1}`,
      noteId: noteIds[shot.id],
      remark: shot.remark ?? still?.caption ?? null,
    };
  });
}

function markersFromData(projectShots: WorkspaceShot[], stills: Still[], loadedNotes: Note[]): TimelineMarker[] {
  const items: TimelineMarker[] = [];
  for (const still of stills) {
    const shot = projectShots.find((item) => item.id === still.shotId);
    if (!shot) continue;
    items.push({
      id: `still-${still.id}`,
      shotId: shot.id,
      timeMs: still.timeMs,
      type: 'still',
      label: `镜头 ${String(shot.index).padStart(2, '0')} 静帧`,
    });
  }
  for (const note of loadedNotes) {
    const shot = projectShots.find((item) => item.id === note.shotId);
    if (!shot) continue;
    items.push({
      id: `note-${note.id}`,
      shotId: shot.id,
      timeMs: Math.round((shot.startMs + shot.endMs) / 2),
      type: 'note',
      label: `镜头 ${String(shot.index).padStart(2, '0')} 笔记`,
    });
  }
  return items;
}

async function loadTerms(preferBuiltin = true, persistFallback = false): Promise<void> {
  const loaded = unwrap(await window.api.term.list());
  if (loaded && loaded.length > 0) {
    terms.value = loaded;
  } else if (persistFallback) {
    const defaults = createDemoTerms();
    for (const term of defaults) {
      unwrap(
        await window.api.term.create({
          category: term.category,
          term: term.term,
          definition: term.definition,
          builtin: true,
          sortOrder: term.sortOrder,
        }),
      );
    }
    terms.value = unwrap(await window.api.term.list()) ?? defaults;
  } else if (preferBuiltin) {
    terms.value = createDemoTerms();
  }
}

async function loadTags(): Promise<void> {
  let loaded = unwrap(await window.api.tag.list());
  if (!loaded) return;
  let sortOrder = loaded.reduce((maximum, tag) => Math.max(maximum, tag.sortOrder), 0) + 1;
  let created = false;
  for (const group of DEFAULT_TAG_GROUPS) {
    for (const name of group.items) {
      if (!loaded.some((tag) => tag.category === group.category && tag.name === name)) {
        unwrap(
          await window.api.tag.create({
            category: group.category,
            name,
            builtin: true,
            sortOrder: sortOrder++,
          }),
        );
        created = true;
      }
    }
  }
  if (created) {
    loaded = unwrap(await window.api.tag.list());
  }
  tags.value = loaded ?? createDemoTags();
}

async function loadProject(project: Project): Promise<void> {
  activeProject.value = project;
  demoMode.value = false;
  const [shotResult, stillResult, noteResult] = await Promise.all([
    window.api.shot.list({ projectId: project.id }),
    window.api.still.list({ projectId: project.id }),
    window.api.note.list({ projectId: project.id }),
  ]);
  const loadedShots = unwrap(shotResult);
  const loadedStills = unwrap(stillResult);
  const loadedNotes = unwrap(noteResult);
  if (!loadedShots || !loadedStills || !loadedNotes) return;

  const mapped = mapShots(project, loadedShots, loadedStills);
  shots.value = mapped;
  projectStills.value = loadedStills;
  seedDemoNoteMap(mapped, loadedNotes);
  markers.value = markersFromData(mapped, loadedStills, loadedNotes);
  selectedId.value = mapped[0]?.id ?? null;
  previewTimeMs.value = mapped[0]?.startMs ?? 0;
  await Promise.all([loadTerms(true, true), loadTags()]);
  await assignDefaultSampleTags(project, mapped);

  if (project.source.path && !player.hasFile) {
    await openMediaPath(project.source.path, false);
  }
}

async function assignDefaultSampleTags(project: Project, projectShots: WorkspaceShot[]): Promise<void> {
  if (!isSampleMedia(project.source.path ?? project.media.filename ?? '') || projectShots.length > 250) return;
  const byName = new Map(tags.value.map((tag) => [`${tag.category}:${tag.name}`, tag]));
  for (const shot of projectShots) {
    if (shot.tagIds.length > 0) continue;
    const camera = shot.cameraMethod ?? '固定';
    const cameraTag = camera.includes('推')
      ? '推'
      : camera.includes('拉')
        ? '拉'
        : camera.includes('摇')
          ? '摇'
          : camera.includes('跟') || camera.includes('移')
            ? '跟'
            : '固定';
    const ids = [
      byName.get(`景别:${shot.shotSize ?? '中景'}`)?.id,
      byName.get(`运镜:${cameraTag}`)?.id,
      byName.get('光线:冷光')?.id,
      byName.get('声音:对白')?.id,
      byName.get('剪辑:硬切')?.id,
    ].filter((id): id is string => Boolean(id));
    if (ids.length === 0) continue;
    const result = await window.api.tag.assign({ shotId: shot.id, tagIds: ids });
    if (result.ok) shot.tagIds = result.data.tagIds;
  }
}

function isSampleMedia(path: string): boolean {
  return /sword\s*art\s*online|刀剑神域|kamigami/i.test(path);
}

function cleanProjectName(filePath: string): string {
  const name = filePath.split(/[\\/]/).at(-1) ?? filePath;
  return name.replace(/\.[^.]+$/u, '').replace(/[\[\]]/g, '').trim().slice(0, 120);
}

async function createProjectForMedia(media: MediaInfo): Promise<Project | null> {
  const probe = unwrap(await window.api.media.probe({ path: media.path }));
  const project = unwrap(
    await window.api.project.create({
      name: cleanProjectName(media.path),
      source: { type: 'local', path: media.path },
      media: {
        filename: probe?.filename ?? cleanProjectName(media.path),
        container: probe?.container ?? null,
        durationMs: probe?.durationMs ?? media.durationMs,
        width: probe?.width ?? media.width,
        height: probe?.height ?? media.height,
        fps: probe?.fps ?? media.fps,
        videoCodec: probe?.videoCodec ?? null,
        audioCodec: probe?.audioCodec ?? null,
        sizeBytes: probe?.sizeBytes ?? null,
        proxyPath: null,
      },
    }),
  );
  if (!project) return null;

  if (isSampleMedia(media.path)) {
    const seeds = createDemoShots(project.id);
    const sourceDuration = probe?.durationMs ?? media.durationMs;
    const cycleSpan = seeds.at(-1)?.endMs ?? DEMO_PROJECT.durationMs;
    let shotIndex = 1;
    for (let cycleStart = 0; cycleStart < sourceDuration; cycleStart += cycleSpan) {
      for (const seed of seeds) {
        const startMs = cycleStart + seed.startMs;
        const endMs = Math.min(sourceDuration, cycleStart + seed.endMs);
        if (endMs - startMs < 350) break;
        const created = unwrap(
          await window.api.shot.create({
            projectId: project.id,
            startMs,
            endMs,
            index: shotIndex,
            shotSize: seed.shotSize,
            cameraMethod: seed.cameraMethod,
            dialogue: seed.dialogue,
            remark: seed.remark,
          }),
        );
        if (created && shotIndex % 2 === 1) {
          unwrap(
            await window.api.note.upsert({
              projectId: project.id,
              shotId: created.id,
              text: seed.remark ?? '',
            }),
          );
        }
        shotIndex += 1;
      }
    }
  }

  return project;
}

async function openVideo(): Promise<void> {
  if (busy.value) return;
  busy.value = true;
  try {
    const media = unwrap(await window.api.player.openDialog());
    if (!media) return;
    const project = await createProjectForMedia(media);
    if (project) {
      await loadProject(project);
      showToast('已创建项目并加载影片，可从左侧镜头或时间轴跳转。', 'success');
    }
  } finally {
    busy.value = false;
  }
}

async function openMediaPath(path: string, autoplay: boolean): Promise<void> {
  const state = unwrap(await window.api.player.open({ mediaPath: path }));
  if (!state) return;
  player.hasFile = true;
  Object.assign(player, state);
  if (autoplay) {
    const next = unwrap(await window.api.player.play());
    if (next) Object.assign(player, next);
  }
}

async function togglePlayback(): Promise<void> {
  if (busy.value) return;
  busy.value = true;
  try {
    if (!player.hasFile) {
      const path = activeProject.value?.source.path;
      if (path) {
        await openMediaPath(path, true);
      } else {
        await openVideo();
      }
      return;
    }
    const state = unwrap(await window.api.player.toggle());
    if (state) Object.assign(player, state);
  } finally {
    busy.value = false;
  }
}

async function stepFrame(dir: 1 | -1): Promise<void> {
  if (!player.hasFile || busy.value) return;
  const frame = unwrap(await window.api.player.frameStep({ dir }));
  if (frame) {
    player.timeMs = frame.timeMs;
    previewTimeMs.value = frame.timeMs;
  }
}

async function seekTo(timeMs: number): Promise<void> {
  const bounded = Math.max(0, Math.min(Math.round(timeMs), displayDurationMs.value));
  previewTimeMs.value = bounded;
  if (!player.hasFile) return;
  const state = unwrap(await window.api.player.seek({ timeMs: bounded }));
  if (state) Object.assign(player, state);
}

function selectShot(shot: WorkspaceShot): void {
  selectedId.value = shot.id;
  previewTimeMs.value = shot.startMs;
  if (player.hasFile) void seekTo(shot.startMs);
}

function updateBoundary(change: BoundaryChange): void {
  const shot = shots.value[change.index];
  const next = shots.value[change.index + 1];
  if (!shot || !next) return;
  shot.endMs = change.timeMs;
  shot.durationMs = shot.endMs - shot.startMs;
  next.startMs = change.timeMs;
  next.durationMs = next.endMs - next.startMs;
  previewTimeMs.value = change.timeMs;
}

async function commitBoundary(change: BoundaryChange): Promise<void> {
  if (demoMode.value) {
    showToast(`镜头 ${String(change.index + 1).padStart(2, '0')} 边界已调整。`, 'success');
    return;
  }
  const shot = shots.value[change.index];
  const next = shots.value[change.index + 1];
  if (!shot || !next) return;
  busy.value = true;
  try {
    const [updatedShot, updatedNext] = await Promise.all([
      window.api.shot.update({ id: shot.id, patch: { endMs: change.timeMs } }),
      window.api.shot.update({ id: next.id, patch: { startMs: change.timeMs } }),
    ]);
    if (updatedShot.ok) Object.assign(shot, updatedShot.data);
    if (updatedNext.ok) Object.assign(next, updatedNext.data);
    showToast('镜头边界已保存。', 'success');
  } finally {
    busy.value = false;
  }
}

async function addShotAtPlayhead(): Promise<void> {
  const startMs = Math.min(displayTimeMs.value, Math.max(0, displayDurationMs.value - 1000));
  const endMs = Math.min(displayDurationMs.value, startMs + 4000);
  if (demoMode.value) {
    const created: WorkspaceShot = {
      id: `demo-local-${Date.now()}`,
      projectId: DEMO_PROJECT.id,
      index: shots.value.length + 1,
      startMs,
      endMs,
      durationMs: endMs - startMs,
      shotSize: '中景',
      cameraMethod: '固定',
      dialogue: null,
      remark: '',
      tagIds: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      thumbnail: DEMO_THUMBNAILS[shots.value.length % DEMO_THUMBNAILS.length],
      title: `新镜头 ${String(shots.value.length + 1).padStart(2, '0')}`,
      scene: '手动补充',
    };
    shots.value = [...shots.value, created];
    notes[created.id] = '';
    selectShot(created);
    showToast('示例镜头已添加；打开影片后可保存到项目。');
    return;
  }
  if (!activeProject.value) return;
  const created = unwrap(
    await window.api.shot.create({
      projectId: activeProject.value.id,
      startMs,
      endMs,
      shotSize: '中景',
      cameraMethod: '固定',
    }),
  );
  if (!created) return;
  const mapped: WorkspaceShot = {
    ...created,
    thumbnail: DEMO_THUMBNAILS[shots.value.length % DEMO_THUMBNAILS.length],
    title: `镜头 ${String(created.index).padStart(2, '0')}`,
    scene: `镜头序列 · ${Math.floor((created.index - 1) / 4) + 1}`,
  };
  shots.value = [...shots.value, mapped].sort((a, b) => a.startMs - b.startMs);
  notes[mapped.id] = '';
  selectShot(mapped);
  showToast('已在当前时码新建镜头。', 'success');
}

async function updateShotLanguage(patch: { shotSize?: string; cameraMethod?: string }): Promise<void> {
  const shot = selectedShot.value;
  if (!shot) return;
  Object.assign(shot, patch);
  if (demoMode.value) return;
  const result = await window.api.shot.update({ id: shot.id, patch });
  if (result.ok) Object.assign(shot, result.data);
}

async function toggleTag(tag: Tag): Promise<void> {
  const shot = selectedShot.value;
  if (!shot) return;
  const assigned = shot.tagIds.includes(tag.id);
  const exclusive = tag.category === '景别' || tag.category === '运镜';
  const siblingIds = exclusive
    ? shot.tagIds.filter((id) => tags.value.find((item) => item.id === id)?.category === tag.category)
    : [];
  const baseIds = shot.tagIds.filter((id) => !siblingIds.includes(id));
  const nextIds = assigned ? baseIds : [...baseIds, tag.id];

  if (demoMode.value) {
    Object.assign(shot, { tagIds: nextIds });
  } else {
    const idsToRemove = assigned ? [tag.id] : siblingIds;
    if (idsToRemove.length > 0) {
      const unassigned = await window.api.tag.unassign({ shotId: shot.id, tagIds: idsToRemove });
      if (!unassigned.ok) {
        showToast(unassigned.error.message, 'error', unassigned.error.code);
        return;
      }
      if (assigned) Object.assign(shot, { tagIds: unassigned.data.tagIds });
    }
    if (!assigned) {
      const result = await window.api.tag.assign({ shotId: shot.id, tagIds: [tag.id] });
      if (!result.ok) {
        showToast(result.error.message, 'error', result.error.code);
        return;
      }
      Object.assign(shot, { tagIds: result.data.tagIds });
    }
  }

  if (!assigned && tag.category === '景别') await updateShotLanguage({ shotSize: tag.name });
  if (!assigned && tag.category === '运镜') await updateShotLanguage({ cameraMethod: tag.name });
}

async function createCustomTag(value: { category: string; name: string }): Promise<void> {
  const sortOrder = tags.value.reduce((maximum, tag) => Math.max(maximum, tag.sortOrder), 0) + 1;
  if (demoMode.value) {
    const tag: Tag = {
      id: `demo-tag-custom-${Date.now()}`,
      category: value.category,
      name: value.name,
      color: null,
      builtin: false,
      sortOrder,
      createdAt: new Date().toISOString(),
    };
    tags.value = [...tags.value, tag];
    await toggleTag(tag);
    showToast(`已添加“${value.name}”并应用到当前镜头。`, 'success');
    return;
  }

  const created = unwrap(
    await window.api.tag.create({
      category: value.category,
      name: value.name,
      builtin: false,
      sortOrder,
    }),
  );
  if (!created) return;
  tags.value = [...tags.value, created];
  await toggleTag(created);
  showToast(`已添加“${value.name}”并应用到当前镜头。`, 'success');
}

function openNewTerm(): void {
  editingTerm.value = null;
  termEditorOpen.value = true;
}

function openEditTerm(term: DetailTerm): void {
  editingTerm.value = term;
  termEditorOpen.value = true;
}

async function saveTerm(value: { term: string; definition: string; category: string }): Promise<void> {
  const isEditing = Boolean(editingTerm.value);
  termSaving.value = true;
  try {
    const result = editingTerm.value
      ? await window.api.term.update({
          id: editingTerm.value.id,
          patch: value,
        })
      : await window.api.term.create(value);
    if (!result.ok) {
      showToast(result.error.message, 'error', result.error.code);
      return;
    }
    await loadTerms();
    termEditorOpen.value = false;
    editingTerm.value = null;
    showToast(isEditing ? '术语已更新。' : '术语已创建。', 'success');
  } finally {
    termSaving.value = false;
  }
}

async function deleteTerm(id: string): Promise<void> {
  if (!window.confirm('确定删除这条术语吗？')) return;
  termSaving.value = true;
  try {
    const result = await window.api.term.delete({ id });
    if (!result.ok) {
      showToast(result.error.message, 'error', result.error.code);
      return;
    }
    await loadTerms();
    termEditorOpen.value = false;
    editingTerm.value = null;
    showToast('术语已删除。', 'success');
  } finally {
    termSaving.value = false;
  }
}

async function importTerms(): Promise<void> {
  const result = unwrap(await window.api.term.importJson());
  if (!result || result.canceled) return;
  await loadTerms();
  showToast(`导入完成：新增 ${result.imported} 条，跳过 ${result.skipped} 条。`, 'success');
}

async function exportTerms(): Promise<void> {
  const result = unwrap(await window.api.term.exportJson());
  if (!result || result.canceled) return;
  showToast(`已导出 ${result.count} 条术语：${result.path}`, 'success');
}

function updateNote(value: string): void {
  if (!selectedId.value) return;
  notes[selectedId.value] = value;
  pendingNoteShotId = selectedId.value;
  if (noteTimer) clearTimeout(noteTimer);
  noteTimer = setTimeout(() => {
    const shotId = pendingNoteShotId;
    noteTimer = null;
    pendingNoteShotId = null;
    if (shotId) void saveNoteForShot(shotId, false);
  }, 800);
}

async function saveCurrentNote(showConfirmation = true): Promise<void> {
  if (noteTimer) {
    clearTimeout(noteTimer);
    noteTimer = null;
  }
  const shot = selectedShot.value;
  pendingNoteShotId = null;
  if (!shot) return;
  await saveNoteForShot(shot.id, showConfirmation);
}

async function saveNoteForShot(shotId: string, showConfirmation: boolean): Promise<void> {
  const shot = shots.value.find((item) => item.id === shotId);
  if (!shot || demoMode.value || !activeProject.value) {
    if (showConfirmation) showToast('示例笔记已保存在当前会话。');
    return;
  }
  const text = notes[shot.id] ?? '';
  savingNote.value = true;
  try {
    const saved = unwrap(
      await window.api.note.upsert({
        id: noteIds[shot.id],
        projectId: activeProject.value.id,
        shotId: shot.id,
        text,
      }),
    );
    if (saved) {
      noteIds[shot.id] = saved.id;
      markerUpdatesFromNote(shot, saved);
      if (showConfirmation) showToast('镜头笔记已保存。', 'success');
    }
  } finally {
    savingNote.value = false;
  }
}

function markerUpdatesFromNote(shot: WorkspaceShot, note: Note): void {
  const markerId = `note-${note.id}`;
  const exists = markers.value.some((marker) => marker.id === markerId);
  if (exists) return;
  markers.value = [
    ...markers.value,
    {
      id: markerId,
      shotId: shot.id,
      timeMs: Math.round((shot.startMs + shot.endMs) / 2),
      type: 'note',
      label: `镜头 ${String(shot.index).padStart(2, '0')} 笔记`,
    },
  ];
}

function insertTerm(term: DetailTerm): void {
  const current = selectedNote.value.trimEnd();
  const addition = `${current ? '\n\n' : ''}【${term.category} · ${term.term}】${term.definition}`;
  updateNote(`${current}${addition}`);
  showToast(`“${term.term}”已插入当前笔记。`, 'success');
}

async function captureStill(): Promise<void> {
  const shot = selectedShot.value;
  if (!shot) return;
  if (
    demoMode.value ||
    !activeProject.value ||
    (!activeProject.value.source.path && !activeProject.value.media.proxyPath)
  ) {
    showToast('打开本地影片后，才能把当前帧保存进项目。');
    return;
  }
  busy.value = true;
  try {
    let timeMs = displayTimeMs.value;
    if (player.hasFile) {
      const frame = unwrap(await window.api.player.getFrame());
      if (frame) timeMs = frame.timeMs;
    }
    const result = unwrap(
      await window.api.still.capture({
        projectId: activeProject.value.id,
        shotId: shot.id,
        timeMs,
        caption: shot.title,
      }),
    );
    if (result) {
      upsertStill(result);
      showToast('当前帧已保存为 PNG，并生成 JPEG 缩略图。', 'success');
    }
  } finally {
    busy.value = false;
  }
}

function upsertStill(still: Still): void {
  const next = projectStills.value.filter((item) => item.id !== still.id);
  next.push(still);
  projectStills.value = next;
  if (markers.value.some((marker) => marker.id === `still-${still.id}`)) return;
  const shot = shots.value.find((item) => item.id === still.shotId);
  if (!shot) return;
  markers.value = [
    ...markers.value,
    {
      id: `still-${still.id}`,
      shotId: shot.id,
      timeMs: still.timeMs,
      type: 'still',
      label: `镜头 ${String(shot.index).padStart(2, '0')} 静帧`,
    },
  ];
}

async function saveAnnotations(annotations: Still['annotations']): Promise<void> {
  const still = selectedStill.value;
  if (!still) return;
  const result = await window.api.still.setAnnotation({
    id: still.id,
    annotations: annotations.slice(-500),
  });
  if (!result.ok) {
    showToast(result.error.message, 'error', result.error.code);
    return;
  }
  upsertStill(result.data);
}

async function saveProject(): Promise<void> {
  if (!activeProject.value) {
    showToast('示例项目无需保存；打开影片后会自动创建可保存的本地项目。');
    return;
  }
  busy.value = true;
  try {
    const result = unwrap(await window.api.project.save({ id: activeProject.value.id }));
    if (result) showToast(`项目已打包：${result.path}`, 'success');
  } finally {
    busy.value = false;
  }
}

function openSmartCut(): void {
  showToast('检测服务尚未接入；当前可直接拖动橙色镜头边界完成手动校准。');
}

function setPlayerBounds(bounds: RenderBounds): void {
  void window.api.player.setBounds(bounds);
}

function handleKeydown(event: KeyboardEvent): void {
  const tagName = (event.target as HTMLElement | null)?.tagName;
  if (tagName === 'INPUT' || tagName === 'TEXTAREA' || tagName === 'SELECT') return;

  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
    event.preventDefault();
    void saveCurrentNote();
    return;
  }
  if (event.code === 'Space') {
    event.preventDefault();
    void togglePlayback();
    return;
  }
  if (event.key.toLowerCase() === 's' && !event.ctrlKey && !event.metaKey) {
    event.preventDefault();
    void captureStill();
    return;
  }
  if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
    if (shots.value.length === 0) return;
    event.preventDefault();
    const currentIndex = Math.max(0, shots.value.findIndex((shot) => shot.id === selectedId.value));
    const delta = event.key === 'ArrowDown' ? 1 : -1;
    const nextIndex = Math.max(0, Math.min(shots.value.length - 1, currentIndex + delta));
    const nextShot = shots.value[nextIndex];
    if (nextShot) {
      selectedId.value = nextShot.id;
      previewTimeMs.value = nextShot.startMs;
    }
    return;
  }
  if (event.key === 'Enter' && selectedShot.value) {
    event.preventDefault();
    void seekTo(selectedShot.value.startMs);
    return;
  }
  if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
    event.preventDefault();
    const dir: 1 | -1 = event.key === 'ArrowLeft' ? -1 : 1;
    if (event.shiftKey) void seekTo(displayTimeMs.value + dir * 1000);
    else void stepFrame(dir);
  }
}

onMounted(async () => {
  const api = window.api;
  bridgeReady.value = Boolean(api?.app && api?.player && api?.project);
  skeleton.bridge = bridgeReady.value;
  skeleton.apiKeys = api ? Object.keys(api).sort().join(',') : '';

  if (!api?.app?.getInfo) {
    skeleton.error = 'window.api 不存在：preload 白名单桥未生效';
    skeleton.ready = true;
    showToast(skeleton.error, 'error');
    return;
  }

  try {
    const result = await api.app.getInfo();
    if (!result.ok) throw new Error(result.error.message);
    info.value = result.data;
    skeleton.info = result.data;
    skeleton.ipcOk = true;
  } catch (error) {
    skeleton.error = error instanceof Error ? error.message : String(error);
    showToast(skeleton.error, 'error');
  } finally {
    skeleton.ready = true;
  }

  try {
    const projectResult = await api.project.list();
    if (projectResult.ok && projectResult.data.length > 0) {
      await loadProject(projectResult.data[0]);
    } else {
      await loadTerms();
    }
  } catch (error) {
    showToast(error instanceof Error ? error.message : String(error), 'error');
  }

  unsubscribers.push(
    api.player.onState((state) => Object.assign(player, state)),
    api.player.onTime((event) => {
      player.timeMs = event.timeMs;
      previewTimeMs.value = event.timeMs;
      const active = shots.value.find(
        (shot) => event.timeMs >= shot.startMs && event.timeMs < shot.endMs,
      );
      if (active && active.id !== selectedId.value) selectedId.value = active.id;
    }),
    api.player.onLoaded((media: MediaInfo) => {
      player.hasFile = true;
      player.durationMs = media.durationMs;
      player.width = media.width;
      player.height = media.height;
      player.fps = media.fps;
    }),
    api.player.onError((event: PlayerErrorEvent) => showToast(event.message, 'error', event.code)),
    api.still.onCreated((still) => upsertStill(still)),
  );

  await nextTick();
  window.addEventListener('keydown', handleKeydown);
});

onBeforeUnmount(() => {
  for (const unsubscribe of unsubscribers) unsubscribe();
  unsubscribers.length = 0;
  window.removeEventListener('keydown', handleKeydown);
  if (toastTimer) clearTimeout(toastTimer);
  if (noteTimer) clearTimeout(noteTimer);
});
</script>

<template>
  <div class="app-shell">
    <header class="topbar">
      <div class="brand">
        <div class="brand-mark" aria-hidden="true">
          <span></span><span></span><span></span>
        </div>
        <div class="brand-copy">
          <strong>个人拉片工作台</strong>
        </div>
      </div>

      <nav class="main-nav" aria-label="主导航">
        <button class="nav-item primary" type="button" :disabled="busy" @click="openVideo">
          <AppIcon name="folder" :size="16" />
          导入影片
        </button>
        <button class="nav-item primary" type="button" @click="openSmartCut">
          <AppIcon name="scissors" :size="16" />
          镜头切分
        </button>
        <button class="nav-item" type="button" @click="captureStill">
          <AppIcon name="camera" :size="16" />
          静帧截图
          <kbd>S</kbd>
        </button>
        <button class="nav-item" type="button">导出分镜本</button>
      </nav>

      <div class="topbar-right">
        <span class="project-clock">{{ topTimecode }}</span>
        <span class="topbar-divider"></span>
        <button
          class="nav-item icon-only"
          type="button"
          :title="leftCollapsed ? '展开镜头列表' : '收起镜头列表'"
          @click="leftCollapsed = !leftCollapsed"
        >
          <AppIcon name="panel-left" :size="16" />
        </button>
        <button
          class="nav-item icon-only"
          type="button"
          :title="rightCollapsed ? '展开镜头详情' : '收起镜头详情'"
          @click="rightCollapsed = !rightCollapsed"
        >
          <AppIcon name="panel-right" :size="16" />
        </button>
        <button class="nav-item icon-only" type="button" title="保存项目" @click="saveProject">
          <AppIcon name="save" :size="16" />
        </button>
        <button class="nav-item icon-only" type="button" title="学习统计">
          <AppIcon name="chart" :size="16" />
        </button>
        <button class="nav-item icon-only" type="button" title="设置">
          <AppIcon name="settings" :size="16" />
        </button>
      </div>
    </header>

    <div class="workbench" :style="{ gridTemplateColumns: workbenchColumns }">
      <ShotListPanel
        :shots="shots"
        :selected-id="selectedId"
        :current-time-ms="displayTimeMs"
        @select="selectShot"
        @add-shot="addShotAtPlayhead"
        @detect="openSmartCut"
        @collapse="leftCollapsed = true"
      />

      <PlayerWorkspace
        :player="player"
        :shots="shots"
        :markers="markers"
        :selected-shot="selectedShot"
        :poster="poster"
        :display-duration-ms="displayDurationMs"
        :display-time-ms="displayTimeMs"
        :busy="busy"
        @open="openVideo"
        @toggle="togglePlayback"
        @step="stepFrame"
        @seek="seekTo"
        @select-shot="selectShot"
        @boundary-change="updateBoundary"
        @boundary-commit="commitBoundary"
        @bounds="setPlayerBounds"
        @capture="captureStill"
        @collapse="rightCollapsed = true"
      />

      <ShotDetailPanel
        :shot="selectedShot"
        :note="selectedNote"
        :terms="terms"
        :tags="tags"
        :still="selectedStill"
        :thumbnail="poster"
        :saving="savingNote"
        :demo-mode="demoMode"
        @update-note="updateNote"
        @insert-term="insertTerm"
        @toggle-tag="toggleTag"
        @create-tag="createCustomTag"
        @create-term="openNewTerm"
        @edit-term="openEditTerm"
        @import-terms="importTerms"
        @export-terms="exportTerms"
        @set-annotations="saveAnnotations"
        @save-note="saveCurrentNote()"
        @capture="captureStill"
      />
    </div>

    <footer class="statusbar">
      <div class="status-group">
        <span class="status-ready"><i></i>工程就绪</span>
        <span>{{ shotListTitle }}</span>
        <span class="status-separator"></span>
        <span>{{ shots.length }} 个镜头</span>
        <span>{{ markers.length }} 条标注</span>
      </div>
      <div class="status-group status-right">
        <span>{{ player.hasFile ? `${player.width}×${player.height} · ${player.fps.toFixed(3)} fps` : 'LOCAL WORKSPACE' }}</span>
        <span class="status-separator"></span>
        <span class="status-connection"><i></i>libmpv ready</span>
        <span class="status-separator"></span>
        <span>v{{ info?.version ?? '0.1.0' }}</span>
      </div>
    </footer>

    <TermEditorModal
      :open="termEditorOpen"
      :term="editingTerm"
      :saving="termSaving"
      @close="termEditorOpen = false"
      @save="saveTerm"
      @delete="deleteTerm"
    />

    <transition name="toast">
      <div v-if="toast" class="toast" :class="toast.tone">
        <span class="toast-icon">
          <AppIcon :name="toast.tone === 'error' ? 'more' : 'check'" :size="14" />
        </span>
        <span class="toast-copy">
          <strong>{{ toast.title }}</strong>
          <span>{{ toast.message }}</span>
        </span>
        <button type="button" aria-label="关闭提示" @click="toast = null">×</button>
      </div>
    </transition>
  </div>
</template>
