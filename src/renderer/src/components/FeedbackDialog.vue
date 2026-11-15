<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';

const props = withDefaults(
  defineProps<{
    open: boolean;
    version?: string;
    platform?: string;
    issuesUrl?: string;
    email?: string | null;
  }>(),
  {
    version: '0.4.0',
    platform: 'Windows',
    issuesUrl: 'https://github.com/YGSWGJR/personal-film-lab/issues',
    email: null,
  },
);

const emit = defineEmits<{ close: [] }>();
const copied = ref(false);

const reportTemplate = computed(
  () =>
    `版本：${props.version}\n系统：${props.platform}\n问题描述：\n复现步骤：\n1. \n2. \n期望结果：\n实际结果：\n附加日志：`,
);

async function copyTemplate(): Promise<void> {
  try {
    await navigator.clipboard.writeText(reportTemplate.value);
    copied.value = true;
    window.setTimeout(() => (copied.value = false), 1600);
  } catch {
    copied.value = false;
  }
}

function onGlobalKeydown(event: KeyboardEvent): void {
  if (!props.open || event.key !== 'Escape') return;
  event.preventDefault();
  event.stopImmediatePropagation();
  emit('close');
}

onMounted(() => window.addEventListener('keydown', onGlobalKeydown, true));
onBeforeUnmount(() => window.removeEventListener('keydown', onGlobalKeydown, true));
</script>

<template>
  <Teleport to="body">
    <div v-if="open" class="feedback-mask" @pointerdown.self="emit('close')">
      <section class="feedback-dialog" role="dialog" aria-modal="true" aria-labelledby="feedback-title">
        <header>
          <div>
            <p>反馈与问题报告</p>
            <h2 id="feedback-title">帮助我们把工作台做得更好</h2>
          </div>
          <button type="button" class="close-btn" aria-label="关闭反馈" @click="emit('close')">×</button>
        </header>

        <div class="feedback-body">
          <p>
            请尽量附上版本、系统、复现步骤和必要日志。反馈说明不会自动上传项目、
            影片、截图、API Key 或其他本地数据。
          </p>

          <div class="meta-row">
            <span>版本 {{ version }}</span>
            <span>{{ platform }}</span>
          </div>

          <pre>{{ reportTemplate }}</pre>

          <div class="feedback-actions">
            <button type="button" @click="copyTemplate">
              {{ copied ? '已复制' : '复制反馈模板' }}
            </button>
            <a :href="issuesUrl" target="_blank" rel="noreferrer" class="primary">
              打开 GitHub Issues
            </a>
            <a v-if="email" :href="`mailto:${email}`">发送邮件</a>
          </div>
        </div>
      </section>
    </div>
  </Teleport>
</template>

<style scoped>
.feedback-mask {
  position: fixed;
  inset: 0;
  z-index: 140;
  display: grid;
  place-items: center;
  background: rgba(3, 7, 14, 0.72);
  backdrop-filter: blur(7px);
}

.feedback-dialog {
  width: min(620px, calc(100vw - 40px));
  overflow: hidden;
  border: 1px solid rgba(125, 157, 199, 0.3);
  border-radius: 16px;
  background: #111824;
  color: #e8f0fb;
  box-shadow: 0 24px 80px rgba(0, 0, 0, 0.56);
}

header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 20px;
  padding: 22px 24px 18px;
  border-bottom: 1px solid rgba(148, 163, 184, 0.18);
}

header p,
header h2,
.feedback-body p {
  margin: 0;
}

header p {
  color: #7eb1ff;
  font-size: 11px;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}

header h2 {
  margin-top: 7px;
  font-size: 20px;
}

.close-btn {
  border: 0;
  background: transparent;
  color: #9fb1c9;
  font-size: 28px;
  cursor: pointer;
}

.feedback-body {
  padding: 22px 24px 24px;
}

.feedback-body p {
  color: #a7b5c8;
  line-height: 1.7;
}

.meta-row {
  display: flex;
  gap: 10px;
  margin: 16px 0;
}

.meta-row span {
  padding: 5px 9px;
  border-radius: 999px;
  background: rgba(90, 162, 255, 0.1);
  color: #9dc5ff;
  font-size: 11px;
}

pre {
  min-height: 150px;
  margin: 0;
  padding: 14px;
  overflow: auto;
  border: 1px solid rgba(148, 163, 184, 0.18);
  border-radius: 10px;
  background: #0b111b;
  color: #c9d6e8;
  font: 12px/1.7 var(--mono);
  white-space: pre-wrap;
  user-select: text;
}

.feedback-actions {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
  margin-top: 18px;
}

.feedback-actions button,
.feedback-actions a {
  padding: 9px 14px;
  border: 1px solid rgba(148, 163, 184, 0.28);
  border-radius: 8px;
  background: rgba(255, 255, 255, 0.035);
  color: inherit;
  text-decoration: none;
  cursor: pointer;
}

.feedback-actions .primary {
  border-color: #3b8ee8;
  background: #236fbf;
}
</style>
