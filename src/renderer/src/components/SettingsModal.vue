<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue';
import AppIcon from './AppIcon.vue';
import type {
  AiMcpStatus,
  AiProviderConfig,
  LocalAiStatus,
  ProxyTier,
  Settings,
  SettingsSetArgs,
} from '../../../shared/types';

type PathKey = Exclude<
  keyof SettingsSetArgs,
  'proxyTier' | 'confirmUserContent' | 'timeline' | 'recognition' | 'ai' | 'shortcuts'
>;
type EnvironmentCheck = { tone: 'success' | 'locked' | 'error'; text: string };
type SettingsDraft = Record<PathKey, string>;

const props = defineProps<{
  open: boolean;
  settings: Settings | null;
  saving: boolean;
  error: string | null;
  mcpStatus: AiMcpStatus | null;
  mcpBusy: boolean;
}>();

const emit = defineEmits<{
  close: [];
  save: [value: SettingsSetArgs];
  toggleMcp: [];
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
const proxyTier = ref<ProxyTier>('540p');
/** S36-1b：删除用户内容前二次确认，默认开启（与主进程 defaultSettings 对齐） */
const confirmUserContent = ref(true);
const splitShortcut = ref('Ctrl+K');
const mergeShortcut = ref('Ctrl+Shift+G');
/** S36-2：识别引擎与 AI 配置草稿 */
const recognitionEngine = ref<'ai' | 'opencv'>('ai');
const aiProvider = ref<'local' | 'openai-compatible' | 'mock'>('local');
const aiProviders = ref<AiProviderConfig[]>([]);
const activeProviderId = ref('');
const providerKeyDrafts = reactive<Record<string, string>>({});
const providerClearKeys = reactive<Record<string, boolean>>({});
const manualModelDraft = ref('');
const localAiStatus = ref<LocalAiStatus | null>(null);
const localAiFallback = ref(true);
const activeProvider = computed(
  () => aiProviders.value.find((item) => item.id === activeProviderId.value) ?? null,
);
const aiAgentEndpoint = ref('');
const aiSegmentSeconds = ref(600);
const aiTimeoutSeconds = ref(900);
const aiMaxRetries = ref(3);
const aiProbeState = ref<{ tone: 'idle' | 'busy' | 'success' | 'error'; text: string }>({
  tone: 'idle',
  text: '',
});
const proxyTierOptions = [
  { value: '360p', label: '360p', hint: '最快' },
  { value: '540p', label: '540p', hint: '均衡' },
  { value: '720p', label: '720p', hint: '更清晰' },
] as const;
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
  proxyTier.value = settings.proxyTier ?? '540p';
  confirmUserContent.value = settings.confirmUserContent ?? true;
  recognitionEngine.value = settings.recognition?.engine ?? 'ai';
  splitShortcut.value = settings.shortcuts?.split ?? 'Ctrl+K';
  mergeShortcut.value = settings.shortcuts?.merge ?? 'Ctrl+Shift+G';
  aiProvider.value = settings.ai?.provider ?? 'openai-compatible';
  const sourceProviders = (settings.ai?.providers ?? []).map((item) => ({
    ...item,
    models: [...(item.models ?? [])],
  }));
  if (sourceProviders.length === 0 && (settings.ai?.baseUrl || settings.ai?.apiKey)) {
    sourceProviders.push({
      id: 'legacy',
      name: '默认供应商',
      note: '由旧配置自动迁移',
      baseUrl: settings.ai?.baseUrl ?? '',
      apiKey: settings.ai?.apiKey ?? '',
      models: [],
    });
  }
  aiProviders.value = sourceProviders;
  activeProviderId.value = sourceProviders.some(
    (item) => item.id === settings.ai?.activeProviderId,
  )
    ? settings.ai?.activeProviderId ?? ''
    : sourceProviders[0]?.id ?? '';
  for (const provider of sourceProviders) {
    providerKeyDrafts[provider.id] = '';
    providerClearKeys[provider.id] = false;
  }
  manualModelDraft.value = '';
  localAiFallback.value = settings.ai?.fallbackToOpenCv !== false;
  void refreshLocalAiStatus();
  aiAgentEndpoint.value = settings.ai?.agentEndpoint ?? '';
  aiSegmentSeconds.value = settings.ai?.segmentSeconds ?? 600;
  aiTimeoutSeconds.value = settings.ai?.timeoutSeconds ?? 900;
  aiMaxRetries.value = settings.ai?.maxRetriesPerSegment ?? 3;
  aiProbeState.value = { tone: 'idle', text: '' };
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
    proxyTier.value = '540p';
    confirmUserContent.value = true;
    splitShortcut.value = 'Ctrl+K';
    mergeShortcut.value = 'Ctrl+Shift+G';
    recognitionEngine.value = 'ai';
    aiProvider.value = 'openai-compatible';
    aiProviders.value = [];
    activeProviderId.value = '';
    for (const key of Object.keys(providerKeyDrafts)) delete providerKeyDrafts[key];
    for (const key of Object.keys(providerClearKeys)) delete providerClearKeys[key];
    manualModelDraft.value = '';
    aiAgentEndpoint.value = '';
    aiSegmentSeconds.value = 600;
    aiTimeoutSeconds.value = 900;
    aiMaxRetries.value = 3;
    aiProbeState.value = { tone: 'idle', text: '' };
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

function addProvider(): void {
  const id = `prov-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  aiProviders.value = [
    ...aiProviders.value,
    {
      id,
      name: `供应商 ${aiProviders.value.length + 1}`,
      baseUrl: '',
      apiKey: '',
      models: [],
      model: '',
    },
  ];
  activeProviderId.value = id;
  providerKeyDrafts[id] = '';
  providerClearKeys[id] = false;
  manualModelDraft.value = '';
  aiProbeState.value = { tone: 'idle', text: '' };
}

function selectProvider(id: string): void {
  activeProviderId.value = id;
  manualModelDraft.value = '';
  aiProbeState.value = { tone: 'idle', text: '' };
}

function removeProvider(id: string): void {
  const index = aiProviders.value.findIndex((item) => item.id === id);
  if (index < 0) return;
  aiProviders.value = aiProviders.value.filter((item) => item.id !== id);
  delete providerKeyDrafts[id];
  delete providerClearKeys[id];
  if (activeProviderId.value === id) {
    activeProviderId.value = aiProviders.value[0]?.id ?? '';
  }
  manualModelDraft.value = '';
}

function currentProviderKeyDraft(provider: AiProviderConfig): string {
  return providerKeyDrafts[provider.id]?.trim() ?? '';
}

function onProviderKeyInput(provider: AiProviderConfig, event: Event): void {
  providerKeyDrafts[provider.id] = (event.target as HTMLInputElement).value;
  if (providerKeyDrafts[provider.id].trim()) providerClearKeys[provider.id] = false;
}

async function fetchModels(): Promise<void> {
  const provider = activeProvider.value;
  if (!provider || aiProbeState.value.tone === 'busy') return;
  aiProbeState.value = { tone: 'busy', text: '获取模型列表…' };
  const result = await window.api.ai.listModels({
    providerId: provider.id,
    baseUrl: provider.baseUrl.trim(),
    apiKey: currentProviderKeyDraft(provider) || undefined,
  });
  if (!result.ok) {
    aiProbeState.value = { tone: 'error', text: result.error.message };
    return;
  }
  if (!result.data.ok) {
    aiProbeState.value = {
      tone: 'error',
      text: result.data.error?.message ?? '获取模型列表失败',
    };
    return;
  }
  const merged = [...new Set([...(provider.models ?? []), ...(result.data.models ?? [])])];
  provider.models = merged;
  aiProbeState.value = {
    tone: 'success',
    text: `已获取 ${result.data.models?.length ?? 0} 个模型`,
  };
}

function addManualModel(): void {
  const provider = activeProvider.value;
  const model = manualModelDraft.value.trim();
  if (!provider || !model) return;
  provider.models = [...new Set([...(provider.models ?? []), model])];
  if (!provider.model) provider.model = model;
  manualModelDraft.value = '';
}

function removeModel(model: string): void {
  const provider = activeProvider.value;
  if (!provider) return;
  provider.models = (provider.models ?? []).filter((item) => item !== model);
  if (provider.model === model) provider.model = '';
}

async function probeAiProvider(): Promise<void> {
  const provider = activeProvider.value;
  if (!provider) {
    aiProbeState.value = { tone: 'error', text: '请先添加供应商' };
    return;
  }
  if (aiProbeState.value.tone === 'busy') return;
  aiProbeState.value = { tone: 'busy', text: '探测中…' };
  const result = await window.api.ai.probeProvider({
    providerId: provider.id,
    baseUrl: provider.baseUrl.trim(),
    apiKey: currentProviderKeyDraft(provider) || undefined,
  });
  if (!result.ok) {
    aiProbeState.value = { tone: 'error', text: result.error.message };
    return;
  }
  if (result.data.ok && result.data.supportsNativeVideo) {
    aiProbeState.value = {
      tone: 'success',
      text: `支持原生视频输入 · 模型 ${result.data.model ?? '未知'}`,
    };
  } else {
    aiProbeState.value = {
      tone: 'error',
      text: result.data.error?.message ?? '端点不支持原生视频输入，请更换',
    };
  }
}

/**
 * S37：点 X / 遮罩退出时，若有未保存的供应商/Key 草稿，先尝试保存再关闭。
 * 保存校验失败时停留在设置面板并显示错误；底部「取消」仍表示放弃草稿。
 */
function requestClose(): void {
  if (props.saving) return;
  if (lockedByEnvironment.value) {
    emit('close');
    return;
  }
  submit();
}

async function refreshLocalAiStatus(): Promise<void> {
  try {
    const result = await window.api.ai.getLocalStatus();
    localAiStatus.value = result.ok ? result.data : null;
    if (!result.ok) browseError.value = result.error.message;
  } catch (error) {
    localAiStatus.value = null;
    browseError.value = error instanceof Error ? error.message : String(error);
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
  value.proxyTier = proxyTier.value;
  value.confirmUserContent = confirmUserContent.value;
  value.recognition = { engine: recognitionEngine.value };
  const splitKey = splitShortcut.value.trim();
  const mergeKey = mergeShortcut.value.trim();
  if (!splitKey || !mergeKey || splitKey.toLowerCase() === mergeKey.toLowerCase()) {
    browseError.value = '切分与合并快捷键不能为空或重复。';
    return;
  }
  value.shortcuts = { split: splitKey, merge: mergeKey };
  const aiValue: NonNullable<SettingsSetArgs['ai']> = {
    provider: 'local',
    providers: [],
    activeProviderId: '',
    baseUrl: '',
    apiKey: '',
    agentEndpoint: aiAgentEndpoint.value.trim(),
    segmentSeconds: Number(aiSegmentSeconds.value) || 600,
    timeoutSeconds: Number(aiTimeoutSeconds.value) || 900,
    maxRetriesPerSegment: Number(aiMaxRetries.value) || 3,
    enabled: true,
    fallbackToOpenCv: localAiFallback.value,
    localBatchSize: 4,
  };
  value.ai = aiValue;
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
        && requestClose()"
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
            @click="requestClose"
          >
            ×
          </button>
        </header>

        <div class="settings-body">
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

        <section class="proxy-tier-section">
          <div class="tier-copy">
            <strong>代理档位</strong>
            <small>后台代理分辨率越高越清晰，同时占用更多转码时间。</small>
          </div>
          <div class="tier-options">
            <button
              v-for="option in proxyTierOptions"
              :key="option.value"
              type="button"
              :class="{ active: proxyTier === option.value }"
              :disabled="lockedByEnvironment || saving || resettingDefaults"
              @click="proxyTier = option.value"
            >
              <strong>{{ option.label }}</strong>
              <small>{{ option.hint }}</small>
            </button>
          </div>
        </section>

        <section class="ai-section local-ai-section">
          <div class="ai-head">
            <strong>本地镜头理解</strong>
            <small>画面分析完全在本机执行，不上传视频、代理或 API Key。</small>
          </div>
          <div class="ai-engine-row">
            <span>识别流程</span>
            <button
              type="button"
              class="ai-toggle"
              :class="{ active: recognitionEngine === 'ai' }"
              :disabled="saving || resettingDefaults"
              @click="recognitionEngine = 'ai'"
            >
              本地 Qwen3-VL
            </button>
            <button
              type="button"
              class="ai-toggle"
              :class="{ active: recognitionEngine === 'opencv' }"
              :disabled="saving || resettingDefaults"
              @click="recognitionEngine = 'opencv'"
            >
              OpenCV（备用）
            </button>
          </div>
          <div class="local-ai-card" :class="{ unavailable: localAiStatus && !localAiStatus.available }">
            <div>
              <strong>Qwen3-VL 8B · W4A8</strong>
              <small>内置视觉模型 · 每批 4 帧 · 8GB 显存优化</small>
            </div>
            <span>{{ localAiStatus?.available ? '环境就绪' : '环境未就绪' }}</span>
          </div>
          <p class="local-ai-path">
            {{ localAiStatus?.error || localAiStatus?.modelPath || '正在检查本地模型环境…' }}
          </p>
          <button
            type="button"
            class="local-ai-fallback"
            :class="{ active: localAiFallback }"
            :disabled="saving || resettingDefaults"
            @click="localAiFallback = !localAiFallback"
          >
            {{ localAiFallback ? '本地模型失败时自动保留 OpenCV 结果' : '本地模型失败时停止任务' }}
          </button>
          <small class="ai-hint">本地模型负责景别、机位、运镜、光线、主体和画面描述；OpenCV 仍负责镜头切点。</small>
        </section>

        <section hidden class="ai-section legacy-ai-section">
          <div class="ai-head">
            <strong>AI 镜头识别</strong>
            <small>可维护多个供应商；同一时间一个激活供应商生效。Mock 仅用于自测，不进列表。</small>
          </div>
          <div class="ai-engine-row">
            <span>识别引擎</span>
            <button
              type="button"
              class="ai-toggle"
              :class="{ active: recognitionEngine === 'ai' }"
              :disabled="saving || resettingDefaults"
              @click="recognitionEngine = 'ai'"
            >
              AI 全接管
            </button>
            <button
              type="button"
              class="ai-toggle"
              :class="{ active: recognitionEngine === 'opencv' }"
              :disabled="saving || resettingDefaults"
              @click="recognitionEngine = 'opencv'"
            >
              OpenCV（旧）
            </button>
            <button
              type="button"
              class="ai-toggle"
              :class="{ active: aiProvider === 'mock' }"
              :disabled="saving || resettingDefaults"
              @click="aiProvider = aiProvider === 'mock' ? 'openai-compatible' : 'mock'"
            >
              测试 Mock
            </button>
          </div>

          <div class="provider-list">
            <button
              v-for="provider in aiProviders"
              :key="provider.id"
              type="button"
              class="provider-chip"
              :class="{ active: provider.id === activeProviderId }"
              :disabled="saving || resettingDefaults"
              @click="selectProvider(provider.id)"
            >
              <span>{{ provider.name || '未命名供应商' }}</span>
              <em v-if="provider.id === activeProviderId">当前</em>
            </button>
            <button
              class="provider-add"
              type="button"
              :disabled="saving || resettingDefaults"
              @click="addProvider"
            >
              + 添加供应商
            </button>
          </div>

          <template v-if="activeProvider">
            <label class="ai-field">
              <span>名称 *</span>
              <input v-model="activeProvider.name" spellcheck="false" placeholder="例如：豆包方舟 / 公司账号" />
            </label>
            <label class="ai-field">
              <span>备注</span>
              <input v-model="activeProvider.note" spellcheck="false" placeholder="例如：公司专用账号" />
            </label>
            <label class="ai-field">
              <span>官网链接</span>
              <input v-model="activeProvider.homeUrl" spellcheck="false" placeholder="https://example.com (可选)" />
            </label>
            <label class="ai-field">
              <span>API Key（safeStorage 加密保存）</span>
              <input
                v-model="providerKeyDrafts[activeProvider.id]"
                type="password"
                spellcheck="false"
                :placeholder="activeProvider.apiKey ? '已保存（留空保持不变）' : '未配置'"
                @input="onProviderKeyInput(activeProvider, $event)"
              />
            </label>
            <div class="ai-key-actions">
              <button
                type="button"
                :disabled="saving || resettingDefaults"
                @click="providerClearKeys[activeProvider.id] = true; providerKeyDrafts[activeProvider.id] = ''"
              >
                {{ providerClearKeys[activeProvider.id] ? '已标记清除（保存后生效）' : '清除已存 Key' }}
              </button>
            </div>
            <label class="ai-field">
              <span>API 请求地址 *</span>
              <input
                v-model="activeProvider.baseUrl"
                spellcheck="false"
                placeholder="https://your-api-endpoint.com/v1"
              />
            </label>

            <div class="ai-models">
              <div class="ai-models-head">
                <strong>模型列表</strong>
                <button
                  type="button"
                  :disabled="saving || aiProbeState.tone === 'busy'"
                  @click="fetchModels"
                >
                  获取模型列表
                </button>
              </div>
              <div class="ai-model-add">
                <input
                  v-model="manualModelDraft"
                  spellcheck="false"
                  placeholder="手动输入模型 id，如 doubao-seed-2-1-pro-260915"
                  @keydown.enter.prevent="addManualModel"
                />
                <button type="button" :disabled="saving" @click="addManualModel">手动添加</button>
              </div>
              <div v-if="(activeProvider.models ?? []).length" class="ai-model-list">
                <span v-for="model in activeProvider.models ?? []" :key="model" class="ai-model-item">
                  {{ model }}
                  <button type="button" :disabled="saving" @click="removeModel(model)">×</button>
                </span>
              </div>
              <p v-else class="ai-model-empty">还没有模型；可获取或手动添加。</p>
              <label class="ai-field">
                <span>默认模型</span>
                <select v-model="activeProvider.model">
                  <option value="">自动（探测）</option>
                  <option v-for="model in activeProvider.models ?? []" :key="model" :value="model">
                    {{ model }}
                  </option>
                  <option
                    v-if="activeProvider.model && !(activeProvider.models ?? []).includes(activeProvider.model)"
                    :value="activeProvider.model"
                  >
                    {{ activeProvider.model }}
                  </option>
                </select>
              </label>
            </div>

            <div class="ai-probe">
              <button
                type="button"
                :disabled="aiProbeState.tone === 'busy' || saving"
                @click="probeAiProvider"
              >
                {{ aiProbeState.tone === 'busy' ? '探测中…' : '探测原生视频能力' }}
              </button>
              <button
                type="button"
                class="ai-danger"
                :disabled="saving || resettingDefaults"
                @click="removeProvider(activeProvider.id)"
              >
                删除供应商
              </button>
              <span v-if="aiProbeState.text" :class="aiProbeState.tone">{{ aiProbeState.text }}</span>
            </div>
            <small class="ai-hint">保存后下次检测生效。</small>
          </template>
          <div v-else class="ai-empty">
            还没有供应商。点击「+ 添加供应商」配置任意 OpenAI 兼容端点与模型。
          </div>

          <label class="ai-field">
            <span>Agent 端点（MCP 可选）</span>
            <input v-model="aiAgentEndpoint" spellcheck="false" placeholder="MCP 工具集默认复用本机桥" />
          </label>
          <div class="ai-grid">
            <label class="ai-field">
              <span>分段秒数</span>
              <input v-model.number="aiSegmentSeconds" type="number" min="30" max="3600" />
            </label>
            <label class="ai-field">
              <span>超时秒数</span>
              <input v-model.number="aiTimeoutSeconds" type="number" min="30" max="7200" />
            </label>
            <label class="ai-field">
              <span>单段重发</span>
              <input v-model.number="aiMaxRetries" type="number" min="0" max="10" />
            </label>
          </div>
        </section>

        <section class="mcp-setting">
          <div class="mcp-copy">
            <strong>本地 MCP</strong>
            <small>允许支持 MCP 的 Agent 读取当前项目；写操作仍会请求授权。</small>
            <code v-if="mcpStatus?.command">{{ mcpStatus.command }}</code>
            <small v-if="mcpStatus?.error" class="mcp-error">{{ mcpStatus.error }}</small>
          </div>
          <button
            type="button"
            :class="{ active: mcpStatus?.running }"
            :disabled="mcpBusy"
            @click="emit('toggleMcp')"
          >
            {{ mcpBusy ? '处理中…' : mcpStatus?.running ? '已开启 · 点击关闭' : '已关闭 · 点击开启' }}
          </button>
        </section>

        <section class="mcp-setting delete-behavior">
          <div class="mcp-copy">
            <strong>删除行为</strong>
            <small>
              删除镜头、静帧、标签或术语前弹出二次确认（删除不可恢复，文件将永久删除，不进回收站）。
              关闭后删除将立即执行。
            </small>
          </div>
          <button
            type="button"
            :class="{ active: confirmUserContent }"
            :disabled="saving || resettingDefaults"
            @click="confirmUserContent = !confirmUserContent"
          >
            {{
              confirmUserContent
                ? '二次确认 · 已开启 · 点击关闭'
                : '二次确认 · 已关闭 · 点击开启'
            }}
          </button>
        </section>

        <section class="mcp-setting shortcut-setting">
          <div class="mcp-copy">
            <strong>镜头编辑快捷键</strong>
            <small>支持 Ctrl/Shift/Alt 组合，例如 Ctrl+K。修改后立即按当前设置匹配。</small>
          </div>
          <div class="shortcut-grid">
            <label class="shortcut-field">
              <span>切分镜头</span>
              <input
                v-model="splitShortcut"
                type="text"
                maxlength="40"
                :disabled="saving || resettingDefaults"
              />
            </label>
            <label class="shortcut-field">
              <span>合并镜头</span>
              <input
                v-model="mergeShortcut"
                type="text"
                maxlength="40"
                :disabled="saving || resettingDefaults"
              />
            </label>
          </div>
        </section>

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
        </div>

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

.settings-body {
  display: flex;
  min-height: 0;
  flex: 1;
  flex-direction: column;
  overflow-y: auto;
  overscroll-behavior: contain;
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

.proxy-tier-section {
  display: flex;
  flex: 0 0 auto;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  margin: 12px 16px 0;
  padding: 11px 12px;
  border: 1px solid var(--border);
  border-radius: 7px;
  background: rgba(15, 23, 42, 0.42);
}

.tier-copy {
  display: flex;
  min-width: 0;
  flex-direction: column;
  gap: 3px;
}

.tier-copy strong {
  color: var(--text-secondary);
  font-size: 11px;
}

.tier-copy small {
  color: var(--text-faint);
  font-size: 9px;
}

.tier-options {
  display: grid;
  flex: 0 0 auto;
  grid-template-columns: repeat(3, 64px);
  gap: 6px;
}

.tier-options button {
  display: flex;
  min-height: 42px;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 2px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--bg-raised);
  color: var(--text-muted);
}

.tier-options button strong {
  color: var(--text-secondary);
  font-size: 11px;
}

.tier-options button small {
  font-size: 9px;
}

.tier-options button:hover:not(:disabled),
.tier-options button.active {
  border-color: var(--red);
  background: var(--red-soft);
}

.tier-options button.active strong {
  color: #fff;
}

.ai-section {
  display: flex;
  flex: 0 0 auto;
  flex-direction: column;
  gap: 7px;
  margin: 10px 16px 0;
  padding: 10px 12px;
  border: 1px solid var(--border);
  border-radius: 7px;
  background: rgba(15, 23, 42, 0.42);
}

.legacy-ai-section {
  display: none !important;
}

.local-ai-card {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 14px;
  padding: 12px;
  border: 1px solid rgba(56, 189, 248, 0.3);
  border-radius: 7px;
  background: linear-gradient(135deg, rgba(14, 116, 144, 0.16), rgba(30, 41, 59, 0.42));
}

.local-ai-card > div {
  display: flex;
  min-width: 0;
  flex-direction: column;
  gap: 4px;
}

.local-ai-card strong {
  color: var(--text-primary);
  font-size: 11px;
}

.local-ai-card small,
.local-ai-path {
  color: var(--text-muted);
  font-size: 9px;
}

.local-ai-card > span {
  flex: 0 0 auto;
  color: var(--green);
  font-size: 9px;
}

.local-ai-card.unavailable {
  border-color: rgba(245, 158, 11, 0.38);
}

.local-ai-card.unavailable > span {
  color: var(--gold);
}

.local-ai-path {
  overflow: hidden;
  margin: -4px 0 0;
  font-family: var(--mono);
  line-height: 1.45;
  overflow-wrap: anywhere;
}

.local-ai-fallback {
  align-self: flex-start;
  padding: 6px 9px;
  border: 1px solid var(--border);
  border-radius: 5px;
  background: var(--bg-raised);
  color: var(--text-muted);
  font-size: 9px;
}

.local-ai-fallback.active {
  border-color: rgba(34, 197, 94, 0.42);
  color: #86efac;
}

.ai-head {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.ai-head strong {
  color: var(--text-secondary);
  font-size: 11px;
}

.ai-head small {
  color: var(--text-faint);
  font-size: 9px;
}

.ai-engine-row {
  display: flex;
  align-items: center;
  gap: 6px;
}

.ai-engine-row > span {
  min-width: 58px;
  color: var(--text-faint);
  font-size: 9px;
}

.ai-toggle {
  height: 26px;
  padding: 0 9px;
  border: 1px solid var(--border);
  border-radius: 5px;
  background: var(--bg-raised);
  color: var(--text-muted);
  font-size: 9px;
}

.ai-toggle.active {
  border-color: rgba(34, 197, 94, 0.42);
  background: rgba(34, 197, 94, 0.1);
  color: #86efac;
}

.ai-field {
  display: grid;
  grid-template-columns: 160px minmax(0, 1fr);
  align-items: center;
  gap: 8px;
}

.ai-field > span {
  color: var(--text-faint);
  font-size: 9px;
}

.ai-field input {
  height: 28px;
  min-width: 0;
  padding: 0 8px;
  border: 1px solid var(--border);
  border-radius: 5px;
  outline: 0;
  background: var(--bg-raised);
  color: var(--text-secondary);
  font-family: var(--mono);
  font-size: 10px;
}

.ai-field input:focus {
  border-color: var(--blue-hi);
}

.ai-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 8px;
}

.ai-grid .ai-field {
  grid-template-columns: 1fr;
}

.ai-probe {
  display: flex;
  align-items: center;
  gap: 10px;
}

.ai-key-actions {
  display: flex;
  justify-content: flex-end;
  margin-top: -2px;
}

.ai-probe button,
.ai-key-actions button {
  height: 28px;
  padding: 0 10px;
  border: 1px solid var(--border);
  border-radius: 5px;
  background: var(--bg-raised);
  color: var(--text-secondary);
  font-size: 9px;
}

.ai-probe span {
  color: var(--text-faint);
  font-size: 9px;
}

.ai-probe span.success {
  color: #86efac;
}

.ai-probe span.error {
  color: #fca5a5;
}

.provider-list {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.provider-chip {
  display: flex;
  height: 28px;
  align-items: center;
  gap: 6px;
  padding: 0 10px;
  border: 1px solid var(--border);
  border-radius: 999px;
  background: var(--bg-raised);
  color: var(--text-muted);
  font-size: 9px;
}

.provider-chip.active {
  border-color: rgba(96, 165, 250, 0.45);
  background: rgba(30, 58, 95, 0.45);
  color: var(--blue-hi);
}

.provider-chip em {
  color: #86efac;
  font-size: 8px;
  font-style: normal;
}

.provider-add {
  height: 28px;
  padding: 0 10px;
  border: 1px dashed var(--border-strong);
  border-radius: 999px;
  background: transparent;
  color: var(--text-muted);
  font-size: 9px;
}

.ai-models {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 8px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: rgba(15, 23, 42, 0.35);
}

.ai-models-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.ai-models-head strong {
  color: var(--text-secondary);
  font-size: 10px;
}

.ai-models-head button,
.ai-model-add button {
  height: 26px;
  padding: 0 8px;
  border: 1px solid var(--border);
  border-radius: 5px;
  background: var(--bg-raised);
  color: var(--text-muted);
  font-size: 9px;
}

.ai-model-add {
  display: flex;
  gap: 6px;
}

.ai-model-add input {
  height: 27px;
  min-width: 0;
  flex: 1;
  padding: 0 8px;
  border: 1px solid var(--border);
  border-radius: 5px;
  outline: 0;
  background: var(--bg-raised);
  color: var(--text-secondary);
  font-family: var(--mono);
  font-size: 9px;
}

.ai-model-list {
  display: flex;
  flex-wrap: wrap;
  gap: 5px;
}

.ai-model-item {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 3px 6px;
  border: 1px solid var(--border);
  border-radius: 4px;
  background: var(--bg-raised);
  color: var(--text-muted);
  font-family: var(--mono);
  font-size: 8px;
}

.ai-model-item button {
  padding: 0;
  border: 0;
  background: transparent;
  color: var(--text-faint);
  font-size: 11px;
}

.ai-model-empty {
  margin: 0;
  color: var(--text-faint);
  font-size: 9px;
}

.ai-field select {
  height: 28px;
  min-width: 0;
  padding: 0 8px;
  border: 1px solid var(--border);
  border-radius: 5px;
  outline: 0;
  background: var(--bg-raised);
  color: var(--text-secondary);
  font-family: var(--mono);
  font-size: 10px;
}

.ai-probe .ai-danger {
  border-color: rgba(239, 68, 68, 0.35);
  color: #fca5a5;
}

.ai-hint {
  color: var(--text-faint);
  font-size: 9px;
}

.ai-empty {
  padding: 8px;
  border: 1px dashed var(--border);
  border-radius: 6px;
  color: var(--text-faint);
  font-size: 9px;
  text-align: center;
}

.settings-error {
  border-color: rgba(239, 68, 68, 0.4);
  background: rgba(239, 68, 68, 0.09);
  color: #fca5a5;
}

.mcp-setting {
  display: flex;
  flex: 0 0 auto;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin: 10px 16px 0;
  padding: 10px 12px;
  border: 1px solid var(--border);
  border-radius: 7px;
  background: rgba(15, 23, 42, 0.42);
}

.mcp-copy {
  display: flex;
  min-width: 0;
  flex-direction: column;
  gap: 3px;
}

.mcp-copy strong {
  color: var(--text-secondary);
  font-size: 11px;
}

.mcp-copy small {
  color: var(--text-faint);
  font-size: 9px;
  line-height: 1.4;
}

.mcp-copy code {
  max-width: 510px;
  overflow: hidden;
  color: var(--text-muted);
  font-family: var(--mono);
  font-size: 8px;
  text-overflow: ellipsis;
  white-space: nowrap;
  user-select: text;
}

.mcp-copy .mcp-error {
  color: var(--red);
}

.mcp-setting > button {
  flex: 0 0 auto;
  height: 30px;
  padding: 0 10px;
  border: 1px solid var(--border);
  border-radius: 5px;
  background: var(--bg-raised);
  color: var(--text-muted);
  font-size: 9px;
}

.mcp-setting > button.active {
  border-color: rgba(34, 197, 94, 0.42);
  background: rgba(34, 197, 94, 0.1);
  color: #86efac;
}

.shortcut-setting {
  align-items: flex-start;
}

.shortcut-grid {
  display: grid;
  min-width: 250px;
  grid-template-columns: 1fr 1fr;
  gap: 8px;
}

.shortcut-field {
  display: flex;
  flex-direction: column;
  gap: 4px;
  color: var(--text-faint);
  font-size: 9px;
}

.shortcut-field input {
  height: 30px;
  padding: 0 9px;
  border: 1px solid var(--border);
  border-radius: 5px;
  background: var(--bg-raised);
  color: var(--text-primary);
  font-family: var(--mono);
  font-size: 10px;
}

.path-list {
  display: flex;
  min-height: 0;
  flex: 0 0 auto;
  flex-direction: column;
  gap: 8px;
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
