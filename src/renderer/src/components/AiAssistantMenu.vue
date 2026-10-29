<script setup lang="ts">
import { ref, watch } from 'vue';
import AppIcon from './AppIcon.vue';
import type {
  AiMcpAuthRequest,
  AiMcpStatus,
  AiTaskId,
} from '../../../shared/types';

const props = defineProps<{
  open: boolean;
  hasProject: boolean;
  projectName: string;
  mcpStatus: AiMcpStatus | null;
  mcpBusy: boolean;
  copying: boolean;
  authRequest: AiMcpAuthRequest | null;
}>();

const emit = defineEmits<{
  toggle: [];
  close: [];
  copyPrompt: [tasks: AiTaskId[]];
  copySnapshot: [];
  toggleMcp: [];
  respondAuth: [value: { allowed: boolean; remember: boolean }];
}>();

const tasks: Array<{ id: AiTaskId; label: string; hint: string }> = [
  { id: 'continuity', label: '检查分镜连续性', hint: '景别、机位、运镜与切换风险' },
  { id: 'notes', label: '整理镜头笔记', hint: '把已有观察整理成清晰意见' },
  { id: 'export-summary', label: '导出摘要建议', hint: '节奏、风格与待完善内容' },
  { id: 'terminology', label: '术语标注建议', hint: '按既有标签体系补充候选' },
  { id: 'visual-description', label: '分镜画面描述', hint: '生成适合分镜本的画面文字' },
];
const selectedTasks = ref<AiTaskId[]>(['continuity']);
const rememberAuth = ref(false);

watch(
  () => props.authRequest,
  (request) => {
    if (request) rememberAuth.value = false;
  },
);

function toggleTask(id: AiTaskId): void {
  selectedTasks.value = selectedTasks.value.includes(id)
    ? selectedTasks.value.filter((item) => item !== id)
    : [...selectedTasks.value, id];
}
</script>

<template>
  <div class="ai-entry">
    <button class="nav-item ai-nav" type="button" :disabled="copying" @click="emit('toggle')">
      <AppIcon name="sparkles" :size="15" />
      AI 助手
    </button>

    <div v-if="open" class="ai-menu-mask" @pointerdown.self="emit('close')">
      <section class="ai-menu" role="dialog" aria-modal="true" aria-labelledby="ai-menu-title">
        <header class="ai-menu-head">
          <div>
            <p>AI WORKSPACE BRIDGE</p>
            <h2 id="ai-menu-title">AI 助手</h2>
            <span>{{ projectName || '请先打开一个项目' }}</span>
          </div>
          <button type="button" aria-label="关闭" @click="emit('close')">×</button>
        </header>

        <div class="ai-menu-body">
          <section class="ai-section">
            <div class="ai-section-head">
              <strong>选择任务</strong>
              <span>已选 {{ selectedTasks.length }} 项</span>
            </div>
            <div class="task-list">
              <label v-for="task in tasks" :key="task.id" class="task-option">
                <input
                  type="checkbox"
                  :checked="selectedTasks.includes(task.id)"
                  @change="toggleTask(task.id)"
                />
                <span>
                  <strong>{{ task.label }}</strong>
                  <small>{{ task.hint }}</small>
                </span>
              </label>
            </div>
            <div class="prompt-actions">
              <button
                class="primary"
                type="button"
                :disabled="!hasProject || copying || selectedTasks.length === 0"
                @click="emit('copyPrompt', selectedTasks)"
              >
                {{ copying ? '复制中…' : '复制任务提示词' }}
              </button>
              <button
                type="button"
                :disabled="!hasProject || copying"
                @click="emit('copySnapshot')"
              >
                只复制数据快照
              </button>
            </div>
          </section>

          <section class="ai-section">
            <div class="ai-section-head">
              <strong>本地 MCP</strong>
              <span :class="{ on: mcpStatus?.running }">
                {{ mcpStatus?.running ? '已开启' : '已关闭' }}
              </span>
            </div>
            <p class="mcp-copy">
              允许支持 MCP 的 Agent 读取当前项目；写入镜头笔记时仍会请求你的确认。
            </p>
            <code v-if="mcpStatus?.command" class="mcp-command">{{ mcpStatus.command }}</code>
            <div class="mcp-actions">
              <button type="button" :disabled="mcpBusy" @click="emit('toggleMcp')">
                {{ mcpBusy ? '处理中…' : mcpStatus?.running ? '关闭 MCP' : '开启 MCP' }}
              </button>
              <small v-if="mcpStatus?.error">{{ mcpStatus.error }}</small>
            </div>
          </section>
        </div>
      </section>
    </div>

    <div v-if="authRequest" class="ai-auth-mask">
      <section class="ai-auth-card" role="alertdialog" aria-modal="true" aria-labelledby="ai-auth-title">
        <header>
          <span class="auth-kicker">MCP 写入授权</span>
          <h3 id="ai-auth-title">{{ authRequest.agentName }} 请求修改项目</h3>
        </header>
        <p>{{ authRequest.action }}</p>
        <code>{{ authRequest.detail }}</code>
        <label class="remember-row">
          <input v-model="rememberAuth" type="checkbox" />
          始终允许该 Agent 执行写操作
        </label>
        <footer>
          <button type="button" @click="emit('respondAuth', { allowed: false, remember: false }); rememberAuth = false">
            拒绝
          </button>
          <button
            class="primary"
            type="button"
            @click="emit('respondAuth', { allowed: true, remember: rememberAuth }); rememberAuth = false"
          >
            允许
          </button>
        </footer>
      </section>
    </div>
  </div>
</template>

<style scoped>
.ai-entry {
  position: relative;
}

.ai-nav {
  gap: 6px;
}

.ai-menu-mask,
.ai-auth-mask {
  position: fixed;
  inset: 0;
  z-index: 92;
  display: grid;
  padding: 18px;
  background: rgba(2, 6, 23, 0.68);
  place-items: start center;
}

.ai-auth-mask {
  z-index: 96;
  align-items: center;
}

.ai-menu,
.ai-auth-card {
  width: min(660px, calc(100vw - 36px));
  margin-top: 54px;
  overflow: hidden;
  border: 1px solid var(--border-strong);
  border-radius: 10px;
  background: var(--bg-panel);
  box-shadow: 0 28px 90px rgba(0, 0, 0, 0.55);
}

.ai-auth-card {
  width: min(480px, calc(100vw - 36px));
  margin-top: 0;
  padding: 18px;
}

.ai-menu-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  padding: 16px;
  border-bottom: 1px solid var(--border);
}

.ai-menu-head p,
.auth-kicker {
  margin: 0 0 4px;
  color: var(--blue-hi);
  font-size: 9px;
  letter-spacing: 1.4px;
}

.ai-menu-head h2,
.ai-auth-card h3 {
  margin: 0;
  color: var(--text-primary);
  font-size: 15px;
}

.ai-menu-head span {
  display: block;
  margin-top: 4px;
  color: var(--text-muted);
  font-size: 10px;
}

.ai-menu-head > button {
  width: 28px;
  height: 28px;
  border: 0;
  border-radius: 5px;
  background: transparent;
  color: var(--text-muted);
  font-size: 20px;
}

.ai-menu-body {
  display: grid;
  gap: 12px;
  padding: 14px;
}

.ai-section {
  padding: 12px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: rgba(15, 23, 42, 0.45);
}

.ai-section-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 8px;
  color: var(--text-secondary);
  font-size: 11px;
}

.ai-section-head span {
  color: var(--text-faint);
  font-size: 9px;
}

.ai-section-head span.on {
  color: var(--green);
}

.task-list {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 7px;
}

.task-option {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 9px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--bg-raised);
}

.task-option input,
.remember-row input {
  margin: 2px 0 0;
  accent-color: var(--red);
}

.task-option span {
  display: flex;
  min-width: 0;
  flex-direction: column;
  gap: 2px;
}

.task-option strong {
  color: var(--text-secondary);
  font-size: 10px;
}

.task-option small,
.mcp-copy,
.mcp-actions small {
  color: var(--text-faint);
  font-size: 9px;
  line-height: 1.45;
}

.prompt-actions,
.mcp-actions,
.ai-auth-card footer {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 10px;
}

.prompt-actions button,
.mcp-actions button,
.ai-auth-card footer button {
  height: 30px;
  padding: 0 10px;
  border: 1px solid var(--border);
  border-radius: 5px;
  background: var(--bg-raised);
  color: var(--text-secondary);
  font-size: 10px;
}

.prompt-actions .primary,
.ai-auth-card footer .primary {
  border-color: var(--red);
  background: var(--red);
  color: #fff;
}

.mcp-command,
.ai-auth-card code {
  display: block;
  overflow-wrap: anywhere;
  padding: 7px 8px;
  border: 1px solid var(--border);
  border-radius: 5px;
  background: var(--bg-deep);
  color: var(--text-muted);
  font-family: var(--mono);
  font-size: 9px;
  line-height: 1.45;
  user-select: text;
}

.ai-auth-card p {
  margin: 12px 0 6px;
  color: var(--text-secondary);
  font-size: 11px;
}

.remember-row {
  display: flex;
  align-items: center;
  gap: 7px;
  margin-top: 12px;
  color: var(--text-muted);
  font-size: 10px;
}

.ai-auth-card footer {
  justify-content: flex-end;
}
</style>
