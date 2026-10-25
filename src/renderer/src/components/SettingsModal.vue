<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue';
import AppIcon from './AppIcon.vue';
import type { Settings, SettingsSetArgs } from '../../../shared/types';

type PathKey = keyof SettingsSetArgs;
type EnvironmentCheck = { tone: 'success' | 'locked' | 'error'; text: string };
type SettingsDraft = Record<PathKey, string>;

const props = defineProps<{
  open: boolean;
  settings: Settings | null;
  saving: boolean;
  error: string | null;
}>();

const emit = defineEmits<{
  close: [];
  save: [value: SettingsSetArgs];
}>();

const draft = reactive<SettingsDraft>({
  dataRoot: '',
  cacheDir: '',
  exportDir: '',
  stillDir: '',
  proxyCacheDir: '',
  frameCacheDir: '',
  waveformCacheDir: '',
  thumbCacheDir: '',
  exportSubDir: '',
  stillSubDir: '',
});
const browseError = ref<string | null>(null);
const liveSettings = ref<Settings | null>(null);
const checkingEnvironment = ref(false);
const environmentCheck = ref<EnvironmentCheck | null>(null);
const resettingDefaults = ref(false);
const pathItems: Array<{
  key: PathKey;
  title: string;
  description: string;
  icon: string;
  optional?: boolean;
  inheritedFrom?: string;
}> = [
  {
    key: 'dataRoot',
    title: '项目数据目录',
    description: '项目数据库与工程数据根目录',
    icon: 'folder',
  },
  {
    key: 'cacheDir',
    title: '缓存目录',
    description: '抽帧、代理转码和临时分析文件',
    icon: 'panel-right',
  },
  {
    key: 'exportDir',
    title: '导出目录',
    description: '分镜本与术语 JSON 的默认输出根目录',
    icon: 'save',
  },
  {
    key: 'stillDir',
    title: '截图目录',
    description: '静帧 PNG 与 JPEG 缩略图输出根目录',
    icon: 'camera',
  },
  {
    key: 'proxyCacheDir',
    title: '代理缓存目录',
    description: '转码代理视频文件',
    icon: 'layers',
    optional: true,
    inheritedFrom: '缓存根 / proxies',
  },
  {
    key: 'frameCacheDir',
    title: '抽帧缓存目录',
    description: '媒体抽帧与临时图片',
    icon: 'grid',
    optional: true,
    inheritedFrom: '缓存根 / frames',
  },
  {
    key: 'waveformCacheDir',
    title: '波形缓存目录',
    description: '音频包络 JSON 缓存',
    icon: 'chart',
    optional: true,
    inheritedFrom: '缓存根 / audio-waveforms',
  },
  {
    key: 'thumbCacheDir',
    title: '微缩图缓存目录',
    description: '检测结果镜头缩略图',
    icon: 'expand',
    optional: true,
    inheritedFrom: '抽帧缓存 / thumbs',
  },
  {
    key: 'exportSubDir',
    title: '导出子目录',
    description: '项目导出与术语文件的父目录',
    icon: 'save',
    optional: true,
    inheritedFrom: '导出根',
  },
  {
    key: 'stillSubDir',
    title: '静帧子目录',
    description: '项目静帧 PNG 与缩略图的父目录',
    icon: 'camera',
    optional: true,
    inheritedFrom: '静帧根',
  },
];

function fillDraft(settings: Settings): void {
  draft.dataRoot = settings.dataRoot;
  draft.cacheDir = settings.cacheDir;
  draft.exportDir = settings.exportDir;
  draft.stillDir = settings.stillDir;
  draft.proxyCacheDir = settings.proxyCacheDir ?? '';
  draft.frameCacheDir = settings.frameCacheDir ?? '';
  draft.waveformCacheDir = settings.waveformCacheDir ?? '';
  draft.thumbCacheDir = settings.thumbCacheDir ?? '';
  draft.exportSubDir = settings.exportSubDir ?? '';
  draft.stillSubDir = settings.stillSubDir ?? '';
}

function joinDisplayPath(base: string, ...parts: string[]): string {
  const trimmed = base.trim();
  if (!trimmed) return '';
  const separator = trimmed.includes('\\') || /^[A-Za-z]:/u.test(trimmed) ? '\\' : '/';
  return [trimmed.replace(/[\\/]+$/u, ''), ...parts].join(separator);
}

function inheritedPath(key: PathKey): string {
  const cacheRoot = draft.cacheDir.trim();
  const frameRoot = draft.frameCacheDir.trim() || joinDisplayPath(cacheRoot, 'frames');
  switch (key) {
    case 'proxyCacheDir':
      return joinDisplayPath(cacheRoot, 'proxies');
    case 'frameCacheDir':
      return joinDisplayPath(cacheRoot, 'frames');
    case 'waveformCacheDir':
      return joinDisplayPath(cacheRoot, 'audio-waveforms');
    case 'thumbCacheDir':
      return joinDisplayPath(frameRoot, 'thumbs');
    case 'exportSubDir':
      return draft.exportDir.trim();
    case 'stillSubDir':
      return draft.stillDir.trim();
    default:
      return '';
  }
}

function pathPlaceholder(item: (typeof pathItems)[number]): string {
  if (!item.optional) return `选择${item.title}`;
  const inherited = inheritedPath(item.key);
  return inherited ? `继承：${inherited}` : `请先填写${item.inheritedFrom ?? '父目录'}`;
}

async function resetDefaults(): Promise<void> {
  if (resettingDefaults.value || lockedByEnvironment.value) return;
  resettingDefaults.value = true;
  browseError.value = null;
  try {
    const result = await window.api.app.getInfo();
    if (!result.ok) {
      browseError.value = result.error.message;
      return;
    }
    const dataRoot = joinDisplayPath(result.data.appDataPath, 'lapian');
    draft.dataRoot = dataRoot;
    draft.cacheDir = dataRoot;
    draft.exportDir = joinDisplayPath(dataRoot, 'projects');
    draft.stillDir = joinDisplayPath(dataRoot, 'projects');
    draft.proxyCacheDir = '';
    draft.frameCacheDir = '';
    draft.waveformCacheDir = '';
    draft.thumbCacheDir = '';
    draft.exportSubDir = '';
    draft.stillSubDir = '';
    environmentCheck.value = null;
  } finally {
    resettingDefaults.value = false;
  }
}

const activeSettings = computed(() => liveSettings.value ?? props.settings);
const dataRootChanged = computed(
  () => Boolean(activeSettings.value && draft.dataRoot.trim() !== activeSettings.value.dataRoot),
);
const cacheDirChanged = computed(
  () => Boolean(activeSettings.value && draft.cacheDir.trim() !== activeSettings.value.cacheDir),
);
const storageRootChanged = computed(() => dataRootChanged.value || cacheDirChanged.value);
const lockedByEnvironment = computed(() => activeSettings.value?.environmentOverride === true);

watch(
  () => [props.open, props.settings] as const,
  ([open, settings]) => {
    if (!open || !settings) return;
    fillDraft(settings);
    liveSettings.value = settings;
    browseError.value = null;
    environmentCheck.value = null;
  },
  { immediate: true },
);

async function choosePath(key: PathKey): Promise<void> {
  if (lockedByEnvironment.value) return;
  const item = pathItems.find((candidate) => candidate.key === key);
  const result = await window.api.settings.chooseDirectory({
    title: `选择${item?.title ?? '目录'}`,
    defaultPath: draft[key] || undefined,
  });
  if (!result.ok) {
    browseError.value = result.error.message;
    return;
  }
  if (result.data) {
    draft[key] = result.data;
    browseError.value = null;
  }
}

async function checkEnvironment(): Promise<void> {
  if (checkingEnvironment.value) return;
  checkingEnvironment.value = true;
  environmentCheck.value = null;
  try {
    const result = await window.api.settings.get();
    if (!result.ok) {
      environmentCheck.value = { tone: 'error', text: result.error.message };
      return;
    }
    liveSettings.value = result.data;
    if (result.data.environmentOverride) {
      environmentCheck.value = {
        tone: 'locked',
        text: '仍被 DSH_DATA_ROOT 锁定，请按上述指引解除后完全退出并重新启动应用。',
      };
      return;
    }
    fillDraft(result.data);
    browseError.value = null;
    environmentCheck.value = {
      tone: 'success',
      text: '已解除锁定，可以修改路径了。',
    };
  } catch (error) {
    environmentCheck.value = {
      tone: 'error',
      text: error instanceof Error ? error.message : String(error),
    };
  } finally {
    checkingEnvironment.value = false;
  }
}

function submit(): void {
  if (props.saving || lockedByEnvironment.value) return;
  const rootPaths = {
    dataRoot: draft.dataRoot.trim(),
    cacheDir: draft.cacheDir.trim(),
    exportDir: draft.exportDir.trim(),
    stillDir: draft.stillDir.trim(),
  };
  if (Object.values(rootPaths).some((path) => !path)) return;
  const value: SettingsSetArgs = { ...rootPaths };
  for (const key of [
    'proxyCacheDir',
    'frameCacheDir',
    'waveformCacheDir',
    'thumbCacheDir',
    'exportSubDir',
    'stillSubDir',
  ] as const) {
    const path = draft[key].trim();
    if (path) value[key] = path;
  }
  emit('save', value);
}
</script>

<template>
  <transition name="modal">
    <div
      v-if="open"
      class="modal-mask"
      @pointerdown.self="!saving && !checkingEnvironment && !resettingDefaults
        && emit('close')"
    >
      <form class="settings-modal" @submit.prevent="submit">
        <header class="modal-head">
          <div>
            <p>WORKSPACE SETTINGS</p>
            <h2>设置</h2>
            <span>路径保存后立即生效</span>
          </div>
          <button
            type="button"
            :disabled="saving || checkingEnvironment || resettingDefaults"
            aria-label="关闭"
            @click="emit('close')"
          >
            ×
          </button>
        </header>

        <div v-if="lockedByEnvironment" class="environment-note">
          <strong>路径被环境变量锁定</strong>
          <p>
            当前路径由 <code>DSH_DATA_ROOT</code> 固定，数据根 =
            <code>{{ activeSettings?.dataRoot }}</code>，设置界面暂不可修改。
          </p>
          <ol>
            <li>
              <b>命令行或启动脚本</b>
              <span>
                CMD 使用 <code>set DSH_DATA_ROOT=</code>；PowerShell 使用
                <code>Remove-Item Env:DSH_DATA_ROOT</code>；Git Bash / Shell 使用
                <code>export DSH_DATA_ROOT=</code> 或 <code>unset DSH_DATA_ROOT</code>。
                再完全退出并重新启动应用。
              </span>
            </li>
            <li>
              <b>系统级环境变量</b>
              <span>
                打开“控制面板 → 系统 → 高级系统设置 → 环境变量”，删除用户或系统变量中的
                <code>DSH_DATA_ROOT</code>，然后重新启动应用。
              </span>
            </li>
          </ol>
          <span>若不清楚来源，请检查开发调试脚本或 .bat / .ps1 启动文件。</span>
          <button type="button" :disabled="checkingEnvironment" @click="checkEnvironment">
            {{ checkingEnvironment ? '检测中…' : '检测是否仍被锁定' }}
          </button>
        </div>
        <div
          v-if="environmentCheck"
          class="environment-check"
          :class="environmentCheck.tone"
        >
          {{ environmentCheck.text }}
        </div>

        <section class="path-list">
          <label
            v-for="item in pathItems"
            :key="item.key"
            class="path-field"
            :class="{ inherited: item.optional && !draft[item.key].trim() }"
          >
            <span class="path-copy">
              <span class="path-icon"><AppIcon :name="item.icon" :size="14" /></span>
              <span>
                <strong>{{ item.title }}</strong>
                <small>{{ item.description }}</small>
                <small v-if="item.optional" class="inherit-hint">
                  {{
                    draft[item.key].trim()
                      ? '已设置独立目录'
                      : `继承：${inheritedPath(item.key) || item.inheritedFrom}`
                  }}
                </small>
              </span>
            </span>
            <span class="path-input">
              <input
                v-model="draft[item.key]"
                :disabled="lockedByEnvironment || saving || resettingDefaults"
                spellcheck="false"
                :placeholder="pathPlaceholder(item)"
              />
              <button
                type="button"
                :disabled="lockedByEnvironment || saving || resettingDefaults"
                @click="choosePath(item.key)"
              >
                浏览…
              </button>
            </span>
          </label>
        </section>

        <div v-if="storageRootChanged" class="migration-warning">
          {{
            dataRootChanged
              ? '数据根目录变更后，会先检查旧项目并询问是否迁移。'
              : '缓存根目录变更后，旧缓存不会自动迁移，新缓存将写入新位置。'
          }}
        </div>
        <div v-if="browseError || error" class="settings-error">{{ browseError || error }}</div>

        <footer>
          <span>导出、截图和缓存目录会按项目 ID 自动建立子目录。</span>
          <button
            type="button"
            :disabled="saving || checkingEnvironment || resettingDefaults"
            @click="resetDefaults"
          >
            {{ resettingDefaults ? '读取默认值…' : '还原默认' }}
          </button>
          <button
            type="button"
            :disabled="saving || checkingEnvironment || resettingDefaults"
            @click="emit('close')"
          >
            取消
          </button>
          <button
            class="primary"
            type="submit"
            :disabled="saving || lockedByEnvironment || checkingEnvironment || resettingDefaults"
          >
            {{ saving ? '保存中…' : '保存设置' }}
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
  padding: 16px;
  background: rgba(2, 6, 23, 0.66);
  place-items: center;
  z-index: 90;
}

.settings-modal {
  display: flex;
  width: 720px;
  max-width: calc(100vw - 32px);
  max-height: calc(100vh - 32px);
  flex-direction: column;
  overflow: hidden;
  border: 1px solid var(--border);
  border-radius: 10px;
  background: var(--bg-panel);
  box-shadow: 0 28px 90px rgba(0, 0, 0, 0.52);
}

.modal-head {
  display: flex;
  flex: 0 0 auto;
  align-items: flex-start;
  justify-content: space-between;
  padding: 16px;
  border-bottom: 1px solid var(--border);
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

.modal-head span {
  display: block;
  margin-top: 4px;
  color: var(--text-muted);
  font-size: 11px;
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

.modal-head > button:hover:not(:disabled) {
  background: var(--bg-hover);
}

.environment-note,
.migration-warning,
.settings-error {
  margin: 12px 16px 0;
  padding: 9px 10px;
  border: 1px solid rgba(245, 158, 11, 0.28);
  border-radius: 6px;
  background: rgba(245, 158, 11, 0.07);
  color: var(--text-muted);
  font-size: 10px;
  line-height: 1.55;
}

.environment-note {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.environment-note strong {
  color: var(--gold);
  font-size: 11px;
}

.environment-note p,
.environment-note ol {
  margin: 3px 0 0;
}

.environment-note p,
.environment-note li,
.environment-note > span {
  line-height: 1.6;
}

.environment-note ol {
  display: flex;
  flex-direction: column;
  gap: 5px;
  padding-left: 18px;
}

.environment-note li {
  padding-left: 2px;
}

.environment-note li b,
.environment-note li span {
  display: block;
}

.environment-note li b {
  color: var(--text-secondary);
  font-size: 10px;
}

.environment-note code {
  padding: 1px 4px;
  border: 1px solid rgba(245, 158, 11, 0.24);
  border-radius: 3px;
  background: rgba(15, 23, 42, 0.55);
  color: #fcd34d;
  font-family: var(--mono);
  font-size: 9px;
  overflow-wrap: anywhere;
  user-select: text;
}

.environment-note > button {
  width: fit-content;
  height: 27px;
  margin-top: 2px;
  padding: 0 10px;
  border: 1px solid rgba(245, 158, 11, 0.35);
  border-radius: 5px;
  background: rgba(245, 158, 11, 0.12);
  color: var(--gold);
  font-size: 10px;
}

.environment-note > button:hover:not(:disabled) {
  background: rgba(245, 158, 11, 0.2);
}

.environment-check {
  margin: 8px 16px 0;
  padding: 8px 10px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--bg-raised);
  color: var(--text-muted);
  font-size: 10px;
  line-height: 1.55;
}

.environment-check.success {
  border-color: rgba(34, 197, 94, 0.35);
  background: rgba(34, 197, 94, 0.09);
  color: #86efac;
}

.environment-check.locked {
  border-color: rgba(245, 158, 11, 0.32);
  background: rgba(245, 158, 11, 0.09);
  color: var(--gold);
}

.environment-check.error {
  border-color: rgba(239, 68, 68, 0.38);
  background: rgba(239, 68, 68, 0.09);
  color: #fca5a5;
}

.migration-warning {
  border-color: rgba(225, 29, 72, 0.3);
  background: rgba(225, 29, 72, 0.08);
  color: #fda4af;
}

.settings-error {
  border-color: rgba(239, 68, 68, 0.4);
  background: rgba(239, 68, 68, 0.09);
  color: #fca5a5;
}

.path-list {
  display: flex;
  min-height: 0;
  flex: 1;
  flex-direction: column;
  gap: 8px;
  overflow-y: auto;
  padding: 14px 16px;
}

.path-field {
  display: flex;
  flex-direction: column;
  gap: 7px;
  padding: 10px;
  border: 1px solid rgba(71, 85, 105, 0.48);
  border-radius: 7px;
  background: rgba(15, 23, 42, 0.42);
}

.path-copy {
  display: flex;
  align-items: center;
  gap: 8px;
}

.path-copy > span:last-child {
  display: flex;
  min-width: 0;
  flex-direction: column;
  gap: 2px;
}

.path-copy strong {
  color: var(--text-secondary);
  font-size: 11px;
  font-weight: 600;
}

.path-copy small {
  color: var(--text-faint);
  font-size: 9px;
}

.path-copy .inherit-hint {
  color: var(--text-muted);
  font-family: var(--mono);
  overflow-wrap: anywhere;
}

.path-field.inherited {
  border-color: rgba(59, 130, 246, 0.28);
  background: rgba(59, 130, 246, 0.035);
}

.path-field.inherited .path-input input::placeholder {
  color: rgba(148, 163, 184, 0.72);
}

.path-icon {
  display: grid;
  width: 26px;
  height: 26px;
  flex: 0 0 auto;
  border-radius: 5px;
  background: var(--bg-raised);
  color: var(--blue-hi);
  place-items: center;
}

.path-input {
  display: flex;
  gap: 6px;
}

.path-input input {
  min-width: 0;
  height: 30px;
  flex: 1;
  padding: 0 9px;
  border: 1px solid var(--border);
  border-radius: 5px;
  outline: 0;
  background: var(--bg-raised);
  color: var(--text-secondary);
  font-family: var(--mono);
  font-size: 10px;
  user-select: text;
}

.path-input input:focus {
  border-color: var(--blue-hi);
}

.path-input button,
footer button {
  height: 30px;
  padding: 0 10px;
  border: 0;
  border-radius: 5px;
  background: var(--bg-raised);
  color: var(--text-secondary);
  font-size: 10px;
}

.path-input button:hover:not(:disabled),
footer button:hover:not(:disabled) {
  background: var(--bg-hover);
}

footer {
  display: flex;
  flex: 0 0 auto;
  align-items: center;
  gap: 8px;
  padding: 12px 16px;
  border-top: 1px solid var(--border);
}

footer span {
  flex: 1;
  color: var(--text-faint);
  font-size: 9px;
}

footer button.primary {
  background: var(--red);
  color: #fff;
  font-weight: 600;
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
