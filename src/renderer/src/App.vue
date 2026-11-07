<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue';
import emptyProjectImage from '../../../assets/design/design_empty_project_1024x768.png';
import emptyShotsImage from '../../../assets/design/design_empty_shots_1024x768.png';
import emptyStillsImage from '../../../assets/design/design_empty_stills_1024x768.png';
import cutIcon from '../../../assets/design/design_icon_cut_48.png';
import AiAssistantMenu from './components/AiAssistantMenu.vue';
import AppIcon from './components/AppIcon.vue';
import ConfirmDialog from './components/ConfirmDialog.vue';
import ContextMenu from './components/ContextMenu.vue';
import DetectionModal from './components/DetectionModal.vue';
import LabelPreviewModal from './components/LabelPreviewModal.vue';
import StoryboardWall from './components/StoryboardWall.vue';
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
  AiMcpAuthRequest,
  AiMcpDataChangedEvent,
  AiMcpStatus,
  AiTaskId,
  AudioWaveform,
  CandidateProject,
  CandidateSource,
  DetectEnvCheck,
  DetectJobSnapshot,
  DetectProgressEvent,
  DetectResult,
  BoundaryAppliedResult,
  LabelApplyPolicy,
  LabelApplyResult,
  LabelPreviewResult,
  WallLayoutItem,
  WallViewState,
  WallBoardNodeInfo,
  ExportProgressEvent,
  GpuStatus,
  IpcResult,
  MediaInfo,
  MediaProgressEvent,
  Note,
  OverlayLayer,
  PlaybackSpeed,
  PlayerErrorEvent,
  PlayerState,
  Project,
  RenderBounds,
  Settings,
  SettingsDataRootChangingEvent,
  SettingsSetArgs,
  Shot,
  ShotBoundaryEngine,
  Still,
  StoryboardExportArgs,
  Tag,
  Term,
  TimelineSettings,
  WorkspaceState,
} from '../../shared/types';
import { PLAYBACK_SPEEDS, PX_PER_SEC_LEVELS } from '../../shared/types';
import { formatTimeMs, frameToMs } from '../../shared/time';

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
const mergePartnerId = ref<string | null>(null);
const shotEditing = ref(false);
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
let transcodeQueueRefreshTimer: ReturnType<typeof setTimeout> | null = null;
let gpuPollTimer: ReturnType<typeof setInterval> | null = null;
const termEditorOpen = ref(false);
const editingTerm = ref<Term | null>(null);
const termSaving = ref(false);
const exportOpen = ref(false);
const exporting = ref(false);
const exportProgress = ref<ExportProgressEvent | null>(null);
const transcoding = ref(false);
const transcodeProgress = ref<MediaProgressEvent | null>(null);
const transcodeRunningCount = ref(0);
const transcodeQueuedCount = ref(0);
const gpuStatus = ref<GpuStatus | null>(null);
const detectionOpen = ref(false);
const detecting = ref(false);
const applyingDetection = ref(false);
const detectionProgress = ref<DetectProgressEvent | null>(null);
const detectionResult = ref<DetectResult | null>(null);
const detectionError = ref<string | null>(null);
/** S36-6 方案 A：检测中可收起状态胶囊，任务继续在后台运行。 */
const detectionCapsuleHidden = ref(false);
/** 用户在 run 返回 jobId 之前就点了取消时，等 jobId 到手后立即补发取消。 */
const detectionCancelRequested = ref(false);
const detectionJobId = ref<string | null>(null);
const detectionBoundaryEngine = ref<ShotBoundaryEngine | null>(null);
const detectionBoundaryFallback = ref(false);
const detectionBoundaryWarning = ref<string | null>(null);
/** S41：分阶段检测状态机（boundary=切分落库，labels=标签识别） */
type StagedDetectionState =
  | { kind: 'idle' }
  | { kind: 'boundary-running'; jobId: string }
  | { kind: 'boundary-ready'; result: BoundaryAppliedResult }
  | { kind: 'labels-running'; jobId: string }
  | { kind: 'labels-ready'; result: LabelPreviewResult };
const stagedDetection = ref<StagedDetectionState>({ kind: 'idle' });
/** 当前任务是否为边界任务（onDone 事件据此跳过旧的一次性预览流程） */
const boundaryFlow = ref(false);
/** 边界任务完成后的顶部提示（可关闭，关闭后仍可从镜头列表再次进入标签识别） */
const boundaryNotice = ref<BoundaryAppliedResult | null>(null);
const labelsFlow = ref(false);
const labelPreview = ref<LabelPreviewResult | null>(null);
const labelPreviewOpen = ref(false);
const labelApplying = ref(false);
const labelSelected = ref<string[]>([]);
/** S43：分镜墙画布（看板一期） */
const wallOpen = ref(false);
const wallViewState = ref<WallViewState | null>(null);
/** S44 分镜本：independent=独立分镜本（节点来自 wall_boards），project=现有镜头分镜本 */
const wallMode = ref<'project' | 'independent'>('project');
const wallBoardId = ref<string | null>(null);
const wallBoardName = ref('');
/** S45 分镜本投影：独立分镜本按连线顺序/分层呈现在拉片工作区 */
const projectionOn = ref(false);
const projectedPlaying = ref(false);
let projectedRaf = 0;
let projectedT0 = 0;
const wallRef = ref<InstanceType<typeof StoryboardWall> | null>(null);
/** 独立分镜本节点映射为 WorkspaceShot 供画布/放映复用 */
const boardShots = ref<WorkspaceShot[]>([]);
const wallNodeEdit = ref<{ nodeId: string; title: string; durationMs: number; note: string } | null>(null);
/** S44：有素材时的分镜本选择卡 */
const wallPickerOpen = ref(false);
const wallPickerBoards = ref<Array<{ id: string; name: string; nodeCount: number; updatedAt: string }>>([]);
let wallViewStateTimer: ReturnType<typeof setTimeout> | null = null;
const detectionStageLabel = computed(() => {
  const progress = detectionProgress.value;
  const percent = progress?.percent ?? 0;
  if (progress?.pipeline === 'labels') {
    if (percent < 45) return '提取代表帧';
    return percent >= 95 ? '整理识别结果' : 'Qwen 标签识别';
  }
  if (!progress || progress.stage === 'extractFrames' || percent < 58) {
    return '提取画面';
  }
  if (percent >= 94) {
    return (settings.value?.recognition?.engine ?? 'ai') === 'ai'
      ? 'Qwen 标签识别'
      : '整理镜头';
  }
  if (detectionBoundaryEngine.value === 'transnetv2') return 'TransNetV2 切分';
  if (detectionBoundaryEngine.value === 'opencv') return 'OpenCV 补充';
  return percent < 82 ? 'TransNetV2 切分' : 'OpenCV 补充';
});
interface ContextMenuItem {
  label: string;
  danger?: boolean;
  disabled?: boolean;
  action: () => void;
}
const contextMenu = reactive({
  visible: false,
  x: 0,
  y: 0,
  items: [] as ContextMenuItem[],
});
const importWizardOpen = ref(false);
const importWizardMode = ref<'startup' | 'session' | 'settings'>('startup');
const importWizardItems = ref<Array<CandidateProject & { root: string; key: string }>>([]);
const importWizardSelected = ref<string[]>([]);
const importWizardBusy = ref(false);
const importWizardError = ref<string | null>(null);
const missingSessionProjectId = ref<string | null>(null);
const settingsMigrationPreviousRoot = ref<string | null>(null);
const settingsMigrationNextRoot = ref<string | null>(null);
const loadedPlaybackPath = ref<string | null>(null);
const audioWaveform = ref<AudioWaveform | null>(null);
const audioLoading = ref(false);
const settingsOpen = ref(false);
const settings = ref<Settings | null>(null);
const settingsSaving = ref(false);
const settingsError = ref<string | null>(null);
/** S36-1b：统一危险删除确认弹窗状态（Promise 风格，await 确认结果） */
const confirmState = reactive({
  open: false,
  title: '',
  message: '',
  warning: '',
  confirmLabel: '',
  cancelLabel: '',
  resolve: (_confirmed: boolean): void => {},
});
/** 删除用户内容前是否二次确认，由设置 confirmUserContent 驱动，缺省开启 */
const needDeleteConfirm = computed(() => settings.value?.confirmUserContent ?? true);

/** S36-3：时间线轨道缩放状态，由 settings.timeline 持久化（默认轨高 96px / 密度 96px/s）。 */
const timelineSettings = ref<TimelineSettings>({ trackHeight: 96, pxPerSecond: 96 });
let timelinePersistTimer: ReturnType<typeof setTimeout> | null = null;
/** S36-4b：入点 / 出点（仅时间线选区，不做导出与循环联动）。 */
const inPointMs = ref<number | null>(null);
const outPointMs = ref<number | null>(null);

/**
 * 弹出删除确认弹窗并等待用户选择。
 * @returns 用户点击「删除」返回 true；点击取消 / Esc / 点击遮罩返回 false。
 */
function confirmUserDelete(
  title: string,
  message: string,
  options: { warning?: string; confirmLabel?: string; cancelLabel?: string } = {},
): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    confirmState.title = title;
    confirmState.message = message;
    confirmState.warning = options.warning ?? '';
    confirmState.confirmLabel = options.confirmLabel ?? '';
    confirmState.cancelLabel = options.cancelLabel ?? '';
    confirmState.resolve = resolve;
    confirmState.open = true;
  });
}

/** 结束确认弹窗并回传用户选择；重复调用（弹窗已关闭）忽略 */
function resolveConfirm(confirmed: boolean): void {
  if (!confirmState.open) return;
  confirmState.open = false;
  confirmState.resolve(confirmed);
}
const statsOpen = ref(false);
const aiMenuOpen = ref(false);
const aiCopying = ref(false);
const aiMcpStatus = ref<AiMcpStatus | null>(null);
const aiMcpBusy = ref(false);
const aiAuthRequest = ref<AiMcpAuthRequest | null>(null);
const shotScrollTop = ref(0);
let detectionPollTimer: ReturnType<typeof setInterval> | null = null;
let audioGeneration = 0;
let lastPlayerBounds: RenderBounds | null = null;
let overlayPlayerHidden = false;
let requestedTranscodeConcurrency: 1 | 2 | 4 = 4;
const pendingPlayerLayer = ref<OverlayLayer | null>(null);
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
  speed: 1,
  width: 0,
  height: 0,
  fps: 0,
  layer: 'normal',
});
const muteBeforeVolume = ref(1);

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

const selectedShot = computed(() => workbenchShots.value.find((shot) => shot.id === selectedId.value) ?? null);
const selectedMergePair = computed<[WorkspaceShot, WorkspaceShot] | null>(() => {
  const primary = selectedShot.value;
  const partner = shots.value.find((shot) => shot.id === mergePartnerId.value) ?? null;
  if (!primary || !partner || primary.id === partner.id) return null;
  const pair: [WorkspaceShot, WorkspaceShot] =
    primary.startMs <= partner.startMs ? [primary, partner] : [partner, primary];
  return pair[0].endMs === pair[1].startMs ? pair : null;
});
const canSplitAtPlayhead = computed(() => {
  const shot = selectedShot.value;
  return Boolean(
    shot &&
      !shot.locked &&
      !demoMode.value &&
      displayTimeMs.value > shot.startMs &&
      displayTimeMs.value < shot.endMs,
  );
});
const shortcutSettings = computed(() => settings.value?.shortcuts ?? {
  split: 'Ctrl+K',
  merge: 'Ctrl+Shift+G',
});
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
const mediaLabel = computed(
  () => activeProject.value?.media.filename || (demoMode.value ? '示例影片原声' : '影片原声'),
);
const topTimecode = computed(
  () => `${formatReadout(displayTimeMs.value)} / ${formatReadout(displayDurationMs.value)}`,
);
const workbenchColumns = computed(
  () => `${leftCollapsed.value ? 0 : 260}px minmax(480px, 1fr) ${rightCollapsed.value ? 0 : 300}px`,
);
const detectionResultOpen = computed(() => detectionOpen.value && !detecting.value);
const overlayOpen = computed(
  () =>
    wallOpen.value ||
    detectionResultOpen.value ||
    exportOpen.value ||
    termEditorOpen.value ||
    settingsOpen.value ||
    statsOpen.value ||
    importWizardOpen.value ||
    aiMenuOpen.value ||
    aiAuthRequest.value !== null ||
    // S41 修复：标签预览弹窗与确认框也必须把视频 HWND 降层，否则被画面盖住
    labelPreviewOpen.value ||
    confirmState.open,
);
const gpuStatusText = computed(() => {
  const status = gpuStatus.value;
  if (!status?.available) return 'GPU n/a';
  const utilization = status.utilizationPercent === null ? 'n/a' : `${Math.round(status.utilizationPercent)}%`;
  const encoder = status.encoderPercent === null ? 'n/a' : `${Math.round(status.encoderPercent)}%`;
  const memory =
    status.memoryUsedMiB !== null && status.memoryTotalMiB !== null
      ? `${(status.memoryUsedMiB / 1024).toFixed(1)}/${(status.memoryTotalMiB / 1024).toFixed(1)} GB`
      : 'n/a';
  return `GPU ${utilization} · 编码器 ${encoder} · 显存 ${memory}`;
});

function hidePlayerForOverlay(): void {
  if (overlayPlayerHidden) return;
  overlayPlayerHidden = true;
  pendingPlayerLayer.value = player.layer;
  void applyPlayerLayer('hidden');
}

function restorePlayerLayer(): void {
  if (!overlayPlayerHidden) return;
  overlayPlayerHidden = false;
  const target = pendingPlayerLayer.value ?? 'normal';
  pendingPlayerLayer.value = null;
  void applyPlayerLayer(target);
}

watch(overlayOpen, (open) => {
  if (open) hidePlayerForOverlay();
  else restorePlayerLayer();
});

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
  return assetUrlForPath(still.projectId, filePath);
}

/** S36-2：把镜头封面路径（Shot.thumbnail）转成渲染层可加载的资产 URL。 */
function assetUrlForPath(projectId: string, filePath: string): string {
  const encodedPath = filePath
    .split(/[\\/]/u)
    .filter(Boolean)
    .map((part) => encodeURIComponent(part))
    .join('/');
  return `lapian-asset://${projectId}/${encodedPath}`;
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
      thumbnail: shot.thumbnail
        ? assetUrlForPath(shot.projectId, shot.thumbnail)
        : thumbnailStill
          ? assetUrl(thumbnailStill)
          : emptyShotsImage,
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
  const proxyPath =
    project.media.proxyPath && project.media.proxyPath !== path ? project.media.proxyPath : undefined;
  void loadAudioWaveform(path, proxyPath, audioGeneration);
}

async function loadAudioWaveform(
  path: string,
  proxyPath: string | undefined,
  generation: number,
): Promise<void> {
  audioLoading.value = true;
  try {
    const result = await window.api.scope.extractAudioWaveform({ path, proxyPath, bucketMs: 100 });
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
  deferWaveform = false,
): Promise<void> {
  const projectChanged = activeProject.value?.id !== project.id;
  activeProject.value = project;
  demoMode.value = false;
  if (projectChanged && !deferWaveform) prepareAudioWaveform(project);
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
  mergePartnerId.value = null;
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

async function refreshProjectData(projectId: string, preferredShotId?: string | null): Promise<boolean> {
  const [shotResult, stillResult, noteResult] = await Promise.all([
    window.api.shot.list({ projectId }),
    window.api.still.list({ projectId }),
    window.api.note.list({ projectId }),
  ]);
  const loadedShots = unwrap(shotResult);
  const loadedStills = unwrap(stillResult);
  const loadedNotes = unwrap(noteResult);
  if (!loadedShots || !loadedStills || !loadedNotes) return false;

  for (const key of Object.keys(notes)) delete notes[key];
  for (const key of Object.keys(noteIds)) delete noteIds[key];
  const mapped = mapShots(loadedShots, loadedStills);
  shots.value = mapped;
  projectStills.value = loadedStills;
  seedDemoNoteMap(mapped, loadedNotes);
  markers.value = markersFromData(mapped, loadedStills, loadedNotes);
  const preferred =
    mapped.find((shot) => shot.id === preferredShotId) ??
    mapped.find((shot) => shot.id === selectedId.value) ??
    mapped[0] ??
    null;
  selectedId.value = preferred?.id ?? null;
  mergePartnerId.value = null;
  previewTimeMs.value = preferred?.startMs ?? 0;
  await loadTags();
  return true;
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
  let backgroundProxy: { projectId: string; sourcePath: string } | null = null;
  try {
    const media = unwrap(await window.api.player.openDialog());
    if (!media) return;
    loadedPlaybackPath.value = media.path;
    const project = await createProjectForMedia(media);
    if (project) {
      await loadProject(project, null, true);
      backgroundProxy = { projectId: project.id, sourcePath: media.path };
      showToast('影片已导入，可立即播放；代理正在后台生成。', 'success');
    }
  } finally {
    busy.value = false;
  }
  if (backgroundProxy) {
    setTimeout(() => void startBackgroundProxy(backgroundProxy.projectId, backgroundProxy.sourcePath), 0);
  }
}

async function startBackgroundProxy(projectId: string, sourcePath: string): Promise<void> {
  const tier = settings.value?.proxyTier ?? '540p';
  transcoding.value = true;
  transcodeProgress.value = {
    jobId: '',
    stage: 'transcode',
    percent: 0,
    message: `正在后台生成 ${tier} 代理`,
    queueState: 'waiting',
  };
  try {
    const proxy = unwrap(
      await window.api.media.transcodeProxy({
        sourcePath,
        tier,
      }),
    );
    if (!proxy) return;
    const updated = unwrap(
      await window.api.project.update({
        id: projectId,
        patch: { media: { proxyPath: proxy.outputPath } },
      }),
    );
    if (updated) {
      if (activeProject.value?.id === projectId) activeProject.value = updated;
      prepareAudioWaveform(updated);
      showToast(`${tier} 代理已生成，下次打开项目将使用代理。`, 'success');
    }
  } catch (error) {
    const current = activeProject.value;
    if (current?.id === projectId) prepareAudioWaveform(current);
    showToast(error instanceof Error ? error.message : String(error), 'error', '后台代理生成失败');
  } finally {
    await refreshTranscodeQueueState();
  }
}

async function refreshTranscodeQueueState(): Promise<void> {
  try {
    const result = await window.api.media.queueList();
    if (!result.ok) return;
    transcodeRunningCount.value = result.data.filter((item) => item.state === 'running').length;
    transcodeQueuedCount.value = result.data.filter((item) => item.state === 'waiting').length;
    transcoding.value = transcodeRunningCount.value + transcodeQueuedCount.value > 0;
    if (!transcoding.value) transcodeProgress.value = null;
  } catch (error) {
    console.warn('[transcode] 队列状态读取失败', error);
  }
}

async function refreshGpuStatus(): Promise<void> {
  const result = await window.api.gpu.getStatus();
  if (result.ok) gpuStatus.value = result.data;
}

function syncGpuPolling(active: boolean): void {
  if (active && !gpuPollTimer) {
    void refreshGpuStatus();
    gpuPollTimer = setInterval(() => void refreshGpuStatus(), 1000);
  } else if (!active && gpuPollTimer) {
    clearInterval(gpuPollTimer);
    gpuPollTimer = null;
  }
}

watch(
  [transcoding, detecting],
  ([transferring, detectingNow]) => syncGpuPolling(transferring || detectingNow),
);

function scheduleTranscodeQueueRefresh(): void {
  if (transcodeQueueRefreshTimer) return;
  transcodeQueueRefreshTimer = setTimeout(() => {
    transcodeQueueRefreshTimer = null;
    void refreshTranscodeQueueState();
  }, 120);
}

async function syncTranscodeConcurrency(): Promise<void> {
  const concurrency: 1 | 2 | 4 = detecting.value || (player.hasFile && !player.paused) ? 1 : 4;
  if (concurrency === requestedTranscodeConcurrency) return;
  const previous = requestedTranscodeConcurrency;
  requestedTranscodeConcurrency = concurrency;
  const result = await window.api.media.setTranscodeConcurrency({ concurrency });
  if (!result.ok) {
    requestedTranscodeConcurrency = previous;
    console.warn(`[transcode] 并发调整失败：${result.error.code} ${result.error.message}`);
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
      void syncTranscodeConcurrency();
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
    speed: 1,
    width: 0,
    height: 0,
    fps: 0,
    layer: 'normal',
  });
  void syncTranscodeConcurrency();
}

async function togglePlayback(): Promise<void> {
  if (projectedMode.value) {
    // S45 投影模式：图片幻灯播放（不依赖 mpv）
    if (projectedPlaying.value) stopProjectedPlayback();
    else startProjectedPlayback();
    return;
  }
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
    if (state) {
      Object.assign(player, state);
      void syncTranscodeConcurrency();
    }
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

function applyTimelineSettings(next: TimelineSettings): void {
  timelineSettings.value = next;
  if (timelinePersistTimer) clearTimeout(timelinePersistTimer);
  timelinePersistTimer = setTimeout(() => void persistTimelineSettings(), 400);
}

/** IPC 结构化克隆不接受 Vue 响应式 Proxy，设置落盘前统一转普通对象。 */
function plainSettings<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

async function persistTimelineSettings(): Promise<void> {
  const current = settings.value;
  if (!current || current.environmentOverride) return;
  const result = await window.api.settings.set(
    plainSettings({ ...current, timeline: timelineSettings.value }),
  );
  if (result.ok) {
    settings.value = result.data;
  } else {
    showToast(result.error.message, 'error', result.error.code);
  }
}

function onTrackHeightChange(value: number): void {
  if (value !== timelineSettings.value.trackHeight) {
    applyTimelineSettings({ ...timelineSettings.value, trackHeight: value });
  }
}

function onPxPerSecondChange(value: number): void {
  if (value !== timelineSettings.value.pxPerSecond) {
    applyTimelineSettings({ ...timelineSettings.value, pxPerSecond: value });
  }
}

function stepPxPerSecond(direction: 1 | -1): void {
  const index = PX_PER_SEC_LEVELS.indexOf(timelineSettings.value.pxPerSecond);
  const base = index >= 0 ? index : PX_PER_SEC_LEVELS.indexOf(96);
  const next = PX_PER_SEC_LEVELS[
    Math.max(0, Math.min(PX_PER_SEC_LEVELS.length - 1, base + direction))
  ];
  if (next !== timelineSettings.value.pxPerSecond) {
    applyTimelineSettings({ ...timelineSettings.value, pxPerSecond: next });
  }
}

/** ↑/↓：优先跳上/下一个标记点或镜头边界，无点可跳时回退镜头切换。 */
function jumpToAdjacentPoint(direction: 1 | -1): void {
  const points = new Set<number>();
  for (const marker of markers.value) points.add(Math.round(marker.timeMs));
  for (const shot of shots.value) {
    if (shot.startMs > 0) points.add(shot.startMs);
    if (shot.endMs < displayDurationMs.value) points.add(shot.endMs);
  }
  const sorted = [...points].sort((left, right) => left - right);
  const current = Math.round(displayTimeMs.value);
  if (direction === 1) {
    const next = sorted.find((timeMs) => timeMs > current + 1);
    if (next !== undefined) {
      void seekTo(next);
      return;
    }
  } else {
    const previous = [...sorted].reverse().find((timeMs) => timeMs < current - 1);
    if (previous !== undefined) {
      void seekTo(previous);
      return;
    }
  }
  const currentIndex = Math.max(0, shots.value.findIndex((shot) => shot.id === selectedId.value));
  const nextIndex = Math.max(0, Math.min(shots.value.length - 1, currentIndex + direction));
  const nextShot = shots.value[nextIndex];
  if (nextShot) void selectShot(nextShot);
}

/** Shift+←/→：选中/最近标记或镜头边界 ±1 帧微调并回写；无目标则回退 ±1 帧 seek。 */
async function nudgeSelectedByFrame(direction: 1 | -1): Promise<void> {
  const fps = player.hasFile ? player.fps : 500 / 21;
  const frameMs = frameToMs(1, fps);
  const threshold = Math.max(500, frameMs * 4);
  const current = Math.round(displayTimeMs.value);

  let nearestMarker: TimelineMarker | null = null;
  let nearestMarkerDist = Number.POSITIVE_INFINITY;
  for (const marker of markers.value) {
    const dist = Math.abs(marker.timeMs - current);
    if (dist < nearestMarkerDist) {
      nearestMarker = marker;
      nearestMarkerDist = dist;
    }
  }

  let nearestBoundaryIndex = -1;
  let nearestBoundaryDist = Number.POSITIVE_INFINITY;
  for (let index = 0; index < shots.value.length - 1; index += 1) {
    const dist = Math.abs(shots.value[index].endMs - current);
    if (dist < nearestBoundaryDist) {
      nearestBoundaryIndex = index;
      nearestBoundaryDist = dist;
    }
  }

  const useMarker =
    nearestMarker !== null &&
    nearestMarkerDist <= threshold &&
    nearestMarkerDist <= nearestBoundaryDist;
  if (useMarker && nearestMarker) {
    if (await nudgeMarkerByFrame(nearestMarker, direction)) {
      void seekTo(nearestMarker.timeMs);
      return;
    }
  }
  if (nearestBoundaryIndex >= 0 && nearestBoundaryDist <= threshold) {
    await nudgeBoundaryByFrame(nearestBoundaryIndex, direction);
    return;
  }
  void seekTo(current + direction * frameMs);
}

async function nudgeMarkerByFrame(marker: TimelineMarker, direction: 1 | -1): Promise<boolean> {
  if (!marker.id.startsWith('still-')) return false;
  const stillId = marker.id.slice('still-'.length);
  const fps = player.hasFile ? player.fps : 500 / 21;
  const frameMs = frameToMs(1, fps);
  const nextTime = Math.max(
    0,
    Math.min(displayDurationMs.value, Math.round(marker.timeMs + direction * frameMs)),
  );
  if (demoMode.value) {
    marker.timeMs = nextTime;
    return true;
  }
  const result = await window.api.still.update({ id: stillId, patch: { timeMs: nextTime } });
  if (!result.ok) {
    showToast(result.error.message, 'error', result.error.code);
    return false;
  }
  marker.timeMs = result.data.timeMs;
  const still = projectStills.value.find((item) => item.id === stillId);
  if (still) still.timeMs = result.data.timeMs;
  return true;
}

async function nudgeBoundaryByFrame(index: number, direction: 1 | -1): Promise<void> {
  const shot = shots.value[index];
  const next = shots.value[index + 1];
  if (!shot || !next) {
    void seekTo(displayTimeMs.value + direction * frameToMs(1, player.hasFile ? player.fps : 500 / 21));
    return;
  }
  const fps = player.hasFile ? player.fps : 500 / 21;
  const frameMs = frameToMs(1, fps);
  const nextTime = Math.max(shot.startMs + 1, Math.min(next.endMs - 1, Math.round(shot.endMs + direction * frameMs)));
  const change: BoundaryChange = { index, timeMs: nextTime };
  updateBoundary(change);
  await commitBoundary(change);
  void seekTo(nextTime);
}

function handleJKey(): void {
  // libmpv 未接负速：J 回退为逐帧后退；按住靠系统 key repeat 连续。
  if (!player.hasFile) return;
  void stepFrame(-1);
}

function handleKKey(): void {
  if (!player.hasFile || player.paused) return;
  void togglePlayback();
}

async function handleLKey(): Promise<void> {
  if (!player.hasFile) return;
  const index = PLAYBACK_SPEEDS.indexOf(player.speed);
  const next = PLAYBACK_SPEEDS[Math.min(index + 1, PLAYBACK_SPEEDS.length - 1)];
  await handleSetSpeed(next);
  if (player.paused) await togglePlayback();
}

function toggleInPoint(): void {
  inPointMs.value = inPointMs.value === null ? Math.round(displayTimeMs.value) : null;
}

function toggleOutPoint(): void {
  outPointMs.value = outPointMs.value === null ? Math.round(displayTimeMs.value) : null;
}

async function seekTo(timeMs: number): Promise<void> {
  const bounded = Math.max(0, Math.min(Math.round(timeMs), displayDurationMs.value));
  previewTimeMs.value = bounded;
  if (!player.hasFile) return;
  const state = unwrap(await window.api.player.seek({ timeMs: bounded }));
  if (state) Object.assign(player, state);
}

async function selectShot(shot: WorkspaceShot, additive = false): Promise<void> {
  if (additive) {
    const primary = selectedShot.value;
    if (!primary || primary.id === shot.id) {
      mergePartnerId.value = null;
      return;
    }
    const [left, right] =
      primary.startMs <= shot.startMs ? [primary, shot] : [shot, primary];
    if (left.endMs !== right.startMs || left.locked || right.locked) {
      showToast('合并只能选择时间上相邻且未锁定的两个镜头。');
      mergePartnerId.value = null;
      return;
    }
    mergePartnerId.value = shot.id;
    return;
  }
  mergePartnerId.value = null;
  const switched = selectedId.value !== shot.id;
  selectedId.value = shot.id;
  previewTimeMs.value = shot.startMs;
  if (player.hasFile) {
    if (switched) await handleSetSpeed(1);
    await seekTo(shot.startMs);
  } else {
    player.speed = 1;
  }
}

function openShotContextMenu(
  shot: WorkspaceShot,
  position: { x: number; y: number },
  splitTimeMs = displayTimeMs.value,
): void {
  const index = shots.value.findIndex((item) => item.id === shot.id);
  const previous = index > 0 ? shots.value[index - 1] : null;
  const next = index >= 0 && index < shots.value.length - 1 ? shots.value[index + 1] : null;
  const stillCount = projectStills.value.filter((still) => still.shotId === shot.id).length;
  const hasNote = Boolean(notes[shot.id]?.trim());
  const suffix =
    stillCount > 0 || hasNote
      ? `（含${stillCount > 0 ? ` ${stillCount} 张静帧` : ''}${stillCount > 0 && hasNote ? '与' : ''}${hasNote ? '笔记' : ''}）`
      : '';
  contextMenu.x = position.x;
  contextMenu.y = position.y;
  const items: ContextMenuItem[] = [{
    label: `在 ${formatTimeMs(splitTimeMs)} 切分`,
    disabled:
      demoMode.value ||
      shotEditing.value ||
      shot.locked ||
      splitTimeMs <= shot.startMs ||
      splitTimeMs >= shot.endMs,
    action: () => {
      void splitShotAtTime(shot, splitTimeMs);
    },
  }];
  if (selectedMergePair.value?.some((item) => item.id === shot.id)) {
    items.push({
      label: '合并已选两个镜头',
      disabled: demoMode.value || shotEditing.value,
      action: () => {
        if (selectedMergePair.value) void mergeShotPair(selectedMergePair.value);
      },
    });
  } else {
    if (previous && previous.endMs === shot.startMs) {
      items.push({
        label: '合并前一镜头',
        disabled: demoMode.value || shotEditing.value || shot.locked || previous.locked,
        action: () => {
          void mergeShotPair([previous, shot]);
        },
      });
    }
    if (next && shot.endMs === next.startMs) {
      items.push({
        label: '合并后一镜头',
        disabled: demoMode.value || shotEditing.value || shot.locked || next.locked,
        action: () => {
          void mergeShotPair([shot, next]);
        },
      });
    }
  }
  items.push({
    label: demoMode.value ? '示例镜头不可删除' : `删除镜头${suffix}`,
    danger: true,
    disabled: demoMode.value || shotEditing.value,
    action: () => {
      void deleteShot(shot);
    },
  });
  contextMenu.items = items;
  contextMenu.visible = true;
}

function openTimelineContextMenu(
  shot: WorkspaceShot | null,
  position: { x: number; y: number },
  timeMs: number,
): void {
  const target =
    shot ?? shots.value.find((item) => timeMs >= item.startMs && timeMs < item.endMs) ?? null;
  if (!target) {
    showToast('当前时码没有可编辑的镜头。');
    return;
  }
  openShotContextMenu(target, position, timeMs);
}

function canSplitShot(shot: WorkspaceShot, cutMs: number): boolean {
  return !demoMode.value && !shot.locked && cutMs > shot.startMs && cutMs < shot.endMs;
}

async function splitShotAtTime(shot: WorkspaceShot, cutMs: number): Promise<void> {
  if (!activeProject.value || shotEditing.value) return;
  if (!canSplitShot(shot, cutMs)) {
    showToast('播放头必须位于镜头内部，且镜头不能锁定。');
    return;
  }
  shotEditing.value = true;
  try {
    const result = unwrap(
      await window.api.shot.split({
        projectId: activeProject.value.id,
        shotId: shot.id,
        cutMs,
      }),
    );
    if (!result) return;
    mergePartnerId.value = null;
    await refreshProjectData(activeProject.value.id, result.right.id);
    previewTimeMs.value = cutMs;
    if (player.hasFile) await seekTo(cutMs);
    showToast(`已在 ${formatTimeMs(cutMs)} 切分镜头。`, 'success');
  } finally {
    shotEditing.value = false;
  }
}

async function mergeShotPair(pair: [WorkspaceShot, WorkspaceShot]): Promise<void> {
  if (!activeProject.value || shotEditing.value) return;
  if (pair[0].endMs !== pair[1].startMs || pair[0].locked || pair[1].locked) {
    showToast('只能合并时间相邻且未锁定的两个镜头。');
    return;
  }
  if (needDeleteConfirm.value) {
    const confirmed = await confirmUserDelete(
      '合并镜头',
      `将镜头 ${String(pair[0].index).padStart(2, '0')} 与 ${String(pair[1].index).padStart(2, '0')} 合并，第二段镜头记录会删除，笔记、标签与静帧会保留。`,
      {
        warning: '原镜头记录会被删除，但标签、笔记和静帧会迁移到合并后的镜头。',
        confirmLabel: '合并',
      },
    );
    if (!confirmed) return;
  }
  shotEditing.value = true;
  try {
    const result = unwrap(
      await window.api.shot.merge({
        projectId: activeProject.value.id,
        shotIdA: pair[0].id,
        shotIdB: pair[1].id,
      }),
    );
    if (!result) return;
    mergePartnerId.value = null;
    await refreshProjectData(activeProject.value.id, result.shot.id);
    previewTimeMs.value = result.shot.startMs;
    if (player.hasFile) await seekTo(result.shot.startMs);
    showToast('相邻镜头已合并。', 'success');
  } finally {
    shotEditing.value = false;
  }
}

async function splitSelectedAtPlayhead(): Promise<void> {
  const shot = selectedShot.value;
  if (!shot) return;
  await splitShotAtTime(shot, displayTimeMs.value);
}

async function mergeSelectedShots(): Promise<void> {
  if (!selectedMergePair.value) return;
  await mergeShotPair(selectedMergePair.value);
}

function openStillContextMenu(still: Still, position: { x: number; y: number }): void {
  contextMenu.x = position.x;
  contextMenu.y = position.y;
  contextMenu.items = [
    {
      label: '删除静帧',
      danger: true,
      action: () => {
        void deleteStill(still);
      },
    },
  ];
  contextMenu.visible = true;
}

function closeContextMenu(): void {
  contextMenu.visible = false;
}

async function deleteShot(shot: WorkspaceShot): Promise<void> {
  if (demoMode.value || !activeProject.value) {
    showToast('示例镜头不会被写入数据库，无需删除。');
    return;
  }
  const projectId = activeProject.value.id;
  const shotStills = projectStills.value.filter((still) => still.shotId === shot.id);
  const hasNote = Boolean(notes[shot.id]?.trim());
  const detail = [
    shotStills.length > 0 ? `${shotStills.length} 张静帧` : '',
    hasNote ? '笔记' : '',
  ].filter(Boolean).join('与');
  if (needDeleteConfirm.value) {
    const confirmed = await confirmUserDelete(
      '删除镜头',
      `确定删除镜头「${shot.title}」吗？${detail ? `将同时删除其 ${detail}，` : ''}图片文件也会被移除。`,
    );
    if (!confirmed) return;
  }

  const index = shots.value.findIndex((item) => item.id === shot.id);
  const neighborId = shots.value[index + 1]?.id ?? shots.value[index - 1]?.id ?? null;
  busy.value = true;
  try {
    const result = await window.api.shot.delete({ id: shot.id });
    if (!result.ok) {
      showToast(result.error.message, 'error', result.error.code);
      return;
    }
    await refreshProjectData(projectId, neighborId);
    showToast('镜头及其关联静帧、笔记已删除。', 'success');
  } finally {
    busy.value = false;
  }
}

async function deleteStill(still: Still): Promise<void> {
  if (needDeleteConfirm.value) {
    const confirmed = await confirmUserDelete(
      '删除静帧',
      '确定删除这张静帧吗？图片文件也会被移除。',
    );
    if (!confirmed) return;
  }
  const projectId = still.projectId;
  const shotId = still.shotId ?? selectedId.value;
  busy.value = true;
  try {
    const result = await window.api.still.delete({ id: still.id });
    if (!result.ok) {
      showToast(result.error.message, 'error', result.error.code);
      return;
    }
    await refreshProjectData(projectId, shotId);
    showToast('静帧记录和图片文件已删除。', 'success');
  } finally {
    busy.value = false;
  }
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
    const updated = await window.api.shot.trim({
      projectId: activeProject.value?.id ?? shot.projectId,
      leftShotId: shot.id,
      rightShotId: next.id,
      cutMs: change.timeMs,
    });
    if (!updated.ok) {
      showToast(updated.error.message, 'error', updated.error.code);
      if (activeProject.value) await loadProject(activeProject.value);
      return;
    }
    if (activeProject.value) {
      await refreshProjectData(activeProject.value.id, selectedId.value);
    }
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
      manualFields: [],
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

async function handleDeleteTag(tag: Tag): Promise<void> {
  if (tag.builtin) return;
  const usedBy = shots.value.filter((shot) => shot.tagIds.includes(tag.id)).length;
  if (needDeleteConfirm.value) {
    const confirmed = await confirmUserDelete(
      '删除标签',
      `删除标签「${tag.name}」？将同时从 ${usedBy} 个镜头移除。`,
    );
    if (!confirmed) return;
  }

  if (!demoMode.value) {
    const result = await window.api.tag.delete({ id: tag.id });
    if (!result.ok) {
      showToast(result.error.message, 'error', result.error.code);
      return;
    }
  }

  tags.value = tags.value.filter((item) => item.id !== tag.id);
  for (const shot of shots.value) {
    if (!shot.tagIds.includes(tag.id)) continue;
    Object.assign(shot, { tagIds: shot.tagIds.filter((id) => id !== tag.id) });
  }
  showToast(`已删除标签「${tag.name}」。`, 'success');
}

async function handleDeleteCategory(category: string): Promise<void> {
  if (DEFAULT_TAG_GROUPS.some((group) => group.category === category)) return;
  const members = tags.value.filter((tag) => tag.category === category);
  if (members.length === 0) return;

  const memberIds = new Set(members.map((tag) => tag.id));
  const usedBy = new Set(
    shots.value
      .filter((shot) => shot.tagIds.some((id) => memberIds.has(id)))
      .map((shot) => shot.id),
  );
  if (needDeleteConfirm.value) {
    const confirmed = await confirmUserDelete(
      '删除分类',
      `删除分类「${category}」？将删除其下 ${members.length} 个标签，并从 ${usedBy.size} 个镜头移除。`,
    );
    if (!confirmed) return;
  }

  if (!demoMode.value) {
    for (const tag of members) {
      const result = await window.api.tag.delete({ id: tag.id });
      if (!result.ok) {
        showToast(`删除「${tag.name}」失败：${result.error.message}`, 'error', result.error.code);
        return;
      }
    }
  }

  tags.value = tags.value.filter((tag) => !memberIds.has(tag.id));
  for (const shot of shots.value) {
    Object.assign(shot, {
      tagIds: shot.tagIds.filter((id) => !memberIds.has(id)),
    });
  }
  showToast(`已删除分类「${category}」。`, 'success');
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
  if (needDeleteConfirm.value) {
    const confirmed = await confirmUserDelete('删除术语', '确定删除这条术语吗？');
    if (!confirmed) return;
  }
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
  if (projectedMode.value) return; // 投影模式笔记仅内存（节点数据由分镜本编辑卡维护）
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

/** 0.3.1：用新静帧同步镜头缩略图（响应式更新 + 持久化到 shots.thumbnail 列） */
function syncStillToShotThumbnail(still: Still): void {
  if (!still.shotId) return;
  const src = still.thumbPath ?? still.filePath;
  if (!src) return;
  const idx = shots.value.findIndex((item) => item.id === still.shotId);
  if (idx < 0) return;
  const url = assetUrlForPath(still.projectId, src);
  if (shots.value[idx].thumbnail === url) return;
  shots.value[idx] = { ...shots.value[idx], thumbnail: url };
  void window.api.shot
    .setThumbnail({ id: still.shotId, thumbnail: src })
    .then((result) => {
      if (!result.ok) console.warn(`[still-sync] ${result.error.code}: ${result.error.message}`);
    });
}

function upsertStill(still: Still): void {
  const next = projectStills.value.filter((item) => item.id !== still.id);
  next.push(still);
  projectStills.value = next;
  // 0.3.1：截静帧后同步镜头缩略图（镜头列表 / 分镜墙卡 / 放映大图共用 shots.thumbnail 响应式值）
  syncStillToShotThumbnail(still);
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
  if (busy.value) {
    showToast('当前任务尚未结束，请稍后再运行镜头检测。');
    return;
  }
  if (demoMode.value || !activeProject.value) {
    showToast('请先导入本地影片，再运行镜头检测。');
    return;
  }
  // S41：切分不再依赖 Qwen 环境，只检查 Python/OpenCV 检测环境。
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
  if (!environment.data) {
    showToast('检测环境返回了无效结果，请重试。', 'error', 'DETECT_ENV_INVALID');
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
  detectionResult.value = null;
  detectionCapsuleHidden.value = false;
  // 方案 A：检测中不打开模态弹窗，改为视频区外的顶栏状态胶囊；
  // 结果/错误弹窗只在检测结束后按需打开。
  detectionOpen.value = false;
  void startDetection();
}

function openImportWizard(
  mode: 'startup' | 'session' | 'settings',
  sources: CandidateSource[],
): void {
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

async function handleDataRootChanging(event: SettingsDataRootChangingEvent): Promise<void> {
  settingsMigrationPreviousRoot.value = event.previousRoot;
  settingsMigrationNextRoot.value = event.nextRoot;
  if (event.projectCount === 0) {
    await finalizePreparedDataRootSwitch();
    return;
  }

  const preview = await window.api.settings.previewMigration();
  if (!preview.ok) {
    showToast(preview.error.message, 'error', preview.error.code);
    openImportWizard('settings', []);
    importWizardError.value = `无法读取旧数据目录：${preview.error.message}`;
    return;
  }
  if (preview.data.projects.length === 0) {
    await skipSettingsMigration();
    return;
  }
  openImportWizard('settings', [
    { root: preview.data.root, projects: preview.data.projects },
  ]);
}

async function refreshWorkspaceAfterDataRootSwitch(preferred: Project[] = []): Promise<void> {
  await closePlayer();
  resetAudioWaveform();
  enterDemoWorkspace();
  const projects = unwrap(await window.api.project.list());
  const project = preferred[0] ?? projects?.[0] ?? null;
  if (project) await loadProject(project);
}

async function finalizePreparedDataRootSwitch(): Promise<void> {
  await loadSettings();
  await refreshWorkspaceAfterDataRootSwitch();
  showToast('数据目录已切换，旧目录中的项目未迁移。', 'success', '设置已生效');
}

async function confirmSettingsMigration(items: Array<CandidateProject & { root: string; key: string }>): Promise<void> {
  if (importWizardBusy.value) return;
  importWizardBusy.value = true;
  importWizardError.value = null;
  try {
    const result = await window.api.settings.confirmMigration({
      projectIds: items.map((item) => item.id),
    });
    if (!result.ok) {
      importWizardError.value = result.error.message;
      return;
    }
    importWizardOpen.value = false;
    await loadSettings();
    await refreshWorkspaceAfterDataRootSwitch(result.data.imported);
    showToast(
      result.data.skipped.length > 0
        ? `已迁移 ${result.data.imported.length} 个项目，跳过 ${result.data.skipped.length} 个已有项目。`
        : `已迁移 ${result.data.imported.length} 个项目到新目录。`,
      'success',
      '数据迁移完成',
    );
  } finally {
    importWizardBusy.value = false;
  }
}

async function skipSettingsMigration(): Promise<void> {
  if (importWizardBusy.value) return;
  importWizardBusy.value = true;
  importWizardError.value = null;
  try {
    const result = await window.api.settings.skipMigration();
    if (!result.ok) {
      importWizardError.value = result.error.message;
      return;
    }
    settings.value = result.data;
    importWizardOpen.value = false;
    await refreshWorkspaceAfterDataRootSwitch();
    showToast('已切换到新数据目录，旧项目未复制。', 'success', '设置已生效');
  } finally {
    importWizardBusy.value = false;
  }
}

async function cancelSettingsMigration(): Promise<void> {
  if (importWizardBusy.value) return;
  importWizardBusy.value = true;
  importWizardError.value = null;
  try {
    const result = await window.api.settings.cancelMigration();
    if (!result.ok) {
      importWizardError.value = result.error.message;
      return;
    }
    settings.value = result.data;
    importWizardOpen.value = false;
    settingsMigrationPreviousRoot.value = null;
    settingsMigrationNextRoot.value = null;
    showToast('已取消数据目录更改，原设置和数据保持不变。');
  } finally {
    importWizardBusy.value = false;
  }
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
  if (importWizardMode.value === 'settings') {
    await confirmSettingsMigration(selected);
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
    timelineSettings.value = result.data.timeline ?? { trackHeight: 96, pxPerSecond: 96 };
  } else {
    settingsError.value = result.error.message;
    console.warn(`[settings] ${result.error.code} ${result.error.message}`);
  }
}

async function openSettings(): Promise<void> {
  settingsError.value = null;
  if (!settings.value) await loadSettings();
  settingsOpen.value = true;
}

async function closeSettings(): Promise<void> {
  settingsOpen.value = false;
  await nextTick();
}

async function refreshAiMcpStatus(): Promise<void> {
  const result = await window.api.ai.getMcpStatus();
  if (result.ok) aiMcpStatus.value = result.data;
  else console.warn(`[ai] ${result.error.code} ${result.error.message}`);
}

async function copyAiPrompt(tasks: AiTaskId[]): Promise<void> {
  const project = activeProject.value;
  if (!project || demoMode.value || aiCopying.value) return;
  aiCopying.value = true;
  try {
    const result = await window.api.ai.copyPrompt({ projectId: project.id, tasks: [...tasks] });
    if (!result.ok) throw new Error(result.error.message);
    showToast('提示词已复制，请粘贴给 AI 完成该任务。', 'success');
  } catch (error) {
    showToast(error instanceof Error ? error.message : String(error), 'error', '复制失败');
  } finally {
    aiCopying.value = false;
  }
}

async function toggleAiMcp(): Promise<void> {
  if (aiMcpBusy.value) return;
  aiMcpBusy.value = true;
  try {
    const enabled = !aiMcpStatus.value?.running;
    const result = await window.api.ai.startMcp({ enabled });
    if (!result.ok) throw new Error(result.error.message);
    aiMcpStatus.value = result.data;
    showToast(enabled ? '本地 MCP 已开启。' : '本地 MCP 已关闭。', 'success');
  } catch (error) {
    await refreshAiMcpStatus();
    showToast(error instanceof Error ? error.message : String(error), 'error', 'MCP 操作失败');
  } finally {
    aiMcpBusy.value = false;
  }
}

async function respondAiMcpAuth(value: { allowed: boolean; remember: boolean }): Promise<void> {
  const request = aiAuthRequest.value;
  if (!request) return;
  aiAuthRequest.value = null;
  const result = await window.api.ai.respondMcpAuth({
    requestId: request.requestId,
    allowed: value.allowed,
    remember: value.remember,
  });
  if (!result.ok) {
    showToast(result.error.message, 'error', '授权响应失败');
    return;
  }
  showToast(value.allowed ? '已允许 AI 写入镜头笔记。' : '已拒绝 AI 写入请求。');
}

async function handleAiMcpDataChanged(event: AiMcpDataChangedEvent): Promise<void> {
  if (!activeProject.value || activeProject.value.id !== event.projectId) return;
  const refreshed = await refreshProjectData(event.projectId, event.shotId);
  if (refreshed) showToast('AI 已写入镜头笔记，界面数据已刷新。', 'success');
}

async function openStats(): Promise<void> {
  if (demoMode.value || !activeProject.value) {
    showToast('请先打开一个真实项目，再查看学习统计。');
    return;
  }
  statsOpen.value = true;
}

async function closeStats(): Promise<void> {
  statsOpen.value = false;
  await nextTick();
}

async function saveSettings(value: SettingsSetArgs): Promise<void> {
  if (settingsSaving.value) return;
  const previousRoot = settings.value?.dataRoot;
  const willChangeDataRoot = Boolean(previousRoot && previousRoot !== value.dataRoot);
  settingsSaving.value = true;
  settingsError.value = null;
  try {
    if (willChangeDataRoot && detecting.value) await cancelDetection();
    const result = await window.api.settings.set(plainSettings(value));
    if (!result.ok) {
      settingsError.value = result.error.message;
      showToast(result.error.message, 'error', result.error.code);
      return;
    }
    settings.value = result.data;
    const settingsPath = result.data.settingsPath ?? 'settings.json';
    const dataRootChanged = Boolean(previousRoot && previousRoot !== result.data.dataRoot);
    if (!dataRootChanged) {
      await closeSettings();
      showToast(
        `设置已保存到 ${settingsPath}，新的缓存、导出和截图路径已生效。`,
        'success',
        '设置已保存',
      );
      return;
    }

    await closeSettings();
    showToast(`数据目录设置已保存到 ${settingsPath}，正在检查旧项目是否可以迁移。`);
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

async function handleSetVolume(volume: number): Promise<void> {
  const clamped = Math.max(0, Math.min(1, volume));
  const result = await window.api.player.setVolume({ volume: clamped });
  if (result.ok) {
    Object.assign(player, result.data);
  } else {
    showToast(result.error.message, 'error', result.error.code);
  }
}

function normalizePlaybackSpeed(rate: number): PlaybackSpeed {
  if (!Number.isFinite(rate)) return 1;
  let nearest: PlaybackSpeed = PLAYBACK_SPEEDS[0];
  for (const candidate of PLAYBACK_SPEEDS) {
    if (Math.abs(candidate - rate) < Math.abs(nearest - rate)) nearest = candidate;
  }
  return nearest;
}

async function handleSetSpeed(rate: number): Promise<void> {
  const normalized = normalizePlaybackSpeed(rate);
  if (!player.hasFile) {
    player.speed = normalized;
    return;
  }
  const result = await window.api.player.setSpeed({ rate: normalized });
  if (result.ok) {
    Object.assign(player, result.data);
  } else {
    showToast(result.error.message, 'error', result.error.code);
  }
}

function cyclePlaybackSpeed(direction: 1 | -1): void {
  const currentIndex = PLAYBACK_SPEEDS.indexOf(player.speed);
  const index = currentIndex >= 0 ? currentIndex : PLAYBACK_SPEEDS.indexOf(1);
  const nextIndex = (index + direction + PLAYBACK_SPEEDS.length) % PLAYBACK_SPEEDS.length;
  void handleSetSpeed(PLAYBACK_SPEEDS[nextIndex]);
}

async function handleToggleMute(): Promise<void> {
  if (player.volume === 0) {
    await handleSetVolume(muteBeforeVolume.value > 0 ? muteBeforeVolume.value : 1);
    return;
  }
  muteBeforeVolume.value = player.volume;
  await handleSetVolume(0);
}

window.__CAPTURE_WORKSPACE_STATE__ = workspaceStateSnapshot;

/**
 * S36-6 方案 A smoke hook：通过真实 App 检测流程启动临时项目任务，
 * 供 SMOKE_DETECT_BG 采样视频层、状态胶囊与结果弹窗状态。
 */
(window as unknown as Record<string, unknown>).__S36_DETECT_TEST__ = {
  start: async (projectId: string) => {
    // 关闭启动导入向导等残留遮罩，确保测试只看检测本身。
    settingsOpen.value = false;
    statsOpen.value = false;
    exportOpen.value = false;
    termEditorOpen.value = false;
    importWizardOpen.value = false;
    aiMenuOpen.value = false;
    aiAuthRequest.value = null;
    contextMenu.visible = false;
    detectionOpen.value = false;
    const result = await window.api.project.get({ id: projectId });
    if (!result.ok) return { ok: false, error: result.error.message };
    await loadProject(result.data);
    detectionError.value = null;
    detectionResult.value = null;
    detectionCapsuleHidden.value = false;
    detectionOpen.value = false;
    await openDetection();
    return { ok: true };
  },
  state: () => ({
    detecting: detecting.value,
    detectionOpen: detectionOpen.value,
    resultOpen: detectionResultOpen.value,
    overlayOpen: overlayOpen.value,
    resultReady: Boolean(detectionResult.value),
    resultCount: detectionResult.value?.shots.length ?? 0,
    capsuleHidden: detectionCapsuleHidden.value,
    layer: player.layer,
    progress: detectionProgress.value?.percent ?? 0,
    stageLabel: detectionStageLabel.value,
    boundaryEngine: detectionBoundaryEngine.value,
    boundaryFallback: detectionBoundaryFallback.value,
    boundaryWarning: detectionBoundaryWarning.value,
    jobId: detectionJobId.value,
    selectedId: selectedId.value,
    mergePartnerId: mergePartnerId.value,
    canSplitAtPlayhead: canSplitAtPlayhead.value,
    canMergeSelected: Boolean(selectedMergePair.value),
    shotEditing: shotEditing.value,
  }),
  collapse: () => closeDetection(),
  openResult: () => viewDetectionResult(),
  cancel: () => cancelDetection(),
};

(window as unknown as Record<string, unknown>).__S36_TIMELINE_UI_STATE__ = () => ({
  settingsLoaded: Boolean(settings.value),
  environmentOverride: settings.value?.environmentOverride ?? null,
  timeline: { ...timelineSettings.value },
  settingsTimeline: settings.value?.timeline ? { ...settings.value.timeline } : null,
});

(window as unknown as Record<string, unknown>).__S43_WALL_TEST__ = {
  openProject: async (projectId: string) => {
    const result = await window.api.project.get({ id: projectId });
    if (!result.ok) return { ok: false, error: result.error };
    await loadProject(result.data);
    return { ok: true };
  },
  openWall: async () => {
    await openWall();
    return { ok: true };
  },
  reloadEdges: async () => {
    await (wallRef.value as unknown as { reloadGraph: () => Promise<void> } | null)?.reloadGraph();
  },
  openIndependent: async () => {
    await openIndependentBoard(null);
    return { ok: true };
  },
  projectToggle: async (): Promise<string> => {
    await loadBoardNodes();
    toggleProjection();
    if (projectedMode.value && boardShots.value.length > 0) {
      selectedId.value = boardShots.value[0].id;
    }
    await new Promise((r) => setTimeout(r, 300));
    return projectedMode.value ? 'on' : 'off';
  },
  projectedState: () => ({
    projectedMode: projectedMode.value,
    rows: document.querySelectorAll('.shot-row').length,
    gridCells: document.querySelectorAll('.projection-grid img').length,
    tracks: document.querySelectorAll('.board-track-block').length,
  }),
  addTextNode: async (): Promise<string | null> => {
    const created = await window.api.wall.addNode({
      boardId: wallBoardId.value ?? '',
      source: 'text',
      title: '测试节点',
      x: 100,
      y: 100,
    });
    if (!created.ok) return null;
    await loadBoardNodes();
    return created.data.id;
  },
  state: () => ({
    wallOpen: wallOpen.value,
    cards: document.querySelectorAll('.wall-card').length,
    scale: document.querySelector('.wall-zval')?.textContent ?? '',
    playerOpen: Boolean(document.querySelector('.wall-ppt')),
    slides: document.querySelectorAll('.wall-ppt-slide').length,
    tools: document.querySelectorAll('.wall-ppt-tool').length,
  }),
  dispatchWheel: (deltaY: number, times: number): void => {
    const stage = document.querySelector('.wall-stage');
    if (!stage) return;
    for (let i = 0; i < times; i++) {
      stage.dispatchEvent(
        new WheelEvent('wheel', { deltaY, cancelable: true, bubbles: true }),
      );
    }
  },
  dispatchDblClick: (index: number): void => {
    const card = document.querySelectorAll('.wall-card')[index];
    if (card) card.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
  },
};

(window as unknown as Record<string, unknown>).__S40_SHOT_EDIT_TEST__ = {
  openProject: async (projectId: string) => {
    const result = await window.api.project.get({ id: projectId });
    if (!result.ok) return { ok: false, error: result.error };
    await loadProject(result.data);
    return { ok: true };
  },
  state: () => ({
    shots: shots.value.map((shot) => ({
      id: shot.id,
      index: shot.index,
      startMs: shot.startMs,
      endMs: shot.endMs,
      locked: shot.locked,
      thumbnail: shot.thumbnail,
    })),
    selectedId: selectedId.value,
    mergePartnerId: mergePartnerId.value,
    canSplitAtPlayhead: canSplitAtPlayhead.value,
    canMergeSelected: Boolean(selectedMergePair.value),
    shotEditing: shotEditing.value,
    timeMs: displayTimeMs.value,
    busy: busy.value,
    overlayOpen: overlayOpen.value,
  }),
  setTime: async (timeMs: number) => {
    previewTimeMs.value = timeMs;
    player.timeMs = timeMs;
    if (player.hasFile) await seekTo(timeMs);
  },
  select: async (shotId: string, additive = false) => {
    const shot = shots.value.find((item) => item.id === shotId);
    if (!shot) return false;
    await selectShot(shot, additive);
    return true;
  },
  splitAt: async (timeMs = displayTimeMs.value) => {
    const shot = selectedShot.value;
    if (!shot) return false;
    await splitShotAtTime(shot, timeMs);
    return true;
  },
  mergeSelected: async () => {
    if (!selectedMergePair.value) return false;
    await mergeShotPair(selectedMergePair.value);
    return true;
  },
};

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
  // 清掉上一次任务的 jobId，避免第二次检测时 cancel/进度过滤命中旧任务。
  detectionJobId.value = null;
  detecting.value = true;
  boundaryFlow.value = true;
  labelsFlow.value = false;
  detectionCapsuleHidden.value = false;
  detectionCancelRequested.value = false;
  void syncTranscodeConcurrency();
  applyingDetection.value = false;
  detectionError.value = null;
  detectionResult.value = null;
  detectionBoundaryEngine.value = null;
  detectionBoundaryFallback.value = false;
  detectionBoundaryWarning.value = null;
  detectionProgress.value = {
    jobId: '',
    stage: 'extractFrames',
    percent: 0,
    pipeline: 'boundary',
  };
  const started = unwrap(
    await window.api.detect.runBoundary({
      projectId: activeProject.value.id,
      options: {
        sensitivity: 0.62,
        minShotSeconds: 0.5,
        filterTransitions: true,
        weights: { s: 0.3, c: 0.3, h: 0.4 },
        intervalMs: 500,
        boundaryEngine: 'hybrid',
      },
    }),
  );
  if (!started) {
    detecting.value = false;
    boundaryFlow.value = false;
    detectionError.value = '无法启动镜头切分';
    detectionOpen.value = true;
    void syncTranscodeConcurrency();
    return;
  }
  detectionJobId.value = started.jobId;
  stagedDetection.value = { kind: 'boundary-running', jobId: started.jobId };
  if (detectionCancelRequested.value) {
    detectionCancelRequested.value = false;
    await window.api.detect.cancel({ jobId: started.jobId });
    stopDetectionPolling();
    detecting.value = false;
    detectionOpen.value = false;
    detectionResult.value = null;
    void syncTranscodeConcurrency();
    showToast('镜头检测已取消。');
    return;
  }
  detectionPollTimer = setInterval(async () => {
    if (!detectionJobId.value) return;
    const result = await window.api.detect.getJob({ jobId: detectionJobId.value });
    if (!result.ok) {
      detectionError.value = result.error.message;
      detecting.value = false;
      detectionOpen.value = true;
      void syncTranscodeConcurrency();
      stopDetectionPolling();
      showToast(result.error.message, 'error', result.error.code);
      return;
    }
    updateDetectionBoundaryState(result.data);
    if (result.data.status === 'error') {
      detectionError.value = result.data.error ?? '镜头检测失败';
      detecting.value = false;
      detectionOpen.value = true;
      void syncTranscodeConcurrency();
      stopDetectionPolling();
      showToast(detectionError.value, 'error', '镜头检测失败');
    } else if (result.data.status === 'cancelled') {
      detecting.value = false;
      detectionOpen.value = false;
      detectionResult.value = null;
      void syncTranscodeConcurrency();
      stopDetectionPolling();
    }
  }, 500);
}

async function cancelDetection(): Promise<void> {
  if (!detectionJobId.value) {
    // run 尚未返回 jobId：先记下取消意图，startDetection 拿到 jobId 后立即取消。
    detectionCancelRequested.value = true;
    detecting.value = false;
    detectionOpen.value = false;
    detectionResult.value = null;
    detectionBoundaryEngine.value = null;
    detectionBoundaryFallback.value = false;
    detectionBoundaryWarning.value = null;
    detectionCapsuleHidden.value = false;
    void syncTranscodeConcurrency();
    showToast('正在取消镜头检测…');
    return;
  }
  unwrap(await window.api.detect.cancel({ jobId: detectionJobId.value }));
  stopDetectionPolling();
  detecting.value = false;
  boundaryFlow.value = false;
  labelsFlow.value = false;
  stagedDetection.value = { kind: 'idle' };
  detectionResult.value = null;
  detectionBoundaryEngine.value = null;
  detectionBoundaryFallback.value = false;
  detectionBoundaryWarning.value = null;
  detectionCapsuleHidden.value = false;
  void syncTranscodeConcurrency();
  detectionOpen.value = false;
  showToast('镜头检测已取消。');
}

function closeDetection(): void {
  if (detecting.value) {
    // 方案 A：检测中「关闭/收起」只隐藏状态胶囊，任务继续后台运行。
    detectionCapsuleHidden.value = true;
    return;
  }
  detectionOpen.value = false;
  detectionError.value = null;
  detectionResult.value = null;
  detectionCapsuleHidden.value = false;
}

function viewDetectionResult(): void {
  if (!detectionResult.value && !detectionError.value) return;
  detectionOpen.value = true;
}

function updateDetectionBoundaryState(snapshot: DetectJobSnapshot): void {
  if (snapshot.boundaryEngine) detectionBoundaryEngine.value = snapshot.boundaryEngine;
  detectionBoundaryFallback.value = snapshot.boundaryFallback === true;
  detectionBoundaryWarning.value = snapshot.boundaryWarning ?? null;
}

function showDetectionCapsule(): void {
  detectionCapsuleHidden.value = false;
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
    detectionResult.value = null;
    detectionCapsuleHidden.value = false;
    stopDetectionPolling();
    await loadProject(project);
    showToast(`已应用 ${result.applied} 个检测镜头。`, 'success');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    detectionError.value = message;
    showToast(message, 'error', '镜头应用失败');
  } finally {
    applyingDetection.value = false;
    void syncTranscodeConcurrency();
  }
}

/** S41：标签识别（用户主动启动；Qwen 只分析已落库镜头，结果仅生成预览）。 */
async function startLabelDetection(): Promise<void> {
  if (!activeProject.value || detecting.value) return;
  if (shots.value.length === 0) {
    showToast('请先完成镜头切分，再运行标签识别。');
    return;
  }
  const local = await window.api.ai.getLocalStatus();
  if (!local.ok || !local.data.available) {
    const message = local.ok ? local.data.error ?? '本地视觉模型环境未就绪' : local.error.message;
    showToast(message, 'error', '标签识别不可用');
    return;
  }
  stopDetectionPolling();
  detectionJobId.value = null;
  detecting.value = true;
  labelsFlow.value = true;
  boundaryFlow.value = false;
  detectionCapsuleHidden.value = false;
  detectionCancelRequested.value = false;
  detectionError.value = null;
  detectionResult.value = null;
  void syncTranscodeConcurrency();
  detectionProgress.value = {
    jobId: '',
    stage: 'extractFrames',
    percent: 0,
    pipeline: 'labels',
  };
  const started = unwrap(
    await window.api.detect.runLabels({ projectId: activeProject.value.id }),
  );
  if (!started) {
    detecting.value = false;
    labelsFlow.value = false;
    showToast('无法启动标签识别', 'error');
    void syncTranscodeConcurrency();
    return;
  }
  detectionJobId.value = started.jobId;
  stagedDetection.value = { kind: 'labels-running', jobId: started.jobId };
  detectionPollTimer = setInterval(async () => {
    if (!detectionJobId.value) return;
    const result = await window.api.detect.getJob({ jobId: detectionJobId.value });
    if (!result.ok) {
      detectionError.value = result.error.message;
      detecting.value = false;
      labelsFlow.value = false;
      void syncTranscodeConcurrency();
      stopDetectionPolling();
      showToast(result.error.message, 'error', result.error.code);
      return;
    }
    if (result.data.status === 'error') {
      detectionError.value = result.data.error ?? '标签识别失败';
      detecting.value = false;
      labelsFlow.value = false;
      void syncTranscodeConcurrency();
      stopDetectionPolling();
      showToast(detectionError.value, 'error', '标签识别失败');
    } else if (result.data.status === 'cancelled') {
      detecting.value = false;
      labelsFlow.value = false;
      void syncTranscodeConcurrency();
      stopDetectionPolling();
    }
  }, 500);
}

function closeLabelPreview(): void {
  // S41：关闭预览不写库；结果暂时保留，可再次查看。
  labelPreviewOpen.value = false;
}

function viewLabelPreview(): void {
  if (!labelPreview.value) return;
  labelSelected.value = labelPreview.value.shots.map((prediction) => prediction.shotId);
  labelPreviewOpen.value = true;
}

function toggleLabelShot(shotId: string, checked: boolean): void {
  const next = new Set(labelSelected.value);
  if (checked) next.add(shotId);
  else next.delete(shotId);
  labelSelected.value = [...next];
}

function onLabelToggle(shotId: string, checked: boolean): void {
  if (shotId === '__all__') {
    labelSelected.value = checked
      ? (labelPreview.value?.shots.map((prediction) => prediction.shotId) ?? [])
      : [];
    return;
  }
  toggleLabelShot(shotId, checked);
}

/** S41：按策略应用标签预览（唯一写库入口）。 */
async function applyLabelPreview(policy: LabelApplyPolicy): Promise<void> {
  if (!labelPreview.value || labelApplying.value) return;
  if (labelSelected.value.length === 0) {
    showToast('请先选择要应用的镜头。');
    return;
  }
  if (policy === 'overwrite-all') {
    const confirmed = await confirmUserDelete(
      '覆盖全部选中镜头',
      `将用 AI 识别结果覆盖 ${labelSelected.value.length} 个选中镜头的景别、摄法、备注和六类受管标签。`,
      {
        warning: '人工修改过的对应字段也会被覆盖，此操作不可自动恢复。',
        confirmLabel: '覆盖应用',
        cancelLabel: '取消',
      },
    );
    if (!confirmed) return;
  }
  labelApplying.value = true;
  try {
    const result = unwrap(
      await window.api.detect.applyLabels({
        jobId: labelPreview.value.jobId,
        // 展开为普通数组：ref 的 .value 是响应式 Proxy，Electron 结构化克隆会抛
        // "An object could not be cloned."
        shotIds: [...labelSelected.value],
        policy,
      }),
    );
    if (!result) return;
    handleLabelApplyResult(result);
    labelPreviewOpen.value = false;
    labelPreview.value = null;
    stagedDetection.value = { kind: 'idle' };
    const project = activeProject.value;
    if (project) await loadProject(project);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    showToast(message, 'error', '标签应用失败');
  } finally {
    labelApplying.value = false;
  }
}

/** S43/S44：分镜墙打开。有素材=项目分镜本；无素材=直接新建独立分镜本创作 */
async function openWall(): Promise<void> {
  if (demoMode.value || !activeProject.value || shots.value.length === 0) {
    await openIndependentBoard(null);
    return;
  }
  // S44 修复：有素材时先弹选择卡（新建分镜本 / 本项目分镜本 / 最近独立板）
  const boards = await window.api.wall.listBoards();
  wallPickerBoards.value = boards.ok ? boards.data.slice(0, 5) : [];
  wallPickerOpen.value = true;
}

async function openProjectWall(): Promise<void> {
  wallPickerOpen.value = false;
  wallMode.value = 'project';
  wallBoardId.value = null;
  const base = settings.value?.wallViewState?.[activeProject.value?.id ?? ''] ?? null;
  wallViewState.value = base;
  wallOpen.value = true;
}

async function pickIndependentBoard(boardId: string | null): Promise<void> {
  wallPickerOpen.value = false;
  await openIndependentBoard(boardId);
}

/** S44：新建/打开独立分镜本并映射为画布节点 */
async function openIndependentBoard(boardId: string | null): Promise<void> {
  let id = boardId;
  if (!id) {
    const created = await window.api.wall.createBoard({
      name: `分镜本 ${new Date().toLocaleDateString('zh-CN')}`,
    });
    if (!created.ok) {
      showToast(created.error.message, 'error', created.error.code);
      return;
    }
    id = created.data.id;
  }
  const boards = await window.api.wall.listBoards();
  const board = boards.ok ? boards.data.find((b) => b.id === id) : null;
  wallMode.value = 'independent';
  wallBoardId.value = id;
  wallBoardName.value = board?.name ?? '独立分镜本';
  await loadBoardNodes();
  wallViewState.value = null;
  wallOpen.value = true;
}

/** 独立分镜本节点 → WorkspaceShot 映射（拓扑分层：并行节点共享同一时间段） */
async function loadBoardNodes(): Promise<void> {
  if (!wallBoardId.value) return;
  const [nodes, edges] = await Promise.all([
    window.api.wall.listNodes({ boardId: wallBoardId.value }),
    window.api.wall.listNodeEdges({ boardId: wallBoardId.value }),
  ]);
  if (!nodes.ok) {
    showToast(nodes.error.message, 'error', nodes.error.code);
    return;
  }
  if (!edges.ok) {
    showToast(edges.error.message, 'error', edges.error.code);
    return;
  }
  const adj = new Map<string, Array<string>>();
  for (const node of nodes.data) adj.set(node.id, []);
  for (const e of edges.data) {
    adj.get(e.fromShotId)?.push(e.toShotId);
  }
  // BFS 分层（深度=层），层内节点共享 startMs = 前层最大 end
  const depth = new Map<string, number>();
  const roots = nodes.data.filter((node) => !edges.data.some((e) => e.toShotId === node.id));
  const queue = (roots.length > 0 ? roots : nodes.data.slice(0, 1)).map((node) => node.id);
  for (const id of queue) depth.set(id, 0);
  let frontier = queue;
  while (frontier.length > 0) {
    const next: string[] = [];
    for (const cur of frontier) {
      for (const nb of adj.get(cur) ?? []) {
        if (!depth.has(nb)) {
          depth.set(nb, (depth.get(cur) ?? 0) + 1);
          next.push(nb);
        }
      }
    }
    frontier = next;
  }
  const layerEnd = new Map<number, number>();
  const mapped: WorkspaceShot[] = [];
  const ordered = [...nodes.data].sort((a, b) => (depth.get(a.id) ?? 0) - (depth.get(b.id) ?? 0));
  for (const node of ordered) {
    const layer = depth.get(node.id) ?? 0;
    const startMs = layerEnd.get(layer) ?? 0;
    const shape = emptyShotShape(wallBoardId.value, node, startMs);
    shape.endMs = startMs + node.durationMs;
    shape.durationMs = node.durationMs;
    mapped.push(shape);
    layerEnd.set(layer, Math.max(layerEnd.get(layer) ?? 0, startMs + node.durationMs));
    // 笔记 → 右侧镜头笔记（投影模式仅内存）
    notes[node.id] = node.note;
  }
  // 后续未连通节点顺序补齐
  const lastEnd = mapped.at(-1)?.endMs ?? 0;
  let cursor = lastEnd;
  for (const node of nodes.data) {
    if (mapped.some((m) => m.id === node.id)) continue;
    mapped.push({ ...emptyShotShape(wallBoardId.value, node, cursor) });
    cursor += node.durationMs;
  }
  boardShots.value = mapped.map((shot, i) => ({ ...shot, index: i + 1 }));
}

const projectedMode = computed(
  () => wallMode.value === 'independent' && projectionOn.value && boardShots.value.length > 0,
);

/** 工作区数据源：投影模式=分镜本节点映射 */
const workbenchShots = computed(() => (projectedMode.value ? boardShots.value : shots.value));

/** 投影多宫格：与选中节点时间重叠的其他节点（并行层）图列表 */
/** S45：时间线多轨（并行节点按时间重叠贪心分行） */
const boardTracks = computed(() => {
  if (!projectedMode.value) return null;
  const rows: Array<Array<{ id: string; title: string; durationMs: number; thumbnail?: string | null }>> = [];
  const rowEnd: number[] = [];
  for (const shot of boardShots.value) {
    let row = rowEnd.findIndex((end) => end <= shot.startMs);
    if (row < 0) {
      rowEnd.push(shot.endMs);
      row = rowEnd.length - 1;
    } else {
      rowEnd[row] = shot.endMs;
    }
    if (!rows[row]) rows[row] = [];
    rows[row].push({
      id: shot.id,
      title: shot.title,
      durationMs: shot.durationMs,
      thumbnail: shot.thumbnail,
    });
  }
  return rows;
});

const projectionImages = computed<string[]>(() => {
  if (!projectedMode.value) return [];
  const sel = selectedShot.value;
  if (!sel) return [];
  const mates = boardShots.value.filter(
    (shot) => shot.id !== sel.id && shot.startMs < sel.endMs && shot.endMs > sel.startMs,
  );
  return [sel.thumbnail, ...mates.map((shot) => shot.thumbnail)];
});

function startProjectedPlayback(): void {
  if (projectedPlaying.value) return;
  const cur = boardShots.value.find(
    (shot) => previewTimeMs.value >= shot.startMs && previewTimeMs.value < shot.endMs,
  ) ?? boardShots.value[0];
  if (!cur) return;
  if (previewTimeMs.value < cur.startMs || previewTimeMs.value >= cur.endMs) {
    previewTimeMs.value = cur.startMs;
  }
  projectedPlaying.value = true;
  projectedT0 = performance.now();
  const tick2 = (now: number): void => {
    if (!projectedPlaying.value) return;
    const dt = now - projectedT0;
    previewTimeMs.value = Math.min(cur.endMs - 1, cur.startMs + dt);
    if (previewTimeMs.value >= cur.endMs - 1) {
      const next = boardShots.value.find((shot) => shot.startMs >= cur.endMs);
      if (next) {
        selectedId.value = next.id;
        startProjectedPlayback();
        return;
      }
      projectedPlaying.value = false;
      return;
    }
    projectedRaf = requestAnimationFrame(tick2);
  };
  projectedRaf = requestAnimationFrame(tick2);
}
function stopProjectedPlayback(): void {
  projectedPlaying.value = false;
  if (projectedRaf) cancelAnimationFrame(projectedRaf);
  projectedRaf = 0;
}

/** 投影开关（墙 HUD 触发） */
function toggleProjection(): void {
  projectionOn.value = !projectionOn.value;
  if (projectionOn.value) {
    wallOpen.value = false;
    showToast('分镜本投影已开启：时间线/主播放/右侧面板来自分镜本节点。', 'success', '分镜本投影');
  }
}

function emptyShotShape(boardId: string, node: WallBoardNodeInfo, startMs: number): WorkspaceShot {
  const url =
    node.source === 'image' && node.assetPath
      ? assetUrlForPath('boards', node.assetPath)
      : textThumbDataUrl(node.textContent);
  return {
    id: node.id,
    projectId: 'board-' + boardId,
    index: 0,
    startMs,
    endMs: startMs + node.durationMs,
    durationMs: node.durationMs,
    shotSize: node.shotSize,
    cameraMethod: node.cameraMethod,
    dialogue: null,
    remark: node.note || node.title,
    origin: 'manual',
    locked: false,
    manualFields: [],
    tagIds: [],
    thumbnail: url,
    textContent: node.source === 'text' ? node.textContent : undefined,
    title: node.title || `分镜 ${startMs / 1000 + 1}s`,
    scene: '分镜本',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

/** 文本节点画面文字按 12 字/行折行，最多 6 行（超出省略） */
function wrapThumbText(text: string, perLine = 12, maxLines = 6): string[] {
  const lines: string[] = [];
  for (const para of text.split(/\r?\n/)) {
    if (para === '') {
      lines.push('');
      continue;
    }
    for (let i = 0; i < para.length; i += perLine) lines.push(para.slice(i, i + perLine));
  }
  if (lines.length > maxLines) {
    return [...lines.slice(0, maxLines - 1), lines[maxLines - 1] + '…'];
  }
  return lines;
}

/** 文本节点缩略图：黑底白字直绘为 dataURL（墙卡/投影宫格/放映大图共用 thumbnail） */
function textThumbDataUrl(text: string): string {
  const canvas = document.createElement('canvas');
  canvas.width = 320;
  canvas.height = 180;
  const ctx = canvas.getContext('2d');
  if (ctx) {
    ctx.fillStyle = '#0a0e16';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    const trimmed = text.trim();
    if (trimmed === '') {
      ctx.fillStyle = 'rgba(230, 237, 247, 0.35)';
      ctx.font = '16px "Microsoft YaHei", sans-serif';
      ctx.fillText('双击输入文字', 18, 96);
    } else {
      ctx.fillStyle = '#e6edf7';
      ctx.font = '20px "Microsoft YaHei", sans-serif';
      wrapThumbText(trimmed).forEach((line, i) => ctx.fillText(line, 18, 36 + i * 26));
    }
  }
  return canvas.toDataURL('image/png');
}

/** S44：添加节点（导入照片 / 黑底文本框；白底入口已按用户要求移除） */
async function addBoardNode(kind: 'image' | 'black'): Promise<void> {
  if (!wallBoardId.value) return;
  if (kind === 'image') {
    const picked = await window.api.wall.pickImage();
    if (!picked.ok) {
      showToast(picked.error?.message ?? '图片选择失败', 'error', picked.error?.code);
      return;
    }
    if (!picked.data.path) return;
    const imported = await window.api.wall.importImage({
      boardId: wallBoardId.value,
      srcPath: picked.data.path,
    });
    if (!imported.ok) {
      showToast(imported.error.message, 'error', imported.error.code);
      return;
    }
    await loadBoardNodes();
    return;
  }
  const created = await window.api.wall.addNode({
    boardId: wallBoardId.value,
    source: 'text',
    title: '黑底分镜',
    x: 80 + (boardShots.value.length % 6) * 60,
    y: 80 + Math.floor(boardShots.value.length / 6) * 40,
  });
  if (!created.ok) {
    showToast(created.error.message, 'error', created.error.code);
    return;
  }
  await loadBoardNodes();
}

/** 批次2：文本节点内联编辑 → 缩略图即时重绘，DB 写入防抖 500ms */
const nodeTextTimers = new Map<string, number>();

function onBoardNodeText(nodeId: string, text: string): void {
  const shot = boardShots.value.find((s) => s.id === nodeId);
  if (!shot) return;
  shot.textContent = text;
  shot.thumbnail = textThumbDataUrl(text);
  const existing = nodeTextTimers.get(nodeId);
  if (existing) window.clearTimeout(existing);
  nodeTextTimers.set(
    nodeId,
    window.setTimeout(() => {
      nodeTextTimers.delete(nodeId);
      void window.api.wall.updateNode({ nodeId, patch: { textContent: text } }).then((result) => {
        if (!result.ok) showToast(result.error.message, 'error', result.error.code);
      });
    }, 500),
  );
}

/** S44：节点编辑卡保存 */
async function deleteBoardNode(nodeId: string): Promise<void> {
  if (!wallBoardId.value) return;
  const result = await window.api.wall.deleteNode({ nodeId });
  if (!result.ok) {
    showToast(result.error.message, 'error', result.error.code);
    return;
  }
  await loadBoardNodes();
}

function openNodeEditor(nodeId: string): void {
  const shot = boardShots.value.find((item) => item.id === nodeId);
  if (!shot) return;
  const nodes = wallBoardId.value ? null : null;
  void nodes;
  wallNodeEdit.value = {
    nodeId,
    title: shot.title.startsWith('分镜 ') ? shot.title : shot.title,
    durationMs: shot.durationMs,
    note: shot.remark ?? '',
  };
}

async function saveNodeEdit(): Promise<void> {
  const edit = wallNodeEdit.value;
  if (!edit || !wallBoardId.value) return;
  const result = await window.api.wall.updateNode({
    nodeId: edit.nodeId,
    patch: { title: edit.title, durationMs: edit.durationMs, note: edit.note },
  });
  if (!result.ok) {
    showToast(result.error.message, 'error', result.error.code);
    return;
  }
  wallNodeEdit.value = null;
  await loadBoardNodes();
}

function closeWall(): void {
  wallOpen.value = false;
}

async function onWallLayoutChange(items: WallLayoutItem[]): Promise<void> {
  if (!activeProject.value) return;
  const result = await window.api.wall.saveLayout({
    projectId: activeProject.value.id,
    items,
  });
  if (!result.ok) showToast(result.error.message, 'error', result.error.code);
}

function onWallViewStateChange(view: WallViewState): void {
  wallViewState.value = view;
  if (wallViewStateTimer) clearTimeout(wallViewStateTimer);
  wallViewStateTimer = setTimeout(() => void persistWallViewState(), 400);
}

async function persistWallViewState(): Promise<void> {
  const current = settings.value;
  if (!current || current.environmentOverride || !activeProject.value) return;
  const next = { ...(current.wallViewState ?? {}) };
  next[activeProject.value.id] = wallViewState.value ?? { scale: 1, panX: 0, panY: 0 };
  const result = await window.api.settings.set(plainSettings({ ...current, wallViewState: next }));
  if (result.ok) settings.value = result.data;
}

function onWallSeek(startMs: number): void {
  const shot = shots.value.find((item) => item.startMs === startMs);
  if (shot) void selectShot(shot);
  void seekTo(startMs);
}

function handleLabelApplyResult(result: LabelApplyResult): void {
  const preservedCount = result.preserved.length;
  if (result.skipped.length > 0) {
    showToast(
      `已应用 ${result.appliedShots} 个镜头；${result.skipped.length} 个镜头因切分状态变化未应用。`,
      'success',
      '标签应用完成',
    );
    return;
  }
  showToast(
    `已更新 ${result.appliedShots} 个镜头、${result.updatedFields} 个字段、${result.updatedTagLinks} 个标签；保留 ${preservedCount} 项人工标注。`,
    'success',
    '标签应用完成',
  );
}

function setPlayerBounds(bounds: RenderBounds): void {
  const changed =
    !lastPlayerBounds ||
    lastPlayerBounds.x !== bounds.x ||
    lastPlayerBounds.y !== bounds.y ||
    lastPlayerBounds.width !== bounds.width ||
    lastPlayerBounds.height !== bounds.height;
  lastPlayerBounds = bounds;
  if (changed) void window.api.player.setBounds(bounds);
}

async function setPlayerLayer(level: OverlayLayer): Promise<void> {
  if (overlayPlayerHidden) pendingPlayerLayer.value = level;
  await applyPlayerLayer(level);
}

async function applyPlayerLayer(level: OverlayLayer): Promise<void> {
  const state = unwrap(await window.api.player.setLayer({ level }));
  if (state) Object.assign(player, state);
}

function matchesShortcut(event: KeyboardEvent, shortcut: string): boolean {
  const parts = shortcut
    .split('+')
    .map((part) => part.trim().toLowerCase())
    .filter(Boolean);
  const key = parts.at(-1);
  if (!key) return false;
  const command = parts.includes('ctrl') || parts.includes('cmd') || parts.includes('meta');
  const hasCommand = event.ctrlKey || event.metaKey;
  return (
    event.key.toLowerCase() === key &&
    hasCommand === command &&
    event.shiftKey === parts.includes('shift') &&
    event.altKey === parts.includes('alt')
  );
}

/** 0.3.0：按层级关闭最上层的弹层（Esc）；返回是否有弹层被关闭 */
function closeTopOverlay(): boolean {
  if (wallOpen.value) {
    wallOpen.value = false;
    return true;
  }
  if (aiAuthRequest.value) {
    aiAuthRequest.value = null;
    return true;
  }
  if (labelPreviewOpen.value) {
    labelPreviewOpen.value = false;
    return true;
  }
  if (settingsOpen.value) {
    closeSettings();
    return true;
  }
  if (statsOpen.value) {
    closeStats();
    return true;
  }
  if (exportOpen.value) {
    exportOpen.value = false;
    return true;
  }
  if (detectionOpen.value) {
    closeDetection();
    return true;
  }
  if (termEditorOpen.value) {
    termEditorOpen.value = false;
    return true;
  }
  if (importWizardOpen.value) {
    importWizardOpen.value = false;
    return true;
  }
  if (aiMenuOpen.value) {
    aiMenuOpen.value = false;
    return true;
  }
  return false;
}

function handleKeydown(event: KeyboardEvent): void {
  // S36-1b：删除确认弹窗打开时，全部按键交给 ConfirmDialog（Esc 取消 / Enter 确认），
  // 避免空格播放、Delete 删除等全局快捷键与弹窗互相干扰。
  if (confirmState.open) return;
  const target = event.target as HTMLElement | null;
  const tagName = target?.tagName;
  if (
    tagName === 'INPUT' ||
    tagName === 'TEXTAREA' ||
    tagName === 'SELECT' ||
    target?.isContentEditable
  ) {
    return;
  }

  // 0.3.0 修复：任意弹层打开时，Esc 关闭最上层，其余快捷键全部让位
  //（此前空格会播放/暂停——画面被隐藏但声音照响，s 会误截图）。
  if (event.key === 'Escape') {
    if (closeTopOverlay()) {
      event.preventDefault();
    }
    return;
  }
  if (overlayOpen.value) return;

  if (event.key === 'Delete') {
    if (overlayOpen.value || contextMenu.visible || busy.value) return;
    const shot = selectedShot.value;
    if (!shot || demoMode.value) return;
    event.preventDefault();
    void deleteShot(shot);
    return;
  }

  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
    event.preventDefault();
    void saveCurrentNote();
    return;
  }
  if (matchesShortcut(event, shortcutSettings.value.merge)) {
    if (overlayOpen.value || contextMenu.visible || busy.value || shotEditing.value) return;
    event.preventDefault();
    void mergeSelectedShots();
    return;
  }
  if (matchesShortcut(event, shortcutSettings.value.split)) {
    if (overlayOpen.value || contextMenu.visible || busy.value || shotEditing.value) return;
    event.preventDefault();
    void splitSelectedAtPlayhead();
    return;
  }
  if (event.key.toLowerCase() === 'm' && !event.ctrlKey && !event.metaKey) {
    event.preventDefault();
    void handleToggleMute();
    return;
  }
  if (event.key === '[' || event.key === ']') {
    event.preventDefault();
    cyclePlaybackSpeed(event.key === ']' ? 1 : -1);
    return;
  }
  if (
    !event.ctrlKey &&
    !event.metaKey &&
    (event.key === '+' || event.key === '=' || event.key === '-' || event.key === '_')
  ) {
    event.preventDefault();
    stepPxPerSecond(event.key === '-' || event.key === '_' ? -1 : 1);
    return;
  }
  if (event.key.toLowerCase() === 'j' && !event.ctrlKey && !event.metaKey) {
    event.preventDefault();
    handleJKey();
    return;
  }
  if (event.key.toLowerCase() === 'k' && !event.ctrlKey && !event.metaKey) {
    event.preventDefault();
    handleKKey();
    return;
  }
  if (event.key.toLowerCase() === 'l' && !event.ctrlKey && !event.metaKey) {
    event.preventDefault();
    void handleLKey();
    return;
  }
  if (event.key.toLowerCase() === 'i' && !event.ctrlKey && !event.metaKey) {
    event.preventDefault();
    toggleInPoint();
    return;
  }
  if (event.key.toLowerCase() === 'o' && !event.ctrlKey && !event.metaKey) {
    event.preventDefault();
    toggleOutPoint();
    return;
  }
  if ((event.ctrlKey || event.metaKey) && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) {
    event.preventDefault();
    const step = event.shiftKey ? 0.1 : 0.01;
    const delta = event.key === 'ArrowUp' ? step : -step;
    void handleSetVolume(Math.round((player.volume + delta) * 100) / 100);
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
    jumpToAdjacentPoint(event.key === 'ArrowDown' ? 1 : -1);
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
    if (event.shiftKey) void nudgeSelectedByFrame(dir);
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
  await refreshAiMcpStatus();

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
    api.settings.onDataRootChanging((event) => {
      void handleDataRootChanging(event);
    }),
    api.player.onState((state) => {
      Object.assign(player, state);
      void syncTranscodeConcurrency();
    }),
    api.player.onTime((event) => {
      player.timeMs = event.timeMs;
      previewTimeMs.value = event.timeMs;
      const active = shots.value.find(
        (shot) => event.timeMs >= shot.startMs && event.timeMs < shot.endMs,
      );
      if (active && active.id !== selectedId.value) {
        selectedId.value = active.id;
        mergePartnerId.value = null;
      }
    }),
    api.player.onLoaded((media: MediaInfo) => {
      loadedPlaybackPath.value = media.path;
      player.hasFile = true;
      player.durationMs = media.durationMs;
      player.width = media.width;
      player.height = media.height;
      player.fps = media.fps;
      player.speed = 1;
      void syncTranscodeConcurrency();
    }),
    api.player.onError((event: PlayerErrorEvent) => showToast(event.message, 'error', event.code)),
    api.media.onProgress((event) => {
      if (event.gpu) gpuStatus.value = event.gpu;
      if (event.stage === 'transcode') {
        transcodeProgress.value = event;
        transcoding.value = true;
        scheduleTranscodeQueueRefresh();
      }
    }),
    api.detect.onProgress((event) => {
      if (!detecting.value) return;
      if (detectionJobId.value && event.jobId !== detectionJobId.value) return;
      detectionProgress.value = event;
    }),
    api.detect.onDone(async (event) => {
      if (!detecting.value) return;
      if (boundaryFlow.value || labelsFlow.value) return;
      if (detectionJobId.value && event.jobId !== detectionJobId.value) return;
      const snapshot = await window.api.detect.getJob({ jobId: event.jobId });
      if (snapshot.ok) updateDetectionBoundaryState(snapshot.data);
      detectionResult.value = event.result;
      detectionProgress.value = {
        jobId: event.jobId,
        stage: 'analyze',
        percent: 100,
        pipeline: 'boundary',
      };
      detecting.value = false;
      detectionCapsuleHidden.value = false;
      detectionOpen.value = false;
      void syncTranscodeConcurrency();
      stopDetectionPolling();
      if (detectionBoundaryFallback.value) {
        showToast(
          `检测完成，${event.result.shots.length} 个合并镜头待确认。已使用 OpenCV 备用切分。`,
          'default',
          '已使用 OpenCV 备用切分',
        );
      } else {
        showToast(
          `检测完成，${event.result.shots.length} 个合并镜头待确认。`,
          'success',
          '镜头检测完成',
        );
      }
    }),
    // S41：边界任务完成 → 已自动落库，刷新项目并提示
    api.detect.onBoundaryApplied(async (event) => {
      if (detectionJobId.value && event.jobId !== detectionJobId.value) return;
      stopDetectionPolling();
      detecting.value = false;
      boundaryFlow.value = false;
      detectionOpen.value = false;
      detectionResult.value = null;
      detectionCapsuleHidden.value = false;
      stagedDetection.value = { kind: 'boundary-ready', result: event.result };
      boundaryNotice.value = event.result;
      void syncTranscodeConcurrency();
      const project = activeProject.value;
      if (project) await loadProject(project);
      if (event.result.applied === 0 && event.result.skippedProtected > 0) {
        showToast(
          `切分完成，但 ${event.result.skippedProtected} 个候选镜头与人工/锁定镜头重叠，未应用任何新镜头。`,
          'error',
          '切分已跳过全部候选',
        );
      } else {
        showToast(
          `切分已应用 · ${event.result.applied} 个镜头`,
          'success',
          '镜头切分完成',
        );
      }
    }),
    // S41：标签识别完成 → 打开预览，不自动写库
    api.detect.onLabelsDone((event) => {
      if (detectionJobId.value && event.jobId !== detectionJobId.value) return;
      stopDetectionPolling();
      detecting.value = false;
      labelsFlow.value = false;
      detectionCapsuleHidden.value = false;
      void syncTranscodeConcurrency();
      labelPreview.value = event.result;
      labelSelected.value = event.result.shots.map((prediction) => prediction.shotId);
      labelPreviewOpen.value = true;
      stagedDetection.value = { kind: 'labels-ready', result: event.result };
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
    api.ai.onMcpAuthRequest((request) => {
      aiAuthRequest.value = request;
    }),
    api.ai.onDataChanged((event) => {
      void handleAiMcpDataChanged(event);
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
  if (transcodeQueueRefreshTimer) clearTimeout(transcodeQueueRefreshTimer);
  if (gpuPollTimer) clearInterval(gpuPollTimer);
  stopDetectionPolling();
  audioGeneration += 1;
  if (timelinePersistTimer) clearTimeout(timelinePersistTimer);
  if (sessionSaveTimer) clearTimeout(sessionSaveTimer);
  for (const timer of nodeTextTimers.values()) clearTimeout(timer);
  nodeTextTimers.clear();
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
        <button class="nav-item" type="button" @click="toggleDemoWorkspace">
          {{ demoMode ? '最近项目' : '示例模式' }}
        </button>
        <button class="nav-item primary" type="button" :disabled="detecting" @click="openDetection">
          <img class="nav-image-icon" :src="cutIcon" alt="" />
          {{ shots.length > 0 ? '重新切分' : '镜头切分' }}
        </button>
        <button
          class="nav-item"
          type="button"
          :disabled="detecting || shots.length === 0"
          :title="shots.length === 0 ? '请先完成镜头切分' : '对已落库镜头运行 Qwen 标签识别'"
          @click="startLabelDetection"
        >
          标签识别
        </button>
        <button
          class="nav-item"
          type="button"
          :disabled="shots.length === 0"
          title="把当前镜头铺在画布上自由摆放、缩放浏览"
          @click="openWall"
        >
          分镜墙
        </button>
        <button class="nav-item" type="button" @click="captureStill">
          <AppIcon name="camera" :size="16" />
          静帧截图
          <kbd>S</kbd>
        </button>
        <button class="nav-item" type="button" @click="openExport">导出分镜本</button>
        <AiAssistantMenu
          :open="aiMenuOpen"
          :has-project="Boolean(activeProject) && !demoMode"
          :project-name="activeProject?.name ?? ''"
          :mcp-status="aiMcpStatus"
          :mcp-busy="aiMcpBusy"
          :copying="aiCopying"
          :auth-request="aiAuthRequest"
          @toggle="aiMenuOpen = !aiMenuOpen"
          @close="aiMenuOpen = false"
          @copy-prompt="copyAiPrompt"
          @copy-snapshot="copyAiPrompt([])"
          @toggle-mcp="toggleAiMcp"
          @respond-auth="respondAiMcpAuth"
        />
      </nav>

      <div class="topbar-right">
        <div v-if="projectedMode" class="board-projection-badge">
          分镜本投影 · {{ wallBoardName }}
          <button type="button" @click="toggleProjection">退出</button>
        </div>
        <div v-if="detecting && !detectionCapsuleHidden" class="detect-status-chip">
          <span class="detect-chip-dot"></span>
          <strong>{{ detectionStageLabel }} · {{ detectionProgress?.percent ?? 0 }}%</strong>
          <div class="detect-chip-track">
            <i :style="{ width: `${detectionProgress?.percent ?? 0}%` }"></i>
          </div>
          <button type="button" class="detect-chip-bg" @click="closeDetection">后台</button>
          <button type="button" class="detect-chip-cancel" @click="cancelDetection">取消</button>
        </div>
        <button
          v-else-if="detecting"
          class="detect-mini-chip"
          type="button"
          @click="showDetectionCapsule"
        >
          {{ detectionStageLabel }} · {{ detectionProgress?.percent ?? 0 }}%
        </button>
        <button
          v-else-if="labelPreview"
          class="detect-result-chip"
          type="button"
          @click="viewLabelPreview"
        >
          标签识别完成 {{ labelPreview.shots.length }} 个镜头 · 查看结果
        </button>
        <div v-else-if="boundaryNotice" class="detect-result-chip boundary-notice">
          <span>
            切分已应用 · {{ boundaryNotice.applied }} 个镜头{{
              boundaryNotice.skippedProtected > 0
                ? `（${boundaryNotice.skippedProtected} 个被人工镜头保护跳过）`
                : ''
            }}
          </span>
          <button type="button" class="boundary-notice-action" @click="startLabelDetection">
            开始标签识别
          </button>
          <button type="button" aria-label="关闭提示" @click="boundaryNotice = null">×</button>
        </div>
        <button
          v-else-if="detectionResult"
          class="detect-result-chip"
          type="button"
          @click="viewDetectionResult"
        >
          检测完成 {{ detectionResult.shots.length }} 个镜头 · 查看
        </button>
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
        :shots="workbenchShots"
        :selected-id="selectedId"
        :merge-partner-id="mergePartnerId"
        :current-time-ms="displayTimeMs"
        :empty-image="emptyShotsImage"
        :initial-scroll-top="shotScrollTop"
        @select="selectShot"
        @add-shot="addShotAtPlayhead"
        @detect="openDetection"
        @collapse="leftCollapsed = true"
        @scroll-position="shotScrollTop = $event"
        @context-menu="openShotContextMenu"
      />

      <PlayerWorkspace
        :player="player"
        :shots="workbenchShots"
        :projection-images="projectionImages"
        :markers="markers"
        :selected-shot="selectedShot"
        :merge-partner-id="mergePartnerId"
        :split-shortcut="shortcutSettings.split"
        :merge-shortcut="shortcutSettings.merge"
        :poster="videoPoster"
        :display-duration-ms="displayDurationMs"
        :display-time-ms="displayTimeMs"
        :busy="busy"
        :audio-waveform="audioWaveform"
        :audio-loading="audioLoading"
        :media-label="mediaLabel"
        :track-height="timelineSettings.trackHeight"
        :px-per-second="timelineSettings.pxPerSecond"
        :board-tracks="boardTracks"
        :projection-mode="projectedMode"
        :in-point-ms="inPointMs"
        :out-point-ms="outPointMs"
        @open="openVideo"
        @toggle="togglePlayback"
        @step="stepFrame"
        @seek="seekTo"
        @select-shot="selectShot"
        @split-shot="splitSelectedAtPlayhead"
        @merge-shots="mergeSelectedShots"
        @shot-context-menu="openTimelineContextMenu"
        @boundary-change="updateBoundary"
        @boundary-commit="commitBoundary"
        @bounds="setPlayerBounds"
        @capture="captureStill"
        @set-layer="setPlayerLayer"
        @set-volume="handleSetVolume"
        @set-speed="handleSetSpeed"
        @toggle-mute="handleToggleMute"
        @update-track-height="onTrackHeightChange"
        @update-px-per-second="onPxPerSecondChange"
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
        @delete-tag="handleDeleteTag"
        @delete-category="handleDeleteCategory"
        @create-category="createCustomTag"
        @create-term="openNewTerm"
        @edit-term="openEditTerm"
        @import-terms="importTerms"
        @export-terms="exportTerms"
        @set-annotations="saveAnnotations"
        @save-note="saveCurrentNote()"
        @capture="captureStill"
        @context-menu="openStillContextMenu"
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

    <StoryboardWall
      v-if="wallOpen"
      ref="wallRef"
      :shots="wallMode === 'independent' ? boardShots : shots"
      :project-id="wallMode === 'independent' ? 'boards' : activeProject?.id ?? ''"
      :view-state="wallViewState"
      :board-mode="wallMode === 'independent'"
      @close="closeWall"
      @seek="onWallSeek"
      @layout-change="onWallLayoutChange"
      @view-state-change="onWallViewStateChange"
      @edit-node="openNodeEditor"
      @create-node="addBoardNode"
      @delete-node="deleteBoardNode"
      @node-text="onBoardNodeText"
      @project="toggleProjection"
    >
      <div v-if="wallMode === 'independent'" class="board-badge">
        {{ wallBoardName }}（独立分镜本）
      </div>
    </StoryboardWall>

    <div v-if="wallPickerOpen" class="node-edit-mask" @pointerdown.self="wallPickerOpen = false">
      <div class="node-edit-card">
        <header>
          <h3>分镜墙</h3>
          <button type="button" aria-label="关闭" @click="wallPickerOpen = false">×</button>
        </header>
        <button type="button" class="picker-option" @click="openProjectWall">
          <b>本项目分镜本</b>
          <small>把当前项目已切分的镜头铺到画布上编排</small>
        </button>
        <button type="button" class="picker-option" @click="pickIndependentBoard(null)">
          <b>新建分镜本</b>
          <small>不依赖拉片素材：导入照片或黑底+文本框开始创作</small>
        </button>
        <template v-if="wallPickerBoards.length > 0">
          <p class="picker-title">最近分镜本</p>
          <button
            v-for="board in wallPickerBoards"
            :key="board.id"
            type="button"
            class="picker-option"
            @click="pickIndependentBoard(board.id)"
          >
            <b>{{ board.name }}</b>
            <small>{{ board.nodeCount }} 节点 · {{ new Date(board.updatedAt).toLocaleString('zh-CN') }}</small>
          </button>
        </template>
      </div>
    </div>

    <div
      v-if="wallNodeEdit"
      class="node-edit-mask"
      @pointerdown.self="wallNodeEdit = null"
    >
      <div class="node-edit-card">
        <header>
          <h3>编辑分镜节点</h3>
          <button type="button" aria-label="关闭" @click="wallNodeEdit = null">×</button>
        </header>
        <label class="node-edit-field">
          名称
          <input v-model="wallNodeEdit.title" type="text" maxlength="200" />
        </label>
        <label class="node-edit-field">
          持续时间（毫秒）
          <input v-model.number="wallNodeEdit.durationMs" type="number" min="200" max="600000" step="100" />
        </label>
        <label class="node-edit-field">
          笔记
          <textarea v-model="wallNodeEdit.note" rows="4" maxlength="20000"></textarea>
        </label>
        <footer>
          <button type="button" @click="wallNodeEdit = null">取消</button>
          <button type="button" class="primary" @click="saveNodeEdit">保存</button>
        </footer>
      </div>
    </div>

    <transition name="toast">
      <div v-if="transcoding" class="transfer-toast">
        <div class="transfer-head">
          <span>后台转码 {{ transcodeRunningCount }} 运行</span>
          <strong>{{ transcodeProgress?.percent ?? 0 }}%</strong>
        </div>
        <div class="transfer-track">
          <i :style="{ width: `${transcodeProgress?.percent ?? 0}%` }"></i>
        </div>
        <small>
          {{ transcodeProgress?.message ?? '准备转码…' }}
          <template v-if="transcodeQueuedCount > 0"> · 队列中 {{ transcodeQueuedCount }}</template>
        </small>
        <small class="transfer-gpu">{{ gpuStatusText }}</small>
      </div>
    </transition>

    <transition name="import-modal">
      <div v-if="importWizardOpen" class="import-modal-mask">
        <section class="import-wizard" role="dialog" aria-modal="true" aria-labelledby="import-wizard-title">
          <header class="import-wizard-head">
            <div>
              <p>
                {{
                  importWizardMode === 'settings'
                    ? '数据目录迁移'
                    : importWizardMode === 'session'
                      ? '上次会话恢复'
                      : '数据目录恢复'
                }}
              </p>
              <h2 id="import-wizard-title">
                {{
                  importWizardMode === 'settings'
                    ? '迁移旧项目到新目录'
                    : importWizardMode === 'session'
                      ? '上次打开的项目未找到'
                      : '发现可恢复的项目'
                }}
              </h2>
              <span v-if="importWizardMode === 'settings'">
                原目录中的项目可以复制到新目录。迁移不会删除原数据，已有同名项目会跳过。
                <small v-if="settingsMigrationPreviousRoot">
                  {{ settingsMigrationPreviousRoot }} → {{ settingsMigrationNextRoot }}
                </small>
              </span>
              <span v-else-if="importWizardMode === 'session'">
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
            <template v-if="importWizardMode === 'settings'">
              <button type="button" :disabled="importWizardBusy" @click="cancelSettingsMigration">
                取消更改
              </button>
              <span></span>
              <button type="button" :disabled="importWizardBusy" @click="skipSettingsMigration">
                跳过（不迁移）
              </button>
              <button type="button" :disabled="importWizardBusy" @click="importCandidates(true)">
                迁移全部
              </button>
              <button
                class="primary"
                type="button"
                :disabled="importWizardBusy || importWizardSelected.length === 0"
                @click="importCandidates(false)"
              >
                {{
                  importWizardBusy
                    ? '正在迁移…'
                    : '仅迁移选中'
                }}
              </button>
            </template>
            <template v-else>
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
            </template>
          </footer>
        </section>
      </div>
    </transition>

    <ContextMenu
      :visible="contextMenu.visible"
      :x="contextMenu.x"
      :y="contextMenu.y"
      :items="contextMenu.items"
      @close="closeContextMenu"
    />

    <TermEditorModal
      :open="termEditorOpen"
      :term="editingTerm"
      :saving="termSaving"
      @close="termEditorOpen = false"
      @save="saveTerm"
      @delete="deleteTerm"
    />

    <ConfirmDialog
      :open="confirmState.open"
      :title="confirmState.title"
      :message="confirmState.message"
      :warning="confirmState.warning || undefined"
      :confirm-label="confirmState.confirmLabel || undefined"
      :cancel-label="confirmState.cancelLabel || undefined"
      @confirm="resolveConfirm(true)"
      @cancel="resolveConfirm(false)"
    />

    <SettingsModal
      :open="settingsOpen"
      :settings="settings"
      :saving="settingsSaving"
      :error="settingsError"
      :mcp-status="aiMcpStatus"
      :mcp-busy="aiMcpBusy"
      @close="closeSettings"
      @save="saveSettings"
      @toggle-mcp="toggleAiMcp"
    />

    <StatsModal
      :open="statsOpen"
      :project-id="activeProject?.id ?? null"
      :project-name="activeProject?.name ?? ''"
      @close="closeStats"
    />

    <DetectionModal
      :open="detectionResultOpen"
      :project-name="activeProject?.name ?? ''"
      :running="detecting"
      :applying="applyingDetection"
      :progress="detectionProgress"
      :gpu-label="gpuStatusText"
      :result="detectionResult"
      :error="detectionError"
      :engine="settings?.recognition?.engine ?? 'ai'"
      :stage-label="detectionStageLabel"
      :boundary-engine="detectionBoundaryEngine"
      :boundary-fallback="detectionBoundaryFallback"
      :boundary-warning="detectionBoundaryWarning"
      @close="closeDetection"
      @cancel="cancelDetection"
      @retry="openDetection"
      @apply="applyDetection"
    />

    <LabelPreviewModal
      :open="labelPreviewOpen"
      :preview="labelPreview"
      :selected-ids="labelSelected"
      :applying="labelApplying"
      @close="closeLabelPreview"
      @toggle="onLabelToggle"
      @apply="applyLabelPreview"
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

.import-wizard-head small {
  display: block;
  margin-top: 5px;
  overflow-wrap: anywhere;
  color: var(--text-faint);
  font-family: var(--mono);
  font-size: 9px;
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
