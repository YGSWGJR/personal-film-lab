<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue';
import emptyProjectImage from '../../../assets/design/design_empty_project_1024x768.png';
import emptyShotsImage from '../../../assets/design/design_empty_shots_1024x768.png';
import emptyStillsImage from '../../../assets/design/design_empty_stills_1024x768.png';
import cutIcon from '../../../assets/design/design_icon_cut_48.png';
import AppIcon from './components/AppIcon.vue';
import DetectionModal from './components/DetectionModal.vue';
import ExportModal from './components/ExportModal.vue';
import PlayerWorkspace from './components/PlayerWorkspace.vue';
import SettingsModal from './components/SettingsModal.vue';
import StatsModal from './components/StatsModal.vue';
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
  AudioWaveform,
  CandidateProject,
  CandidateSource,
  DetectEnvCheck,
  DetectProgressEvent,
  DetectResult,
  ExportProgressEvent,
  IpcResult,
  MediaInfo,
  MediaProgressEvent,
  Note,
  OverlayLayer,
  PlayerErrorEvent,
  PlayerState,
  Project,
  RenderBounds,
  Settings,
  SettingsSetArgs,
  Shot,
  Still,
  StoryboardExportArgs,
  Tag,
  Term,
  WorkspaceState,
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
const exportOpen = ref(false);
const exporting = ref(false);
const exportProgress = ref<ExportProgressEvent | null>(null);
const transcoding = ref(false);
const transcodeProgress = ref<MediaProgressEvent | null>(null);
const detectionOpen = ref(false);
const detecting = ref(false);
const applyingDetection = ref(false);
const detectionProgress = ref<DetectProgressEvent | null>(null);
const detectionResult = ref<DetectResult | null>(null);
const detectionError = ref<string | null>(null);
const detectionJobId = ref<string | null>(null);
const importWizardOpen = ref(false);
const importWizardMode = ref<'startup' | 'session'>('startup');
const importWizardItems = ref<Array<CandidateProject & { root: string; key: string }>>([]);
const importWizardSelected = ref<string[]>([]);
const importWizardBusy = ref(false);
const importWizardError = ref<string | null>(null);
const missingSessionProjectId = ref<string | null>(null);
const loadedPlaybackPath = ref<string | null>(null);
const audioWaveform = ref<AudioWaveform | null>(null);
const audioLoading = ref(false);
const settingsOpen = ref(false);
const settings = ref<Settings | null>(null);
const settingsSaving = ref(false);
const settingsError = ref<string | null>(null);
const statsOpen = ref(false);
const shotScrollTop = ref(0);
let detectionPollTimer: ReturnType<typeof setInterval> | null = null;
let audioGeneration = 0;
let lastPlayerBounds: RenderBounds | null = null;
let sessionSaveTimer: ReturnType<typeof setTimeout> | null = null;
let restoringSession = true;
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
  layer: 'normal',
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
      .sort((left, right) => {
        if (left.role !== right.role) return left.role === 'main' ? -1 : 1;
        return right.createdAt.localeCompare(left.createdAt);
      })[0] ?? null
  );
});
const videoPoster = computed(() => {
  if (selectedShot.value?.thumbnail) return selectedShot.value.thumbnail;
  if (demoMode.value) return DEMO_THUMBNAILS[2];
  return activeProject.value ? emptyShotsImage : emptyProjectImage;
});
const detailPoster = computed(() => {
  if (selectedStill.value) return assetUrl(selectedStill.value);
  if (selectedShot.value && demoMode.value) return selectedShot.value.thumbnail;
  return emptyStillsImage;
});
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

function mapShots(items: Shot[], stills: Still[]): WorkspaceShot[] {
  return items.map((shot, index) => {
    const shotStills = stills.filter((item) => item.shotId === shot.id);
    const thumbnailStill =
      shotStills.find((item) => item.role === 'auto-thumb' && item.thumbPath) ??
      shotStills.find((item) => Boolean(item.thumbPath));
    const still = shotStills.find((item) => item.role === 'main') ?? shotStills[0];
    return {
      ...shot,
      thumbnail: thumbnailStill ? assetUrl(thumbnailStill) : emptyShotsImage,
      title: shot.shotSize
        ? `${shot.shotSize} · ${String(shot.index).padStart(2, '0')}`
        : `镜头 ${String(shot.index).padStart(2, '0')}`,
      scene: `镜头序列 · ${Math.floor(index / 8) + 1}`,
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

function resetAudioWaveform(): void {
  audioGeneration += 1;
  audioWaveform.value = null;
  audioLoading.value = false;
}

function prepareAudioWaveform(project: Project): void {
  resetAudioWaveform();
  const path = project.source.path || project.media.proxyPath;
  if (!path) return;
  void loadAudioWaveform(path, audioGeneration);
}

async function loadAudioWaveform(path: string, generation: number): Promise<void> {
  audioLoading.value = true;
  try {
    const result = await window.api.scope.extractAudioWaveform({ path, bucketMs: 100 });
    if (generation !== audioGeneration) return;
    if (!result.ok) {
      console.warn(`[scope] 音频波形提取失败：${result.error.code} ${result.error.message}`);
      return;
    }
    audioWaveform.value = result.data;
  } catch (error) {
    if (generation === audioGeneration) {
      console.warn('[scope] 音频波形提取异常', error);
    }
  } finally {
    if (generation === audioGeneration) audioLoading.value = false;
  }
}

async function loadProject(
  project: Project,
  restoreState: WorkspaceState | null = null,
): Promise<void> {
  const projectChanged = activeProject.value?.id !== project.id;
  activeProject.value = project;
  demoMode.value = false;
  if (projectChanged) prepareAudioWaveform(project);
  const [shotResult, stillResult, noteResult] = await Promise.all([
    window.api.shot.list({ projectId: project.id }),
    window.api.still.list({ projectId: project.id }),
    window.api.note.list({ projectId: project.id }),
  ]);
  const loadedShots = unwrap(shotResult);
  const loadedStills = unwrap(stillResult);
  const loadedNotes = unwrap(noteResult);
  if (!loadedShots || !loadedStills || !loadedNotes) return;

  const mapped = mapShots(loadedShots, loadedStills);
  shots.value = mapped;
  projectStills.value = loadedStills;
  seedDemoNoteMap(mapped, loadedNotes);
  markers.value = markersFromData(mapped, loadedStills, loadedNotes);
  const restoredShot = restoreState
    ? mapped.find((shot) => shot.id === restoreState.selectedShotId) ?? null
    : null;
  selectedId.value = restoredShot?.id ?? mapped[0]?.id ?? null;
  previewTimeMs.value = restoreState?.timeMs ?? mapped[0]?.startMs ?? 0;
  await Promise.all([loadTerms(true, true), loadTags()]);

  const playbackCandidates = [project.media.proxyPath, project.source.path]
    .filter((path): path is string => Boolean(path))
    .filter((path, index, paths) => paths.findIndex((item) => samePath(item, path)) === index);
  let playbackReady = false;
  for (const [index, path] of playbackCandidates.entries()) {
    if (player.hasFile && samePath(loadedPlaybackPath.value, path)) {
      playbackReady = true;
      break;
    }
    if (await openMediaPath(path, false, false)) {
      if (index > 0) showToast('代理文件不可用，已切换为源文件播放。');
      playbackReady = true;
      break;
    }
  }
  if (!playbackReady && playbackCandidates.length > 0) {
    await closePlayer();
    showToast('项目媒体文件无法打开，请检查文件是否已移动。', 'error', '播放器打开失败');
  } else if (player.hasFile) {
    if (playbackCandidates.length === 0) await closePlayer();
  }
  if (restoreState && playbackReady) {
    await restorePlaybackState(restoreState);
  }
}

function samePath(left: string | null, right: string): boolean {
  if (!left) return false;
  return left.replaceAll('\\', '/').toLowerCase() === right.replaceAll('\\', '/').toLowerCase();
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

  return project;
}

async function openVideo(): Promise<void> {
  if (busy.value) return;
  busy.value = true;
  try {
    const media = unwrap(await window.api.player.openDialog());
    if (!media) return;
    loadedPlaybackPath.value = media.path;
    const project = await createProjectForMedia(media);
    if (project) {
      let targetProject = project;
      let usedProxy = false;
      transcoding.value = true;
      transcodeProgress.value = {
        jobId: '',
        stage: 'transcode',
        percent: 0,
        message: '正在生成 720p 代理',
      };
      const proxy = unwrap(
        await window.api.media.transcodeProxy({
          sourcePath: media.path,
          maxHeight: 720,
          crf: 26,
        }),
      );
      if (proxy) {
        const updated = unwrap(
          await window.api.project.update({
            id: project.id,
            patch: { media: { proxyPath: proxy.outputPath } },
          }),
        );
        if (updated) {
          targetProject = updated;
          usedProxy = true;
        }
      }
      await loadProject(targetProject);
      showToast(
        usedProxy
          ? '影片导入完成，可开始镜头检测或手动打点。'
          : '代理转码失败，当前直接使用源文件；仍可继续拉片。',
        usedProxy ? 'success' : 'error',
      );
    }
  } finally {
    transcoding.value = false;
    transcodeProgress.value = null;
    busy.value = false;
  }
}

async function openMediaPath(path: string, autoplay: boolean, reportError = true): Promise<boolean> {
  try {
    const result = await window.api.player.open({ mediaPath: path });
    if (!result.ok) {
      if (reportError) showToast(result.error.message, 'error', result.error.code);
      return false;
    }
    loadedPlaybackPath.value = path;
    player.hasFile = true;
    Object.assign(player, result.data);
    if (autoplay) {
      const next = unwrap(await window.api.player.play());
      if (next) Object.assign(player, next);
    }
    return true;
  } catch (error) {
    if (reportError) showToast(error instanceof Error ? error.message : String(error), 'error', '播放器打开失败');
    return false;
  }
}

async function closePlayer(): Promise<void> {
  await window.api.player.close();
  loadedPlaybackPath.value = null;
  Object.assign(player, {
    hasFile: false,
    timeMs: 0,
    durationMs: 0,
    paused: true,
    ended: false,
    width: 0,
    height: 0,
    fps: 0,
    layer: 'normal',
  });
}

async function togglePlayback(): Promise<void> {
  if (busy.value) return;
  busy.value = true;
  try {
    if (!player.hasFile) {
      const path = activeProject.value?.media.proxyPath || activeProject.value?.source.path;
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
    if (!updatedShot.ok || !updatedNext.ok) {
      const failure = !updatedShot.ok ? updatedShot.error : !updatedNext.ok ? updatedNext.error : null;
      showToast(failure?.message ?? '镜头边界保存失败', 'error', failure?.code);
      if (activeProject.value) await loadProject(activeProject.value);
      return;
    }
    Object.assign(shot, updatedShot.data);
    Object.assign(next, updatedNext.data);
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
      origin: 'manual',
      locked: false,
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
  const previous = { shotSize: shot.shotSize, cameraMethod: shot.cameraMethod };
  Object.assign(shot, patch);
  if (demoMode.value) return;
  const result = await window.api.shot.update({ id: shot.id, patch });
  if (result.ok) {
    Object.assign(shot, result.data);
  } else {
    Object.assign(shot, previous);
    showToast(result.error.message, 'error', result.error.code);
  }
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

function openExport(): void {
  if (demoMode.value || !activeProject.value) {
    showToast('请先打开一个本地影片项目，再导出分镜本。');
    return;
  }
  if (shots.value.length === 0) {
    showToast('当前项目还没有镜头，请先运行镜头检测或手动打点。');
    return;
  }
  exportProgress.value = null;
  exportOpen.value = true;
}

async function runStoryboardExport(args: Omit<StoryboardExportArgs, 'projectId'>): Promise<void> {
  if (!activeProject.value || exporting.value) return;
  exporting.value = true;
  exportProgress.value = {
    jobId: '',
    percent: 0,
    stage: 'prepare',
    message: '正在准备分镜本',
  };
  try {
    const result = unwrap(
      await window.api.export.storyboard({
        ...args,
        projectId: activeProject.value.id,
      }),
    );
    if (result && !result.canceled) {
      exportOpen.value = false;
      showToast(`分镜本已导出：${result.filePath}`, 'success');
    }
  } finally {
    exporting.value = false;
    exportProgress.value = null;
  }
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
  if (!shot) {
    showToast('请先选择一个镜头，再截取静帧。');
    return;
  }
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

function stopDetectionPolling(): void {
  if (!detectionPollTimer) return;
  clearInterval(detectionPollTimer);
  detectionPollTimer = null;
}

async function openDetection(): Promise<void> {
  if (busy.value || transcoding.value) return;
  if (demoMode.value || !activeProject.value) {
    showToast('请先导入本地影片，再运行镜头检测。');
    return;
  }
  let environment: IpcResult<DetectEnvCheck>;
  try {
    environment = await window.api.detect.checkEnv();
  } catch (error) {
    showToast(error instanceof Error ? error.message : String(error), 'error', '检测环境检查失败');
    return;
  }
  if (!environment.ok) {
    showToast(environment.error.message, 'error', environment.error.code);
    return;
  }
  if (!environment.data.ok && environment.data.error) {
    detectionError.value = `${environment.data.error.message}。${environment.data.error.guide}`;
    detectionProgress.value = null;
    detectionResult.value = null;
    detecting.value = false;
    detectionOpen.value = true;
    return;
  }
  detectionError.value = null;
  detectionOpen.value = true;
  void startDetection();
}

function showUrlImportPending(): void {
  showToast('B 站 / YouTube 链接导入将在后续版本接入，当前请使用本地文件。');
}

function openImportWizard(mode: 'startup' | 'session', sources: CandidateSource[]): void {
  importWizardMode.value = mode;
  importWizardItems.value = sources.flatMap((source) =>
    source.projects.map((project) => ({
      ...project,
      root: source.root,
      key: `${source.root}::${project.id}`,
    })),
  );
  importWizardSelected.value =
    mode === 'session'
      ? importWizardItems.value
          .filter((item) => item.id === missingSessionProjectId.value)
          .map((item) => item.key)
      : [];
  importWizardBusy.value = false;
  importWizardError.value = null;
  importWizardOpen.value = true;
}

async function scanStartupCandidates(): Promise<void> {
  const result = await window.api.data.scanCandidates();
  if (!result.ok) {
    console.warn(`[data-import] ${result.error.code} ${result.error.message}`);
    return;
  }
  if (result.data.some((source) => source.projects.length > 0)) {
    openImportWizard('startup', result.data);
  }
}

async function handleMissingSessionProject(projectId: string | null): Promise<void> {
  missingSessionProjectId.value = projectId;
  leftCollapsed.value = false;
  rightCollapsed.value = false;
  shotScrollTop.value = 0;
  enterDemoWorkspace();

  const result = await window.api.data.scanCandidates();
  if (!result.ok) {
    console.warn(`[data-import] ${result.error.code} ${result.error.message}`);
    openImportWizard('session', []);
    importWizardError.value = `无法扫描其他数据目录：${result.error.message}`;
    return;
  }
  openImportWizard('session', result.data);
}

function toggleImportCandidate(key: string): void {
  importWizardSelected.value = importWizardSelected.value.includes(key)
    ? importWizardSelected.value.filter((item) => item !== key)
    : [...importWizardSelected.value, key];
}

async function importCandidates(importAll: boolean): Promise<void> {
  if (importWizardBusy.value) return;
  const selected = importAll
    ? importWizardItems.value
    : importWizardItems.value.filter((item) => importWizardSelected.value.includes(item.key));
  if (selected.length === 0) {
    importWizardError.value = '请至少选择一个项目';
    return;
  }

  importWizardBusy.value = true;
  importWizardError.value = null;
  const imported: Project[] = [];
  const failures: string[] = [];
  try {
    for (const item of selected) {
      const result = await window.api.data.importProject({ root: item.root, projectId: item.id });
      if (result.ok) imported.push(result.data.project);
      else failures.push(`${item.name}：${result.error.message}`);
    }
    if (imported.length === 0) {
      importWizardError.value = failures.join('\n') || '没有可导入的项目';
      return;
    }
    importWizardOpen.value = false;
    const projects = unwrap(await window.api.project.list());
    const preferred =
      (importWizardMode.value === 'session'
        ? imported.find((project) => project.id === missingSessionProjectId.value)
        : null) ??
      imported[0] ??
      projects?.[0] ??
      null;
    if (preferred) await loadProject(preferred);
    else enterDemoWorkspace();
    missingSessionProjectId.value = null;
    showToast(
      failures.length > 0
        ? `已导入 ${imported.length} 个项目，${failures.length} 个失败。`
        : `已导入 ${imported.length} 个项目。`,
      failures.length > 0 ? 'default' : 'success',
      '项目导入完成',
    );
  } finally {
    importWizardBusy.value = false;
  }
}

async function dismissImportWizard(): Promise<void> {
  if (importWizardBusy.value) return;
  if (importWizardMode.value === 'session') {
    const cleared = await window.api.session.clear();
    if (!cleared.ok) {
      importWizardError.value = `无法清除上次会话：${cleared.error.message}`;
      return;
    }
    missingSessionProjectId.value = null;
    enterDemoWorkspace();
    showToast('已忽略上次会话并进入示例工作区。');
  }
  importWizardOpen.value = false;
}

function formatCandidateTime(value: string): string {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toLocaleString('zh-CN') : value;
}

function enterDemoWorkspace(): void {
  const fallback = createDemoShots();
  activeProject.value = null;
  demoMode.value = true;
  detectionOpen.value = false;
  shots.value = fallback;
  markers.value = createDemoMarkers(fallback);
  projectStills.value = [];
  selectedId.value = fallback[2]?.id ?? null;
  previewTimeMs.value = fallback[2]?.startMs ?? 0;
  for (const key of Object.keys(notes)) delete notes[key];
  for (const shot of fallback) notes[shot.id] = shot.remark ?? '';
  tags.value = createDemoTags();
  terms.value = createDemoTerms();
}

async function toggleDemoWorkspace(): Promise<void> {
  if (!demoMode.value) {
    if (detecting.value) await cancelDetection();
    await closePlayer();
    resetAudioWaveform();
    enterDemoWorkspace();
    showToast('已切换到示例工作区，数据库项目未被修改。');
    return;
  }

  const projects = unwrap(await window.api.project.list());
  if (projects && projects.length > 0) {
    await loadProject(projects[0]);
    showToast(`已打开最近项目：${projects[0].name}`, 'success');
  } else {
    await openVideo();
  }
}

async function loadSettings(): Promise<void> {
  const result = await window.api.settings.get();
  if (result.ok) {
    settings.value = result.data;
  } else {
    settingsError.value = result.error.message;
    console.warn(`[settings] ${result.error.code} ${result.error.message}`);
  }
}

async function openSettings(): Promise<void> {
  settingsError.value = null;
  if (!settings.value) await loadSettings();
  settingsOpen.value = true;
  await nextTick();
  void window.api.player.setBounds({ x: 0, y: 0, width: 0, height: 0 });
}

async function closeSettings(): Promise<void> {
  settingsOpen.value = false;
  await nextTick();
  if (lastPlayerBounds) void window.api.player.setBounds(lastPlayerBounds);
}

async function openStats(): Promise<void> {
  if (demoMode.value || !activeProject.value) {
    showToast('请先打开一个真实项目，再查看学习统计。');
    return;
  }
  statsOpen.value = true;
  await nextTick();
  void window.api.player.setBounds({ x: 0, y: 0, width: 0, height: 0 });
}

async function closeStats(): Promise<void> {
  statsOpen.value = false;
  await nextTick();
  if (lastPlayerBounds) void window.api.player.setBounds(lastPlayerBounds);
}

async function saveSettings(value: SettingsSetArgs): Promise<void> {
  if (settingsSaving.value) return;
  const previousRoot = settings.value?.dataRoot;
  const willChangeDataRoot = Boolean(previousRoot && previousRoot !== value.dataRoot);
  settingsSaving.value = true;
  settingsError.value = null;
  try {
    if (willChangeDataRoot && detecting.value) await cancelDetection();
    const result = await window.api.settings.set(value);
    if (!result.ok) {
      settingsError.value = result.error.message;
      showToast(result.error.message, 'error', result.error.code);
      return;
    }
    settings.value = result.data;
    const dataRootChanged = Boolean(previousRoot && previousRoot !== result.data.dataRoot);
    if (!dataRootChanged) {
      await closeSettings();
      showToast('设置已保存，新的缓存、导出和截图路径已生效。', 'success');
      return;
    }

    await closePlayer();
    settingsOpen.value = false;
    resetAudioWaveform();
    enterDemoWorkspace();
    const projects = unwrap(await window.api.project.list());
    if (projects && projects[0]) {
      await loadProject(projects[0]);
    }
    showToast(
      '数据目录已切换。现有项目不会自动迁移，新项目将写入新位置。',
      'success',
      '设置已生效',
    );
  } finally {
    settingsSaving.value = false;
  }
}

function workspaceStateSnapshot(): WorkspaceState {
  return {
    projectId: demoMode.value ? null : activeProject.value?.id ?? null,
    timeMs: Math.max(0, Math.round(displayTimeMs.value)),
    selectedShotId: selectedId.value,
    leftCollapsed: leftCollapsed.value,
    rightCollapsed: rightCollapsed.value,
    volume: player.volume,
    shotScrollTop: shotScrollTop.value,
  };
}

function scheduleWorkspaceSave(immediate = false): void {
  if (restoringSession) return;
  const save = (): void => {
    sessionSaveTimer = null;
    void window.api.session.save(workspaceStateSnapshot()).catch((error) => {
      console.warn('[session] 工作区状态保存失败', error);
    });
  };
  if (immediate) {
    if (sessionSaveTimer) clearTimeout(sessionSaveTimer);
    save();
  } else if (!sessionSaveTimer) {
    sessionSaveTimer = setTimeout(save, 350);
  }
}

async function restorePlaybackState(state: WorkspaceState): Promise<void> {
  if (!player.hasFile) return;
  const bounded = Math.max(0, Math.min(state.timeMs, displayDurationMs.value));
  const seeked = await window.api.player.seek({ timeMs: bounded });
  if (seeked.ok) Object.assign(player, seeked.data);
  previewTimeMs.value = bounded;
  const volume = await window.api.player.setVolume({ volume: state.volume });
  if (volume.ok) Object.assign(player, volume.data);
}

window.__CAPTURE_WORKSPACE_STATE__ = workspaceStateSnapshot;

watch(
  [
    () => activeProject.value?.id,
    selectedId,
    leftCollapsed,
    rightCollapsed,
    () => player.volume,
    shotScrollTop,
  ],
  () => scheduleWorkspaceSave(true),
  { flush: 'post' },
);

watch(
  () => player.timeMs,
  () => scheduleWorkspaceSave(),
);

async function startDetection(): Promise<void> {
  if (!activeProject.value || detecting.value) return;
  stopDetectionPolling();
  detecting.value = true;
  applyingDetection.value = false;
  detectionError.value = null;
  detectionResult.value = null;
  detectionProgress.value = {
    jobId: '',
    stage: 'extractFrames',
    percent: 0,
  };
  const started = unwrap(
    await window.api.detect.run({
      projectId: activeProject.value.id,
      dryRun: true,
      options: {
        sensitivity: 0.62,
        minShotSeconds: 0.5,
        filterTransitions: true,
        weights: { s: 0.3, c: 0.3, h: 0.4 },
        intervalMs: 500,
      },
    }),
  );
  if (!started) {
    detecting.value = false;
    detectionError.value = '无法启动镜头检测';
    return;
  }
  detectionJobId.value = started.jobId;
  detectionPollTimer = setInterval(async () => {
    if (!detectionJobId.value) return;
    const result = await window.api.detect.getJob({ jobId: detectionJobId.value });
    if (!result.ok) {
      detectionError.value = result.error.message;
      detecting.value = false;
      stopDetectionPolling();
      showToast(result.error.message, 'error', result.error.code);
      return;
    }
    if (result.data.status === 'error') {
      detectionError.value = result.data.error ?? '镜头检测失败';
      detecting.value = false;
      stopDetectionPolling();
      showToast(detectionError.value, 'error', '镜头检测失败');
    } else if (result.data.status === 'cancelled') {
      detecting.value = false;
      stopDetectionPolling();
    }
  }, 500);
}

async function cancelDetection(): Promise<void> {
  if (!detectionJobId.value) return;
  unwrap(await window.api.detect.cancel({ jobId: detectionJobId.value }));
  stopDetectionPolling();
  detecting.value = false;
  detectionOpen.value = false;
  showToast('镜头检测已取消。');
}

function closeDetection(): void {
  if (detecting.value) {
    void cancelDetection();
    return;
  }
  stopDetectionPolling();
  detectionOpen.value = false;
}

async function applyDetection(shotIds: string[], sceneIds: string[]): Promise<void> {
  if (!activeProject.value || !detectionResult.value || applyingDetection.value) return;
  applyingDetection.value = true;
  try {
    const result = unwrap(
      await window.api.detect.apply({
        projectId: activeProject.value.id,
        shotIds: shotIds.map(String),
        sceneIds: sceneIds.map(String),
      }),
    );
    if (!result) return;
    const project = activeProject.value;
    detectionOpen.value = false;
    stopDetectionPolling();
    await loadProject(project);
    showToast(`已应用 ${result.applied} 个检测镜头。`, 'success');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    detectionError.value = message;
    showToast(message, 'error', '镜头应用失败');
  } finally {
    applyingDetection.value = false;
  }
}

function setPlayerBounds(bounds: RenderBounds): void {
  lastPlayerBounds = bounds;
  void window.api.player.setBounds(bounds);
}

async function setPlayerLayer(level: OverlayLayer): Promise<void> {
  const state = unwrap(await window.api.player.setLayer({ level }));
  if (state) Object.assign(player, state);
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

  await loadSettings();

  let savedSession: WorkspaceState | null = null;
  const sessionResult = await api.session.get();
  if (sessionResult.ok) {
    savedSession = sessionResult.data;
  } else {
    console.warn(`[session] 读取失败：${sessionResult.error.code} ${sessionResult.error.message}`);
  }
  try {
    const projectResult = await api.project.list();
    if (savedSession?.projectId) {
      const project = projectResult.ok
        ? projectResult.data.find((item) => item.id === savedSession?.projectId) ?? null
        : null;
      if (project) {
        leftCollapsed.value = savedSession.leftCollapsed;
        rightCollapsed.value = savedSession.rightCollapsed;
        shotScrollTop.value = savedSession.shotScrollTop ?? 0;
        await loadProject(project, savedSession);
      } else {
        await handleMissingSessionProject(savedSession.projectId);
      }
    } else if (savedSession) {
      await handleMissingSessionProject(savedSession.projectId ?? null);
    } else if (projectResult.ok && projectResult.data.length > 0) {
      await loadProject(projectResult.data[0]);
      await scanStartupCandidates();
    } else {
      await loadTerms();
      await scanStartupCandidates();
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
      loadedPlaybackPath.value = media.path;
      player.hasFile = true;
      player.durationMs = media.durationMs;
      player.width = media.width;
      player.height = media.height;
      player.fps = media.fps;
    }),
    api.player.onError((event: PlayerErrorEvent) => showToast(event.message, 'error', event.code)),
    api.media.onProgress((event) => {
      if (transcoding.value && event.stage === 'transcode') {
        transcodeProgress.value = event;
      }
    }),
    api.detect.onProgress((event) => {
      if (!detectionOpen.value || !detecting.value) return;
      if (detectionJobId.value && event.jobId !== detectionJobId.value) return;
      detectionProgress.value = event;
    }),
    api.detect.onDone((event) => {
      if (!detectionOpen.value || !detecting.value) return;
      if (detectionJobId.value && event.jobId !== detectionJobId.value) return;
      detectionResult.value = event.result;
      detectionProgress.value = { jobId: event.jobId, stage: 'analyze', percent: 100 };
      detecting.value = false;
      stopDetectionPolling();
    }),
    api.still.onCreated((still) => upsertStill(still)),
    api.export.onProgress((event) => {
      if (exporting.value) exportProgress.value = event;
    }),
    api.export.onDone((event) => {
      if (!exporting.value) return;
      exportProgress.value = {
        jobId: event.jobId,
        percent: 100,
        stage: 'write',
        message: `已写入 ${event.filePath}`,
      };
    }),
  );

  await nextTick();
  restoringSession = false;
  window.addEventListener('keydown', handleKeydown);
  window.addEventListener('beforeunload', handleBeforeUnload);
});

function handleBeforeUnload(): void {
  scheduleWorkspaceSave(true);
}

onBeforeUnmount(() => {
  for (const unsubscribe of unsubscribers) unsubscribe();
  unsubscribers.length = 0;
  window.removeEventListener('keydown', handleKeydown);
  window.removeEventListener('beforeunload', handleBeforeUnload);
  if (toastTimer) clearTimeout(toastTimer);
  if (noteTimer) clearTimeout(noteTimer);
  stopDetectionPolling();
  audioGeneration += 1;
  if (sessionSaveTimer) clearTimeout(sessionSaveTimer);
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
        <button class="nav-item" type="button" @click="showUrlImportPending">
          <AppIcon name="link" :size="15" />
          链接导入
        </button>
        <button class="nav-item" type="button" @click="toggleDemoWorkspace">
          {{ demoMode ? '最近项目' : '示例模式' }}
        </button>
        <button class="nav-item primary" type="button" @click="openDetection">
          <img class="nav-image-icon" :src="cutIcon" alt="" />
          镜头检测
        </button>
        <button class="nav-item" type="button" @click="captureStill">
          <AppIcon name="camera" :size="16" />
          静帧截图
          <kbd>S</kbd>
        </button>
        <button class="nav-item" type="button" @click="openExport">导出分镜本</button>
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
        <button class="nav-item icon-only" type="button" title="学习统计" @click="openStats">
          <AppIcon name="chart" :size="16" />
        </button>
        <button class="nav-item icon-only" type="button" title="设置" @click="openSettings">
          <AppIcon name="settings" :size="16" />
        </button>
      </div>
    </header>

    <div class="workbench" :style="{ gridTemplateColumns: workbenchColumns }">
      <ShotListPanel
        :shots="shots"
        :selected-id="selectedId"
        :current-time-ms="displayTimeMs"
        :empty-image="emptyShotsImage"
        :initial-scroll-top="shotScrollTop"
        @select="selectShot"
        @add-shot="addShotAtPlayhead"
        @detect="openDetection"
        @collapse="leftCollapsed = true"
        @scroll-position="shotScrollTop = $event"
      />

      <PlayerWorkspace
        :player="player"
        :shots="shots"
        :markers="markers"
        :selected-shot="selectedShot"
        :poster="videoPoster"
        :display-duration-ms="displayDurationMs"
        :display-time-ms="displayTimeMs"
        :busy="busy"
        :audio-waveform="audioWaveform"
        :audio-loading="audioLoading"
        @open="openVideo"
        @toggle="togglePlayback"
        @step="stepFrame"
        @seek="seekTo"
        @select-shot="selectShot"
        @boundary-change="updateBoundary"
        @boundary-commit="commitBoundary"
        @bounds="setPlayerBounds"
        @capture="captureStill"
        @set-layer="setPlayerLayer"
      />

      <ShotDetailPanel
        :shot="selectedShot"
        :note="selectedNote"
        :terms="terms"
        :tags="tags"
        :still="selectedStill"
        :thumbnail="detailPoster"
        :empty-image="emptyStillsImage"
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

    <transition name="toast">
      <div v-if="transcoding" class="transfer-toast">
        <div class="transfer-head">
          <span>正在生成播放代理</span>
          <strong>{{ transcodeProgress?.percent ?? 0 }}%</strong>
        </div>
        <div class="transfer-track">
          <i :style="{ width: `${transcodeProgress?.percent ?? 0}%` }"></i>
        </div>
        <small>{{ transcodeProgress?.message ?? '准备转码…' }}</small>
      </div>
    </transition>

    <transition name="import-modal">
      <div v-if="importWizardOpen" class="import-modal-mask">
        <section class="import-wizard" role="dialog" aria-modal="true" aria-labelledby="import-wizard-title">
          <header class="import-wizard-head">
            <div>
              <p>{{ importWizardMode === 'session' ? '上次会话恢复' : '数据目录恢复' }}</p>
              <h2 id="import-wizard-title">
                {{
                  importWizardMode === 'session'
                    ? '上次打开的项目未找到'
                    : '发现可恢复的项目'
                }}
              </h2>
              <span v-if="importWizardMode === 'session'">
                {{
                  importWizardItems.length > 0
                    ? `可能已删除或数据目录已变更。检测到 ${importWizardItems.length} 个可恢复项目，导入只会复制数据。`
                    : '可能已删除或数据目录已变更，当前没有检测到可恢复项目。'
                }}
              </span>
              <span v-else>
                这些项目来自其他数据目录。导入只会复制数据，不会移动或修改原项目。
              </span>
            </div>
          </header>

          <div class="import-candidate-list">
            <label
              v-for="item in importWizardItems"
              :key="item.key"
              class="import-candidate"
              :class="{ selected: importWizardSelected.includes(item.key) }"
            >
              <input
                type="checkbox"
                :checked="importWizardSelected.includes(item.key)"
                :disabled="importWizardBusy"
                @change="toggleImportCandidate(item.key)"
              />
              <span class="import-candidate-copy">
                <strong>{{ item.name }}</strong>
                <small>{{ item.shotCount }} 个镜头 · {{ formatCandidateTime(item.updatedAt) }}</small>
                <span :title="item.root">{{ item.root }}</span>
              </span>
            </label>
            <div v-if="importWizardItems.length === 0" class="import-empty-state">
              <strong>没有找到可恢复的项目</strong>
              <span>可以忽略这次恢复并进入示例工作区，之后从“导入影片”重新开始。</span>
            </div>
          </div>

          <p v-if="importWizardError" class="import-wizard-error">{{ importWizardError }}</p>

          <footer class="import-wizard-actions">
            <button type="button" :disabled="importWizardBusy" @click="dismissImportWizard">
              {{
                importWizardMode === 'session'
                  ? importWizardItems.length > 0
                    ? '忽略并新建'
                    : '知道了'
                  : '暂不导入'
              }}
            </button>
            <span></span>
            <template v-if="importWizardItems.length > 0">
              <button type="button" :disabled="importWizardBusy" @click="importCandidates(true)">
                全部导入
              </button>
              <button
                class="primary"
                type="button"
                :disabled="importWizardBusy || importWizardSelected.length === 0"
                @click="importCandidates(false)"
              >
                {{
                  importWizardBusy
                    ? '正在导入…'
                    : importWizardMode === 'session'
                      ? '导入项目'
                      : '导入所选'
                }}
              </button>
            </template>
          </footer>
        </section>
      </div>
    </transition>

    <TermEditorModal
      :open="termEditorOpen"
      :term="editingTerm"
      :saving="termSaving"
      @close="termEditorOpen = false"
      @save="saveTerm"
      @delete="deleteTerm"
    />

    <SettingsModal
      :open="settingsOpen"
      :settings="settings"
      :saving="settingsSaving"
      :error="settingsError"
      @close="closeSettings"
      @save="saveSettings"
    />

    <StatsModal
      :open="statsOpen"
      :project-id="activeProject?.id ?? null"
      :project-name="activeProject?.name ?? ''"
      @close="closeStats"
    />

    <DetectionModal
      :open="detectionOpen"
      :project-name="activeProject?.name ?? ''"
      :running="detecting"
      :applying="applyingDetection"
      :progress="detectionProgress"
      :result="detectionResult"
      :error="detectionError"
      @close="closeDetection"
      @cancel="cancelDetection"
      @retry="openDetection"
      @apply="applyDetection"
    />

    <ExportModal
      :open="exportOpen"
      :project-name="activeProject?.name ?? ''"
      :shots="shots"
      :busy="exporting"
      :progress="exportProgress"
      @close="exportOpen = false"
      @submit="runStoryboardExport"
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

<style scoped>
.import-modal-mask {
  position: fixed;
  inset: 0;
  z-index: 80;
  display: grid;
  padding: 24px;
  background: rgba(5, 9, 18, 0.76);
  backdrop-filter: blur(5px);
  place-items: center;
}

.import-wizard {
  display: flex;
  width: min(640px, 100%);
  max-height: min(720px, calc(100vh - 48px));
  flex-direction: column;
  overflow: hidden;
  border: 1px solid var(--border-strong);
  border-radius: 10px;
  background: var(--bg-panel);
  box-shadow: 0 24px 80px rgba(0, 0, 0, 0.5);
}

.import-wizard-head {
  flex: 0 0 auto;
  padding: 20px 22px 16px;
  border-bottom: 1px solid var(--border);
  background: linear-gradient(135deg, rgba(59, 130, 246, 0.1), transparent 60%);
}

.import-wizard-head p,
.import-wizard-head h2,
.import-wizard-head span {
  margin: 0;
}

.import-wizard-head p {
  color: var(--blue-hi);
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.08em;
}

.import-wizard-head h2 {
  margin-top: 5px;
  color: var(--text-primary);
  font-size: 17px;
  font-weight: 600;
}

.import-wizard-head span {
  display: block;
  margin-top: 7px;
  color: var(--text-muted);
  font-size: 11px;
  line-height: 1.55;
}

.import-candidate-list {
  display: flex;
  min-height: 96px;
  flex: 1;
  flex-direction: column;
  gap: 7px;
  padding: 14px;
  overflow-y: auto;
}

.import-candidate {
  display: flex;
  align-items: flex-start;
  gap: 11px;
  padding: 11px 12px;
  border: 1px solid var(--border);
  border-radius: 7px;
  background: var(--bg-raised);
  cursor: pointer;
  transition:
    border-color 120ms ease,
    background 120ms ease;
}

.import-candidate:hover {
  border-color: var(--border-strong);
  background: var(--bg-hover);
}

.import-candidate.selected {
  border-color: rgba(96, 165, 250, 0.7);
  background: rgba(59, 130, 246, 0.12);
}

.import-candidate input {
  width: 15px;
  height: 15px;
  margin: 2px 0 0;
  accent-color: var(--blue);
}

.import-candidate-copy {
  display: flex;
  min-width: 0;
  flex: 1;
  flex-direction: column;
  gap: 4px;
}

.import-candidate-copy strong {
  overflow: hidden;
  color: var(--text-primary);
  font-size: 12px;
  font-weight: 600;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.import-candidate-copy small {
  color: var(--text-secondary);
  font-size: 10px;
}

.import-candidate-copy span {
  overflow: hidden;
  color: var(--text-faint);
  font-family: var(--mono);
  font-size: 9px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.import-empty-state {
  display: flex;
  min-height: 110px;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 6px;
  color: var(--text-muted);
  text-align: center;
}

.import-empty-state strong {
  color: var(--text-secondary);
  font-size: 12px;
  font-weight: 600;
}

.import-empty-state span {
  max-width: 420px;
  font-size: 10px;
  line-height: 1.6;
}

.import-wizard-error {
  margin: 0 14px 12px;
  padding: 9px 11px;
  border: 1px solid rgba(239, 68, 68, 0.35);
  border-radius: 6px;
  background: rgba(239, 68, 68, 0.1);
  color: #fca5a5;
  font-size: 10px;
  line-height: 1.5;
  white-space: pre-wrap;
  user-select: text;
}

.import-wizard-actions {
  display: flex;
  min-height: 58px;
  flex: 0 0 auto;
  align-items: center;
  gap: 8px;
  padding: 10px 14px;
  border-top: 1px solid var(--border);
  background: var(--bg-deep);
}

.import-wizard-actions span {
  flex: 1;
}

.import-wizard-actions button {
  height: 30px;
  padding: 0 13px;
  border: 1px solid transparent;
  border-radius: 6px;
  background: var(--bg-raised);
  color: var(--text-secondary);
  font-size: 11px;
}

.import-wizard-actions button:hover:not(:disabled) {
  background: var(--bg-hover);
  color: var(--text-primary);
}

.import-wizard-actions button.primary {
  background: var(--blue);
  color: #fff;
  font-weight: 600;
}

.import-wizard-actions button.primary:hover:not(:disabled) {
  background: var(--blue-hi);
}

.import-modal-enter-active,
.import-modal-leave-active {
  transition: opacity 160ms ease;
}

.import-modal-enter-active .import-wizard,
.import-modal-leave-active .import-wizard {
  transition: transform 160ms ease;
}

.import-modal-enter-from,
.import-modal-leave-to {
  opacity: 0;
}

.import-modal-enter-from .import-wizard,
.import-modal-leave-to .import-wizard {
  transform: translateY(8px) scale(0.985);
}
</style>
