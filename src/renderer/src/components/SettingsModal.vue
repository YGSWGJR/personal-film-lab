<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue';
import AppIcon from './AppIcon.vue';
import type { Settings, SettingsSetArgs } from '../../../shared/types';

type PathKey = keyof SettingsSetArgs;

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

const dataRootChanged = computed(
  () => Boolean(props.settings && draft.dataRoot.trim() !== props.settings.dataRoot),
);
const lockedByEnvironment = computed(() => props.settings?.environmentOverride === true);

watch(
  () => [props.open, props.settings] as const,
  ([open, settings]) => {
    if (!open || !settings) return;
    draft.dataRoot = settings.dataRoot;
    draft.cacheDir = settings.cacheDir;
    draft.exportDir = settings.exportDir;
    draft.stillDir = settings.stillDir;
    browseError.value = null;
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
    <div v-if="open" class="modal-mask" @pointerdown.self="!saving && emit('close')">
      <form class="settings-modal" @submit.prevent="submit">
        <header class="modal-head">
          <div>
            <p>WORKSPACE SETTINGS</p>
            <h2>设置</h2>
            <span>路径保存后立即生效</span>
          </div>
          <button type="button" :disabled="saving" aria-label="关闭" @click="emit('close')">×</button>
        </header>

        <div v-if="lockedByEnvironment" class="environment-note">
          <strong>环境变量覆盖中</strong>
          <span>检测到 `DSH_DATA_ROOT`，本会话的路径设置由环境变量固定。</span>
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
          更改数据根目录后，现有项目数据不会自动迁移；新项目将写入新位置。
        </div>
        <div v-if="browseError || error" class="settings-error">{{ browseError || error }}</div>

        <footer>
          <span>导出、截图和缓存目录会按项目 ID 自动建立子目录。</span>
          <button type="button" :disabled="saving" @click="emit('close')">取消</button>
          <button class="primary" type="submit" :disabled="saving || lockedByEnvironment">
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
