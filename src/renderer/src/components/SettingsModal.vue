<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue';
import AppIcon from './AppIcon.vue';
import type { Settings, SettingsSetArgs } from '../../../shared/types';

type PathKey = keyof SettingsSetArgs;
type EnvironmentCheck = { tone: 'success' | 'locked' | 'error'; text: string };

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

const draft = reactive<SettingsSetArgs>({
  dataRoot: '',
  cacheDir: '',
  exportDir: '',
  stillDir: '',
});
const browseError = ref<string | null>(null);
const liveSettings = ref<Settings | null>(null);
const checkingEnvironment = ref(false);
const environmentCheck = ref<EnvironmentCheck | null>(null);
const pathItems: Array<{
  key: PathKey;
  title: string;
  description: string;
  icon: 'folder' | 'save' | 'camera' | 'panel-right';
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
];

const activeSettings = computed(() => liveSettings.value ?? props.settings);
const dataRootChanged = computed(
  () => Boolean(activeSettings.value && draft.dataRoot.trim() !== activeSettings.value.dataRoot),
);
const lockedByEnvironment = computed(() => activeSettings.value?.environmentOverride === true);

watch(
  () => [props.open, props.settings] as const,
  ([open, settings]) => {
    if (!open || !settings) return;
    draft.dataRoot = settings.dataRoot;
    draft.cacheDir = settings.cacheDir;
    draft.exportDir = settings.exportDir;
    draft.stillDir = settings.stillDir;
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
    draft.dataRoot = result.data.dataRoot;
    draft.cacheDir = result.data.cacheDir;
    draft.exportDir = result.data.exportDir;
    draft.stillDir = result.data.stillDir;
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
  const value = {
    dataRoot: draft.dataRoot.trim(),
    cacheDir: draft.cacheDir.trim(),
    exportDir: draft.exportDir.trim(),
    stillDir: draft.stillDir.trim(),
  };
  if (Object.values(value).some((path) => !path)) return;
  emit('save', value);
}
</script>

<template>
  <transition name="modal">
    <div
      v-if="open"
      class="modal-mask"
      @pointerdown.self="!saving && !checkingEnvironment
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
            :disabled="saving || checkingEnvironment"
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
          <label v-for="item in pathItems" :key="item.key" class="path-field">
            <span class="path-copy">
              <span class="path-icon"><AppIcon :name="item.icon" :size="14" /></span>
              <span>
                <strong>{{ item.title }}</strong>
                <small>{{ item.description }}</small>
              </span>
            </span>
            <span class="path-input">
              <input
                v-model="draft[item.key]"
                :disabled="lockedByEnvironment || saving"
                spellcheck="false"
                :placeholder="`选择${item.title}`"
              />
              <button
                type="button"
                :disabled="lockedByEnvironment || saving"
                @click="choosePath(item.key)"
              >
                浏览…
              </button>
            </span>
          </label>
        </section>

        <div v-if="dataRootChanged" class="migration-warning">
          保存后会先检查旧目录中的项目，由你选择迁移、跳过或取消本次目录更改。
        </div>
        <div v-if="browseError || error" class="settings-error">{{ browseError || error }}</div>

        <footer>
          <span>导出、截图和缓存目录会按项目 ID 自动建立子目录。</span>
          <button type="button" :disabled="saving || checkingEnvironment" @click="emit('close')">取消</button>
          <button
            class="primary"
            type="submit"
            :disabled="saving || lockedByEnvironment || checkingEnvironment"
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
