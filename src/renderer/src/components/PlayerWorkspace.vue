<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue';
import AppIcon from './AppIcon.vue';
import TimelineEditor from './TimelineEditor.vue';
import type { BoundaryChange, TimelineMarker, WorkspaceShot } from '../types/workspace';
import type {
  AudioWaveform,
  OverlayLayer,
  PlayerState,
  RenderBounds,
} from '../../../shared/types';

const props = defineProps<{
  player: PlayerState;
  shots: WorkspaceShot[];
  markers: TimelineMarker[];
  selectedShot: WorkspaceShot | null;
  poster: string;
  displayDurationMs: number;
  displayTimeMs: number;
  busy: boolean;
  audioWaveform: AudioWaveform | null;
  audioLoading: boolean;
}>();

const emit = defineEmits<{
  open: [];
  toggle: [];
  step: [dir: 1 | -1];
  seek: [timeMs: number];
  selectShot: [shot: WorkspaceShot];
  boundaryChange: [change: BoundaryChange];
  boundaryCommit: [change: BoundaryChange];
  bounds: [bounds: RenderBounds];
  capture: [];
  setLayer: [level: OverlayLayer];
  setVolume: [volume: number];
  toggleMute: [];
}>();

const videoSlot = ref<HTMLElement | null>(null);
const controlsVisible = ref(true);
const volumeOpen = ref(false);
let resizeObserver: ResizeObserver | null = null;

const timecode = computed(() => formatTimecode(props.displayTimeMs));
const durationText = computed(() => formatTimecode(props.displayDurationMs));
const frameNumber = computed(() => {
  const fps = props.player.hasFile ? props.player.fps : 500 / 21;
  return String(Math.round((props.displayTimeMs / 1000) * fps));
});
const resolutionText = computed(() => {
  if (!props.player.hasFile) return '1920 × 1080';
  return `${props.player.width} × ${props.player.height}`;
});
const layerLabel = computed(() => {
  if (props.player.layer === 'bottom') return '置底';
  if (props.player.layer === 'hidden') return '隐藏';
  return '正常';
});
const layerNext = computed<OverlayLayer>(() => {
  if (props.player.layer === 'normal') return 'bottom';
  if (props.player.layer === 'bottom') return 'hidden';
  return 'normal';
});

function cycleLayer(): void {
  if (!props.player.hasFile) return;
  emit('setLayer', layerNext.value);
}

function formatTimecode(ms: number): string {
  const safeMs = Math.max(0, Math.floor(ms));
  const totalSeconds = Math.floor(safeMs / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const frames = Math.floor((safeMs % 1000) / (1000 / 24));
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}:${String(frames).padStart(2, '0')}`;
}

function pushBounds(): void {
  const element = videoSlot.value;
  if (!element) return;
  const rect = element.getBoundingClientRect();
  emit('bounds', {
    x: rect.x,
    y: rect.y,
    width: rect.width,
    height: rect.height,
  });
}

onMounted(async () => {
  await nextTick();
  pushBounds();
  resizeObserver = new ResizeObserver(pushBounds);
  if (videoSlot.value) resizeObserver.observe(videoSlot.value);
  window.addEventListener('resize', pushBounds);
});

onBeforeUnmount(() => {
  resizeObserver?.disconnect();
  resizeObserver = null;
  window.removeEventListener('resize', pushBounds);
});
</script>

<template>
  <main class="player-workspace">
    <section class="viewer-card">
      <div class="viewer-meta">
        <span><i class="live-dot"></i>MPV · D3D11</span>
        <span class="viewer-meta-divider"></span>
        <span>{{ resolutionText }}</span>
        <span class="viewer-meta-divider"></span>
        <span>{{ player.hasFile ? player.fps.toFixed(3) : '23.810' }} FPS</span>
        <button
          class="layer-button"
          type="button"
          :disabled="!player.hasFile"
          :title="`画面层级：${layerLabel}（点击切换为${layerNext === 'normal' ? '正常' : layerNext === 'bottom' ? '置底' : '隐藏'}）`"
          @click="cycleLayer"
        >
          <AppIcon name="layers" :size="12" />
          {{ layerLabel }}
        </button>
        <button class="meta-action" type="button" title="全屏预览">
          <AppIcon name="expand" :size="13" />
        </button>
      </div>

      <div class="video-frame">
        <div ref="videoSlot" class="video-slot" :class="{ loaded: player.hasFile }">
          <img v-if="!player.hasFile" class="video-poster" :src="poster" :alt="selectedShot?.title ?? '影片预览'" />
          <div v-if="!player.hasFile" class="poster-shade"></div>
          <div v-if="!player.hasFile" class="poster-grade"></div>
          <div v-if="!player.hasFile" class="poster-badge">REFERENCE FRAME</div>
          <button
            v-if="!player.hasFile"
            class="center-play"
            type="button"
            :disabled="busy"
            aria-label="打开并播放影片"
            @click="emit('open')"
          >
            <AppIcon name="play" :size="24" />
          </button>
          <div v-if="!player.hasFile" class="poster-caption">
            <span>{{ selectedShot ? `SHOT ${String(selectedShot.index).padStart(2, '0')}` : 'PLAYER' }}</span>
            <strong>{{ selectedShot?.title ?? '打开影片开始拉片' }}</strong>
          </div>
          <div v-if="player.hasFile && player.layer === 'hidden'" class="layer-placeholder">
            <AppIcon name="layers" :size="24" />
            <strong>画面已隐藏</strong>
            <span>播放与音频继续运行</span>
          </div>
          <div v-else-if="player.hasFile" class="native-player-placeholder">
            <span>LIBMPV SURFACE</span>
          </div>
        </div>
      </div>

    </section>

    <TimelineEditor
      :shots="shots"
      :markers="markers"
      :selected-id="selectedShot?.id ?? null"
      :current-time-ms="displayTimeMs"
      :duration-ms="displayDurationMs"
      :fps="player.hasFile ? player.fps : 500 / 21"
      :audio-waveform="audioWaveform"
      :audio-loading="audioLoading"
      @seek="emit('seek', $event)"
      @select="emit('selectShot', $event)"
      @boundary-change="emit('boundaryChange', $event)"
      @boundary-commit="emit('boundaryCommit', $event)"
    />

    <div v-show="controlsVisible" class="transport">
      <div class="transport-left">
        <button class="transport-button" type="button" title="打开影片" @click="emit('open')">
          <AppIcon name="folder" :size="15" />
        </button>
        <button class="transport-button" type="button" title="上一帧 (←)" @click="emit('step', -1)">
          <AppIcon name="step-back" :size="15" />
        </button>
        <button class="transport-play" type="button" :title="player.paused ? '播放 (空格)' : '暂停 (空格)'" @click="emit('toggle')">
          <AppIcon :name="player.paused ? 'play' : 'pause'" :size="16" />
        </button>
        <button class="transport-button" type="button" title="下一帧 (→)" @click="emit('step', 1)">
          <AppIcon name="step-forward" :size="15" />
        </button>
        <div
          class="volume-control"
          @mouseenter="volumeOpen = true"
          @mouseleave="volumeOpen = false"
          @focusin="volumeOpen = true"
          @focusout="volumeOpen = false"
        >
          <button
            class="transport-button volume-button"
            type="button"
            :title="player.volume === 0 ? '取消静音' : '静音 (M)'"
            @click="volumeOpen = true; emit('toggleMute')"
          >
            <AppIcon :name="player.volume === 0 ? 'muted' : 'volume'" :size="15" />
          </button>
          <div v-show="volumeOpen" class="volume-pop">
            <input
              class="volume-slider"
              type="range"
              min="0"
              max="100"
              step="5"
              aria-label="音量"
              :value="Math.round(player.volume * 100)"
              @input="emit('setVolume', Number(($event.target as HTMLInputElement).value) / 100)"
              @change="emit('setVolume', Number(($event.target as HTMLInputElement).value) / 100)"
            />
            <span class="volume-value">{{ Math.round(player.volume * 100) }}%</span>
          </div>
        </div>
      </div>

      <div class="time-readout">
        <strong>{{ timecode }}</strong>
        <span>/ {{ durationText }}</span>
        <i></i>
        <span>FRAME {{ frameNumber }}</span>
      </div>

      <div class="transport-right">
        <span class="shortcut-hint"><kbd>Space</kbd> 播放</span>
        <span class="shortcut-hint"><kbd>←</kbd><kbd>→</kbd> 逐帧</span>
        <button class="capture-button" type="button" title="截取当前静帧" @click="emit('capture')">
          <AppIcon name="camera" :size="14" />
          截静帧
        </button>
      </div>
    </div>
  </main>
</template>

<style scoped>
.player-workspace {
  display: flex;
  min-width: 0;
  min-height: 0;
  flex-direction: column;
  gap: 0;
}

.workspace-head {
  display: flex;
  min-height: 48px;
  align-items: center;
  justify-content: space-between;
  gap: 18px;
  padding: 0 4px;
}

.project-context {
  display: flex;
  min-width: 0;
  align-items: center;
  gap: 9px;
}

.project-icon {
  display: grid;
  width: 32px;
  height: 32px;
  flex: 0 0 auto;
  border: 1px solid rgba(86, 156, 255, 0.22);
  border-radius: 7px;
  background: linear-gradient(145deg, rgba(86, 156, 255, 0.16), rgba(86, 156, 255, 0.04));
  color: var(--blue);
  place-items: center;
}

.project-copy {
  min-width: 0;
}

.project-title-line {
  display: flex;
  align-items: center;
  gap: 7px;
}

.project-title-line h1 {
  max-width: 420px;
  overflow: hidden;
  margin: 0;
  color: var(--text);
  font-size: 15px;
  font-weight: 650;
  letter-spacing: 0.1px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.demo-badge {
  padding: 2px 5px;
  border: 1px solid rgba(244, 170, 74, 0.26);
  border-radius: 3px;
  background: rgba(244, 170, 74, 0.075);
  color: #dca45d;
  font-size: 8px;
  font-weight: 650;
  letter-spacing: 0.5px;
}

.project-copy p {
  margin: 2px 0 0;
  color: var(--text-faint);
  font-size: 9px;
  letter-spacing: 0.35px;
}

.project-switch {
  display: grid;
  width: 22px;
  height: 22px;
  padding: 0;
  border: 0;
  background: transparent;
  color: var(--text-faint);
  place-items: center;
}

.project-switch:hover {
  color: var(--text);
}

.workspace-actions {
  display: flex;
  flex: 0 0 auto;
  align-items: center;
  gap: 7px;
}

.autosave-status {
  display: flex;
  align-items: center;
  gap: 5px;
  margin-right: 3px;
  color: var(--text-faint);
  font-size: 9px;
}

.autosave-status i {
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: var(--green);
  box-shadow: 0 0 7px rgba(77, 208, 159, 0.35);
}

.button-icon-label {
  display: inline-flex;
  height: 30px;
  align-items: center;
  gap: 6px;
  padding: 0 9px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--surface-2);
  color: var(--text-soft);
  font-size: 10px;
}

.button-icon-label:hover {
  border-color: var(--border-strong);
  background: var(--surface-3);
}

.button-quiet {
  border-color: transparent;
  background: transparent;
  color: var(--text-dim);
}

.icon-button {
  display: grid;
  width: 30px;
  height: 30px;
  padding: 0;
  border: 1px solid transparent;
  border-radius: 6px;
  background: transparent;
  color: var(--text-dim);
  place-items: center;
}

.icon-button:hover {
  border-color: var(--border);
  background: var(--surface-2);
}

.viewer-card {
  display: flex;
  min-height: 0;
  flex: 1 1 auto;
  flex-direction: column;
  overflow: hidden;
  min-height: 360px;
  border: 1px solid var(--border);
  border-radius: 8px 8px 0 0;
  background: var(--bg-deep);
}

.viewer-meta {
  display: flex;
  height: 24px;
  flex: 0 0 auto;
  align-items: center;
  gap: 8px;
  padding: 0 12px;
  border-bottom: 1px solid var(--border);
  color: var(--text-faint);
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.55px;
}

.viewer-meta > span:first-child {
  display: flex;
  align-items: center;
  gap: 5px;
  color: var(--text-muted);
}

.live-dot {
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: var(--green);
  box-shadow: 0 0 6px rgba(77, 208, 159, 0.5);
}

.viewer-meta-divider {
  width: 1px;
  height: 9px;
  background: var(--border);
}

.meta-action {
  display: grid;
  width: 24px;
  height: 24px;
  margin-left: 0;
  padding: 0;
  border: 0;
  border-radius: 4px;
  background: transparent;
  color: var(--text-faint);
  place-items: center;
}

.layer-button {
  display: flex;
  height: 20px;
  align-items: center;
  gap: 4px;
  margin-left: auto;
  padding: 0 6px;
  border: 1px solid rgba(96, 165, 250, 0.2);
  border-radius: 4px;
  background: rgba(30, 58, 95, 0.28);
  color: var(--blue-hi);
  font-size: 9px;
}

.layer-button:hover:not(:disabled) {
  border-color: rgba(96, 165, 250, 0.42);
  background: rgba(30, 58, 95, 0.48);
}

.meta-action:hover {
  background: var(--surface-2);
  color: var(--text);
}

.video-frame {
  display: flex;
  min-height: 0;
  flex: 1;
  align-items: center;
  justify-content: center;
  overflow: hidden;
  padding: 12px;
  background: var(--bg-deep);
}

.video-slot {
  position: relative;
  width: 100%;
  max-width: 100%;
  max-height: 100%;
  aspect-ratio: 16 / 9;
  overflow: hidden;
  border: 1px solid var(--border);
  border-radius: 4px;
  background: #000;
  box-shadow: 0 12px 36px rgba(0, 0, 0, 0.32);
}

.video-slot.loaded {
  background: #000;
}

.video-poster {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.poster-shade {
  position: absolute;
  inset: 0;
  background:
    linear-gradient(90deg, rgba(2, 4, 7, 0.7), transparent 22%, transparent 78%, rgba(2, 4, 7, 0.45)),
    linear-gradient(0deg, rgba(2, 4, 7, 0.86), transparent 40%);
}

.poster-grade {
  position: absolute;
  inset: 0;
  background:
    linear-gradient(145deg, rgba(33, 91, 164, 0.12), transparent 46%),
    rgba(5, 8, 12, 0.08);
  mix-blend-mode: screen;
}

.poster-badge {
  position: absolute;
  top: 13px;
  left: 14px;
  padding: 4px 6px;
  border: 1px solid rgba(210, 225, 241, 0.18);
  border-radius: 3px;
  background: rgba(3, 6, 10, 0.5);
  color: rgba(233, 240, 248, 0.7);
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 1.4px;
  backdrop-filter: blur(5px);
}

.poster-caption {
  position: absolute;
  bottom: 14px;
  left: 15px;
  display: flex;
  flex-direction: column;
  gap: 3px;
  text-shadow: 0 2px 10px rgba(0, 0, 0, 0.7);
}

.poster-caption span {
  color: rgba(177, 201, 230, 0.62);
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 1px;
}

.poster-caption strong {
  color: #f1f4f8;
  font-size: 14px;
  font-weight: 600;
}

.center-play {
  position: absolute;
  top: 50%;
  left: 50%;
  display: grid;
  width: 54px;
  height: 54px;
  padding: 0 0 0 3px;
  border: 1px solid rgba(241, 246, 252, 0.3);
  border-radius: 50%;
  background: rgba(8, 12, 17, 0.56);
  color: #edf3fb;
  place-items: center;
  transform: translate(-50%, -50%);
  backdrop-filter: blur(8px);
  transition:
    background 160ms ease,
    transform 160ms ease;
}

.center-play:hover {
  background: rgba(54, 116, 205, 0.74);
  transform: translate(-50%, -50%) scale(1.04);
}

.native-player-placeholder {
  position: absolute;
  inset: 0;
  display: grid;
  background: #000;
  color: #1d2530;
  font-size: 10px;
  letter-spacing: 2px;
  place-items: center;
}

.layer-placeholder {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-direction: column;
  gap: 7px;
  background:
    radial-gradient(circle at 50% 42%, rgba(59, 130, 246, 0.09), transparent 42%),
    #05080d;
  color: var(--text-faint);
}

.layer-placeholder strong {
  color: var(--text-muted);
  font-size: 12px;
  font-weight: 600;
}

.layer-placeholder span {
  font-size: 9px;
}

.transport {
  position: relative;
  display: grid;
  height: 36px;
  min-height: 36px;
  flex: 0 0 auto;
  grid-template-columns: 1fr auto 1fr;
  align-items: center;
  gap: 16px;
  padding: 0 12px;
  border: 1px solid var(--border);
  border-top: 0;
  border-radius: 0 0 8px 8px;
  background: var(--bg-panel);
}

.transport-left,
.transport-right {
  display: flex;
  align-items: center;
  gap: 4px;
}

.volume-control {
  position: relative;
  display: flex;
  align-items: center;
}

.volume-button {
  position: relative;
}

.volume-pop {
  position: absolute;
  bottom: calc(100% + 8px);
  left: 50%;
  z-index: 30;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 10px;
  border: 1px solid var(--border-strong);
  border-radius: 8px;
  background: var(--bg-panel);
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.35);
  transform: translateX(-50%);
}

.volume-slider {
  width: 120px;
  accent-color: var(--blue);
}

.volume-value {
  min-width: 34px;
  color: var(--text-muted);
  font-size: 12px;
  text-align: right;
}

.transport-right {
  justify-content: flex-end;
}

.transport-button,
.transport-play {
  display: grid;
  width: 28px;
  height: 28px;
  padding: 0;
  border: 1px solid transparent;
  border-radius: 6px;
  background: transparent;
  color: var(--text-dim);
  place-items: center;
}

.transport-button:hover {
  border-color: var(--border);
  background: var(--surface-2);
  color: var(--text);
}

.transport-play {
  margin: 0 4px;
  border-color: transparent;
  background: var(--red);
  color: #fff;
}

.transport-play:hover {
  background: var(--red);
  filter: brightness(1.1);
}

.time-readout {
  display: flex;
  align-items: center;
  gap: 8px;
  color: var(--text-faint);
  font-family: var(--mono);
  font-size: 12px;
  font-variant-numeric: tabular-nums;
  letter-spacing: 0.2px;
}

.time-readout strong {
  color: var(--text-primary);
  font-size: 12px;
  font-weight: 500;
  letter-spacing: 0.5px;
}

.time-readout i {
  width: 1px;
  height: 10px;
  margin: 0 2px;
  background: var(--border);
}

.shortcut-hint {
  display: flex;
  align-items: center;
  gap: 4px;
  margin-right: 4px;
  color: var(--text-faint);
  font-size: 10px;
}

kbd {
  padding: 0 4px;
  border: 1px solid var(--border);
  border-bottom-width: 2px;
  border-radius: 3px;
  background: var(--bg-raised);
  color: var(--text-faint);
  font-family: inherit;
  font-size: 10px;
}

.capture-button {
  display: flex;
  height: 28px;
  align-items: center;
  gap: 6px;
  padding: 0 8px;
  border: 1px solid transparent;
  border-radius: 6px;
  background: var(--bg-raised);
  color: var(--text-secondary);
  font-size: 11px;
}

.capture-button:hover {
  background: var(--bg-hover);
}

@media (max-width: 1260px) {
  .shortcut-hint {
    display: none;
  }

  .project-title-line h1 {
    max-width: 280px;
  }
}
</style>
