import { randomBytes, randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  read,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { join } from 'node:path';
import { Readable, Writable } from 'node:stream';
import { app, clipboard, type BrowserWindow } from 'electron';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import type { DataLayer } from '../../data/db';
import { IPC } from '../../shared/ipc-channels';
import type {
  AiCopyPromptArgs,
  AiCopyPromptResult,
  AiJobSnapshot,
  AiListModelsResult,
  AiMcpAuthRequest,
  AiMcpAuthResponseArgs,
  AiMcpDataChangedEvent,
  AiMcpStatus,
  AiProjectSnapshot,
  AiProviderProbeResult,
  DetectOptions,
  Settings,
  ShotDetectionUsage,
  WorkspaceState,
} from '../../shared/types';
import type { DetectService } from '../detect/detect-service';
import type { MediaService } from '../media/media-service';
import { resolveThumbCacheDir } from '../paths';
import { buildAiPrompt, buildSnapshotOnlyPrompt } from './ai-prompts';
import { decryptApiKey } from './credential-store';
import {
  createProviderFromSettings,
  OpenAiCompatProvider,
  resolveActiveProvider,
  type ShotDetectionProvider,
} from './provider';
import {
  buildContinuityCandidates,
  buildProjectSnapshot,
  buildProjectSummary,
} from './shot-snapshot';

interface AiAccessDeps {
  getWindow: () => BrowserWindow | null;
  getData: () => DataLayer | null;
  getSessionState: () => WorkspaceState | null;
  getSettings?: () => Settings | null;
  getDetect?: () => DetectService | null;
  getMedia?: () => MediaService | null;
}

interface McpBridgeConfig {
  enabled: boolean;
  port: number;
  token: string;
}

interface McpAuthStore {
  alwaysAllow: string[];
}

interface PendingAuth {
  request: AiMcpAuthRequest;
  resolve: (allowed: boolean) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface BridgeRequest {
  tool: string;
  args?: Record<string, unknown>;
  agentName?: string;
}

/** S36-2b：11 个 MCP 工具（5 旧 + 6 新），HTTP 桥与 Stdio 两端共用此清单。 */
export const MCP_TOOL_NAMES = [
  'list_shots',
  'get_shot_detail',
  'check_continuity',
  'write_shot_note',
  'get_project_summary',
  'run_shot_detection',
  'get_detection_job',
  'cancel_detection',
  'apply_detection',
  'write_shot_tags',
  'get_shot_thumbnail',
] as const;

export class AiAccessService {
  private server: Server | null = null;
  private port: number | null = null;
  private token = '';
  private lastError: string | null = null;
  private readonly pendingAuth = new Map<string, PendingAuth>();

  constructor(private readonly deps: AiAccessDeps) {}

  async initialize(): Promise<void> {
    const config = readMcpConfig();
    if (!config?.enabled) return;
    try {
      await this.startBridge();
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
      console.warn(`[ai] 自动启动 MCP 失败：${this.lastError}`);
    }
  }

  getStatus(): AiMcpStatus {
    return {
      enabled: this.server !== null,
      running: this.server !== null,
      command: mcpCommand(),
      port: this.port,
      error: this.lastError,
    };
  }

  async setEnabled(enabled: boolean): Promise<AiMcpStatus> {
    if (enabled) {
      await this.startBridge();
    } else {
      await this.stopBridge();
      writeMcpConfig({ enabled: false, port: 0, token: '' });
    }
    return this.getStatus();
  }

  copyPrompt(args: AiCopyPromptArgs): AiCopyPromptResult {
    const snapshot = this.buildSnapshot(args.projectId);
    const text = args.tasks.length > 0
      ? buildAiPrompt(args.tasks, snapshot)
      : buildSnapshotOnlyPrompt(snapshot);
    clipboard.writeText(text);
    return { copied: true, characters: text.length };
  }

  getSnapshot(projectId: string): AiProjectSnapshot {
    return this.buildSnapshot(projectId);
  }

  /** S36-2a：探测 API Key 直连端点的原生视频能力。 */
  async probeProvider(args?: {
    baseUrl?: string;
    apiKey?: string;
    providerId?: string;
  }): Promise<AiProviderProbeResult> {
    return this.buildProviderForArgs(args).probeCapability();
  }

  /** S36-7：获取供应商模型列表（支持 providerId 或草稿 baseUrl/apiKey）。 */
  async listModels(args: {
    providerId?: string;
    baseUrl?: string;
    apiKey?: string;
  }): Promise<AiListModelsResult> {
    return this.buildProviderForArgs(args).listModels();
  }

  private buildProviderForArgs(args?: {
    providerId?: string;
    baseUrl?: string;
    apiKey?: string;
  }): ShotDetectionProvider {
    const settings = this.deps.getSettings?.()?.ai;
    const forceMock = process.env['SMOKE_AI_PROVIDER'] === 'mock';
    if (forceMock || (settings?.provider === 'mock' && !args?.baseUrl && !args?.providerId)) {
      return createProviderFromSettings(settings, { forceMock: true });
    }
    if (args?.baseUrl || args?.apiKey) {
      return new OpenAiCompatProvider({
        baseUrl: (args.baseUrl ?? '').trim(),
        apiKey: (args.apiKey ?? '').trim(),
        model: resolveActiveProvider(settings)?.model,
        timeoutMs: Math.max(30, settings?.timeoutSeconds ?? 900) * 1000,
      });
    }
    if (args?.providerId) {
      const config = settings?.providers?.find((item) => item.id === args.providerId);
      if (config) {
        return new OpenAiCompatProvider({
          baseUrl: config.baseUrl,
          apiKey: decryptApiKey(config.apiKey),
          model: config.model,
          timeoutMs: Math.max(30, settings?.timeoutSeconds ?? 900) * 1000,
        });
      }
    }
    return createProviderFromSettings(settings);
  }

  respondMcpAuth(args: AiMcpAuthResponseArgs): { responded: boolean } {
    const pending = this.pendingAuth.get(args.requestId);
    if (!pending) return { responded: false };
    this.pendingAuth.delete(args.requestId);
    clearTimeout(pending.timer);
    if (args.allowed && args.remember) {
      const store = readAuthStore();
      if (!store.alwaysAllow.includes(pending.request.agentName)) {
        store.alwaysAllow.push(pending.request.agentName);
        writeJsonAtomic(authPath(), store);
      }
    }
    pending.resolve(args.allowed);
    return { responded: true };
  }

  async dispose(): Promise<void> {
    for (const pending of this.pendingAuth.values()) {
      clearTimeout(pending.timer);
      pending.resolve(false);
    }
    this.pendingAuth.clear();
    await this.stopBridge();
  }

  private buildSnapshot(projectId: string): AiProjectSnapshot {
    const data = this.requireData();
    return buildProjectSnapshot(data, projectId);
  }

  private async startBridge(): Promise<void> {
    if (this.server) return;
    const token = randomBytes(32).toString('hex');
    const server = createServer((request, response) => {
      void this.handleBridgeRequest(request, response);
    });
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error): void => {
        server.off('listening', onListening);
        reject(error);
      };
      const onListening = (): void => {
        server.off('error', onError);
        resolve();
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(0, '127.0.0.1');
    }).catch((error) => {
      server.close();
      this.lastError = error instanceof Error ? error.message : String(error);
      throw error;
    });

    const address = server.address();
    if (!address || typeof address === 'string') {
      server.close();
      throw new Error('MCP 本地桥接端口分配失败');
    }
    this.server = server;
    this.port = address.port;
    this.token = token;
    this.lastError = null;
    writeMcpConfig({ enabled: true, port: address.port, token });
  }

  private async stopBridge(): Promise<void> {
    const server = this.server;
    this.server = null;
    this.port = null;
    this.token = '';
    if (!server) return;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  private async handleBridgeRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const send = (status: number, payload: unknown): void => {
      response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify(payload));
    };

    if (request.method !== 'POST' || request.url !== '/rpc') {
      send(404, { error: { code: 'NOT_FOUND', message: '未知 MCP 桥接请求' } });
      return;
    }
    if (request.headers.authorization !== `Bearer ${this.token}`) {
      send(401, { error: { code: 'UNAUTHORIZED', message: 'MCP 访问令牌无效' } });
      return;
    }

    try {
      const body = await readRequestBody(request);
      const payload = JSON.parse(body) as BridgeRequest;
      if (!payload || typeof payload.tool !== 'string') throw new Error('MCP 工具参数无效');
      const result = await this.dispatchTool(payload);
      send(200, { result });
    } catch (error) {
      send(400, {
        error: {
          code: 'MCP_REQUEST_FAILED',
          message: error instanceof Error ? error.message : String(error),
        },
      });
    }
  }

  private async dispatchTool(payload: BridgeRequest): Promise<unknown> {
    const data = this.requireData();
    const sessionProjectId = this.deps.getSessionState()?.projectId ?? null;
    const snapshot = sessionProjectId ? buildProjectSnapshot(data, sessionProjectId) : null;
    const agentName = normalizeAgentName(payload.agentName);

    switch (payload.tool) {
      case 'list_shots': {
        const current = this.requireSnapshot(snapshot);
        return {
          project: current.project,
          shots: current.shots.map((shot) => ({
            id: shot.id,
            index: shot.index,
            startMs: shot.startMs,
            endMs: shot.endMs,
            durationMs: shot.durationMs,
            shotSize: shot.shotSize,
            cameraMethod: shot.cameraMethod,
            tags: shot.tags,
            noteLength: shot.noteLength,
          })),
        };
      }
      case 'get_shot_detail': {
        const current = this.requireSnapshot(snapshot);
        const shotId = String(payload.args?.shotId ?? '');
        const shot = current.shots.find((item) => item.id === shotId);
        if (!shot) throw new Error('镜头不存在或不属于当前项目');
        return shot;
      }
      case 'check_continuity':
        return { candidates: buildContinuityCandidates(this.requireSnapshot(snapshot)) };
      case 'get_project_summary':
        return buildProjectSummary(this.requireSnapshot(snapshot));
      case 'write_shot_note': {
        const current = this.requireSnapshot(snapshot);
        const shotId = String(payload.args?.shotId ?? '');
        const content = String(payload.args?.content ?? '');
        const shot = current.shots.find((item) => item.id === shotId);
        if (!shot) throw new Error('镜头不存在或不属于当前项目');
        const allowed = await this.authorizeWrite(
          agentName,
          '写入镜头笔记',
          `镜头 ${String(shot.index).padStart(2, '0')}，${content.length} 个字符`,
        );
        if (!allowed) throw new Error('用户拒绝了 MCP 写入请求');
        const existing = data.notes.list({ shotId })[0];
        const note = data.notes.upsert({
          id: existing?.id,
          projectId: current.project.id,
          shotId,
          text: content,
        });
        const changed: AiMcpDataChangedEvent = { projectId: current.project.id, shotId };
        const win = this.deps.getWindow();
        if (win && !win.isDestroyed()) win.webContents.send(IPC.AI_MCP_DATA_CHANGED, changed);
        return { written: true, note };
      }
      case 'run_shot_detection': {
        const targetProjectId = String(payload.args?.projectId ?? sessionProjectId ?? '');
        if (!targetProjectId) throw new Error('当前没有打开的项目，请提供 projectId');
        const project = data.projects.get(targetProjectId);
        const allowed = await this.authorizeWrite(
          agentName,
          '启动 AI 镜头识别',
          `项目 ${project.name}${payload.args?.rangeMs ? '（范围参数已接收）' : ''}`,
        );
        if (!allowed) throw new Error('用户拒绝了 MCP 写入请求');
        const detect = this.requireDetect();
        const { jobId } = detect.run({
          projectId: targetProjectId,
          options: defaultAiDetectOptions(),
          dryRun: true,
        });
        return { jobId };
      }
      case 'get_detection_job': {
        const jobId = String(payload.args?.jobId ?? '');
        if (!jobId) throw new Error('缺少 jobId');
        const job = this.requireDetect().getJob(jobId);
        const usage: ShotDetectionUsage = job.usage ?? { seconds: 0, tokens: 0, cost: 0 };
        const snapshot: AiJobSnapshot = {
          jobId: job.jobId,
          projectId: job.projectId,
          status: job.status,
          progress: job.progress,
          currentSegment: job.currentSegment ?? 0,
          segmentsTotal: job.segmentsTotal ?? 0,
          error: job.error,
          usage,
        };
        return snapshot;
      }
      case 'cancel_detection': {
        const jobId = String(payload.args?.jobId ?? '');
        if (!jobId) throw new Error('缺少 jobId');
        const allowed = await this.authorizeWrite(agentName, '取消 AI 镜头识别', `任务 ${jobId}`);
        if (!allowed) throw new Error('用户拒绝了 MCP 写入请求');
        this.requireDetect().cancel(jobId);
        return { cancelled: true };
      }
      case 'apply_detection': {
        const jobId = String(payload.args?.jobId ?? '');
        if (!jobId) throw new Error('缺少 jobId');
        const allowed = await this.authorizeWrite(agentName, '应用 AI 镜头识别结果', `任务 ${jobId}`);
        if (!allowed) throw new Error('用户拒绝了 MCP 写入请求');
        const detect = this.requireDetect();
        const shotIds = readStringArray(payload.args?.shotIds);
        const sceneIds = readStringArray(payload.args?.sceneIds);
        const job = detect.getJob(jobId);
        const result = detect.applyByJob(jobId, shotIds, sceneIds);
        const changed: AiMcpDataChangedEvent = { projectId: job.projectId, shotId: '' };
        const win = this.deps.getWindow();
        if (win && !win.isDestroyed()) win.webContents.send(IPC.AI_MCP_DATA_CHANGED, changed);
        return result;
      }
      case 'write_shot_tags': {
        const shotId = String(payload.args?.shotId ?? '');
        const shot = data.shots.get(shotId);
        const tagMap = readTagMap(payload.args?.tags);
        const allowed = await this.authorizeWrite(
          agentName,
          '写入镜头标签',
          `镜头 ${String(shot.index).padStart(2, '0')}，${Object.values(tagMap).flat().length} 个标签`,
        );
        if (!allowed) throw new Error('用户拒绝了 MCP 写入请求');
        const existing = data.tags.list();
        const tagIds: string[] = [];
        let written = 0;
        for (const [category, names] of Object.entries(tagMap)) {
          for (const name of names) {
            const trimmed = name.trim();
            if (!trimmed) continue;
            let tag = existing.find((item) => item.category === category && item.name === trimmed);
            if (!tag) {
              tag = data.tags.create({ category, name: trimmed });
              existing.push(tag);
            }
            tagIds.push(tag.id);
            written += 1;
          }
        }
        const assigned = data.tags.assign(shotId, tagIds);
        const changed: AiMcpDataChangedEvent = { projectId: shot.projectId, shotId };
        const win = this.deps.getWindow();
        if (win && !win.isDestroyed()) win.webContents.send(IPC.AI_MCP_DATA_CHANGED, changed);
        return { written, tagIds: assigned };
      }
      case 'get_shot_thumbnail': {
        const shotId = String(payload.args?.shotId ?? '');
        const shot = data.shots.get(shotId);
        if (shot.thumbnail && existsSync(shot.thumbnail)) {
          return { thumbnailPath: shot.thumbnail };
        }
        const media = this.deps.getMedia?.() ?? null;
        if (!media) throw new Error('媒体服务尚未就绪');
        const project = data.projects.get(shot.projectId);
        const sourcePath = project.media.proxyPath || project.source.path;
        if (!sourcePath) throw new Error('项目没有可读取的视频路径');
        const thumbsDir = join(resolveThumbCacheDir(), shot.projectId);
        mkdirSync(thumbsDir, { recursive: true });
        const stamp = Date.now();
        const target = join(thumbsDir, `shot-${shot.index}-${stamp}.jpg`);
        const sourceFrame = join(thumbsDir, `.shot-${shot.index}-${stamp}.src.jpg`);
        const representativeTimeMs = Math.round((shot.startMs + shot.endMs) / 2);
        try {
          await media.extractFrame({
            path: sourcePath,
            timeMs: representativeTimeMs,
            outputPath: sourceFrame,
            format: 'jpg',
            quality: 6,
            timeoutMs: 60_000,
          });
          await media.createThumbnail(sourceFrame, target, 160, 8);
          data.shots.setThumbnail(shot.id, target);
        } finally {
          rmSync(sourceFrame, { force: true });
        }
        return { thumbnailPath: target };
      }
      default:
        throw new Error(`未知 MCP 工具：${payload.tool}`);
    }
  }

  private requireSnapshot(snapshot: AiProjectSnapshot | null): AiProjectSnapshot {
    if (!snapshot) throw new Error('当前没有打开的项目');
    return snapshot;
  }

  private requireDetect(): DetectService {
    const detect = this.deps.getDetect?.() ?? null;
    if (!detect) throw new Error('镜头识别服务尚未就绪');
    return detect;
  }

  private async authorizeWrite(agentName: string, action: string, detail: string): Promise<boolean> {
    return (
      this.isAgentAllowed(agentName) ||
      (await this.requestAuthorization(agentName, action, detail))
    );
  }

  private async requestAuthorization(agentName: string, action: string, detail: string): Promise<boolean> {
    const win = this.deps.getWindow();
    if (!win || win.isDestroyed()) return false;
    const request: AiMcpAuthRequest = {
      requestId: randomUUID(),
      agentName,
      action,
      detail,
      createdAt: new Date().toISOString(),
    };
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        this.pendingAuth.delete(request.requestId);
        resolve(false);
      }, 60_000);
      this.pendingAuth.set(request.requestId, { request, resolve, timer });
      win.webContents.send(IPC.AI_MCP_AUTH_REQUEST, request);
    });
  }

  private isAgentAllowed(agentName: string): boolean {
    return readAuthStore().alwaysAllow.includes(agentName);
  }

  private requireData(): DataLayer {
    const data = this.deps.getData();
    if (!data) throw new Error('项目数据尚未就绪');
    return data;
  }
}

export async function runMcpStdioServer(): Promise<void> {
  console.error('[ai-mcp] starting stdio bridge');
  const config = readMcpConfig();
  if (!config?.enabled || config.port <= 0 || !config.token) {
    throw new Error('MCP 未开启。请先在个人拉片工作台设置中开启本地 MCP。');
  }

  const server = new McpServer({
    name: 'personal-film-lab',
    version: app.getVersion(),
  });
  let agentName = 'MCP Client';
  server.server.oninitialized = () => {
    agentName = normalizeAgentName(server.server.getClientVersion()?.name);
  };

  const call = (tool: string, args?: Record<string, unknown>): Promise<unknown> =>
    callBridge(tool, args, agentName);
  const text = (value: unknown): { content: Array<{ type: 'text'; text: string }> } => ({
    content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }],
  });

  server.registerTool(
    'list_shots',
    {
      title: '列出镜头',
      description: '列出当前打开项目的镜头、标签摘要和笔记长度。',
      annotations: { readOnlyHint: true },
    },
    async () => text(await call('list_shots')),
  );
  server.registerTool(
    'get_shot_detail',
    {
      title: '读取镜头详情',
      description: '读取当前项目中一个镜头的完整字段、标签与笔记。',
      inputSchema: { shotId: z.string().min(1) },
      annotations: { readOnlyHint: true },
    },
    async ({ shotId }) => text(await call('get_shot_detail', { shotId })),
  );
  server.registerTool(
    'check_continuity',
    {
      title: '检查分镜连续性',
      description: '分析相邻镜头的景别、机位和运镜变化候选。',
      annotations: { readOnlyHint: true },
    },
    async () => text(await call('check_continuity')),
  );
  server.registerTool(
    'write_shot_note',
    {
      title: '写入镜头笔记',
      description: '写入当前项目某个镜头的笔记，需要用户在工作台授权。',
      inputSchema: { shotId: z.string().min(1), content: z.string().max(20_000) },
      annotations: { destructiveHint: true },
    },
    async ({ shotId, content }) => text(await call('write_shot_note', { shotId, content })),
  );
  server.registerTool(
    'get_project_summary',
    {
      title: '读取项目摘要',
      description: '读取当前项目镜头数量、标签分布和标注进度。',
      annotations: { readOnlyHint: true },
    },
    async () => text(await call('get_project_summary')),
  );
  server.registerTool(
    'run_shot_detection',
    {
      title: '启动 AI 镜头识别',
      description: '启动异步 AI 镜头识别；立即返回 jobId，用 get_detection_job 轮询。',
      inputSchema: {
        projectId: z.string().min(1).optional(),
        rangeMs: z.tuple([z.number().min(0), z.number().min(0)]).optional(),
      },
      annotations: { destructiveHint: true },
    },
    async ({ projectId, rangeMs }) =>
      text(await call('run_shot_detection', { projectId, rangeMs })),
  );
  server.registerTool(
    'get_detection_job',
    {
      title: '读取识别任务',
      description: '读取 AI 识别任务的状态、进度、分段、费用与错误。',
      inputSchema: { jobId: z.string().min(1) },
      annotations: { readOnlyHint: true },
    },
    async ({ jobId }) => text(await call('get_detection_job', { jobId })),
  );
  server.registerTool(
    'cancel_detection',
    {
      title: '取消识别任务',
      description: '取消运行中的 AI 识别任务；已完段结果保留。',
      inputSchema: { jobId: z.string().min(1) },
      annotations: { destructiveHint: true },
    },
    async ({ jobId }) => text(await call('cancel_detection', { jobId })),
  );
  server.registerTool(
    'apply_detection',
    {
      title: '应用识别结果',
      description: '把一个识别任务的预览镜头落库；locked / origin=manual 的镜头不会被覆盖。',
      inputSchema: {
        jobId: z.string().min(1),
        shotIds: z.array(z.string().min(1)).optional(),
        sceneIds: z.array(z.string().min(1)).optional(),
      },
      annotations: { destructiveHint: true },
    },
    async ({ jobId, shotIds, sceneIds }) =>
      text(await call('apply_detection', { jobId, shotIds, sceneIds })),
  );
  server.registerTool(
    'write_shot_tags',
    {
      title: '写入镜头标签',
      description: '按 category→name[] 写入镜头标签；不存在的标签会自动创建。',
      inputSchema: {
        shotId: z.string().min(1),
        tags: z.record(z.string(), z.array(z.string())),
      },
      annotations: { destructiveHint: true },
    },
    async ({ shotId, tags }) => text(await call('write_shot_tags', { shotId, tags })),
  );
  server.registerTool(
    'get_shot_thumbnail',
    {
      title: '读取镜头封面',
      description: '返回镜头封面路径；若尚无封面，按镜头中点精确抽帧生成 160px 缩略图。',
      inputSchema: { shotId: z.string().min(1) },
      annotations: { readOnlyHint: true },
    },
    async ({ shotId }) => text(await call('get_shot_thumbnail', { shotId })),
  );

  const transport = new StdioServerTransport(createFdReadable(0), createFdWritable(1));
  transport.onclose = () => app.quit();
  await server.connect(transport);
  console.error('[ai-mcp] stdio bridge ready');
}

function createFdReadable(fd: number): Readable {
  let pending = false;
  return new Readable({
    read() {
      if (pending) return;
      pending = true;
      const buffer = Buffer.allocUnsafe(64 * 1024);
      read(fd, buffer, 0, buffer.length, null, (error, bytesRead) => {
        pending = false;
        if (error) {
          this.destroy(error);
          return;
        }
        if (bytesRead === 0) {
          this.push(null);
          return;
        }
        this.push(buffer.subarray(0, bytesRead));
      });
    },
  });
}

function createFdWritable(fd: number): Writable {
  return new Writable({
    write(chunk: Buffer | string, encoding, callback) {
      try {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding);
        let offset = 0;
        while (offset < buffer.length) {
          offset += writeSync(fd, buffer, offset, buffer.length - offset);
        }
        callback();
      } catch (error) {
        callback(error as Error);
      }
    },
  });
}

function mcpCommand(): string {
  const args = app.isPackaged ? [process.execPath] : [process.execPath, app.getAppPath()];
  return [...args, '--ai-mcp'].map(quoteCommandArg).join(' ');
}

function quoteCommandArg(value: string): string {
  return /[\s"]/u.test(value) ? `"${value.replaceAll('"', '\\"')}"` : value;
}

function mcpConfigPath(): string {
  return join(app.getPath('userData'), 'mcp-config.json');
}

function authPath(): string {
  return join(app.getPath('userData'), 'mcp-auth.json');
}

function readMcpConfig(): McpBridgeConfig | null {
  try {
    const parsed = JSON.parse(readFileSync(mcpConfigPath(), 'utf8')) as Partial<McpBridgeConfig>;
    if (typeof parsed.enabled !== 'boolean' || typeof parsed.port !== 'number' || typeof parsed.token !== 'string') {
      return null;
    }
    return { enabled: parsed.enabled, port: parsed.port, token: parsed.token };
  } catch {
    return null;
  }
}

function writeMcpConfig(config: McpBridgeConfig): void {
  writeJsonAtomic(mcpConfigPath(), config);
}

function readAuthStore(): McpAuthStore {
  try {
    const parsed = JSON.parse(readFileSync(authPath(), 'utf8')) as Partial<McpAuthStore>;
    return {
      alwaysAllow: Array.isArray(parsed.alwaysAllow)
        ? parsed.alwaysAllow.filter((item): item is string => typeof item === 'string')
        : [],
    };
  } catch {
    return { alwaysAllow: [] };
  }
}

function writeJsonAtomic(path: string, value: unknown): void {
  mkdirSync(join(path, '..'), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  try {
    renameSync(temporary, path);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
}

function normalizeAgentName(value: unknown): string {
  const text = typeof value === 'string' ? value.trim() : '';
  return text.slice(0, 100) || 'MCP Client';
}

function defaultAiDetectOptions(): DetectOptions {
  return {
    sensitivity: 0.5,
    minShotSeconds: 1,
    filterTransitions: false,
    weights: { s: 0.15, c: 0.15, h: 0.25, hv: 0.2, edge: 0.1, grid: 0.15 },
    engine: 'ai',
  };
}

function readStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.map((item) => String(item)).filter(Boolean);
}

function readTagMap(value: unknown): Record<string, string[]> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const result: Record<string, string[]> = {};
  for (const [category, names] of Object.entries(value as Record<string, unknown>)) {
    if (!Array.isArray(names)) continue;
    result[String(category)] = names.map((item) => String(item)).filter(Boolean);
  }
  return result;
}

async function callBridge(tool: string, args: Record<string, unknown> | undefined, agentName: string): Promise<unknown> {
  const config = readMcpConfig();
  if (!config?.enabled || config.port <= 0 || !config.token) {
    throw new Error('MCP 已在个人拉片工作台中关闭');
  }
  const response = await fetch(`http://127.0.0.1:${config.port}/rpc`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${config.token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ tool, args, agentName }),
    signal: AbortSignal.timeout(65_000),
  });
  const payload = await response.json() as { result?: unknown; error?: { message?: string } };
  if (!response.ok) throw new Error(payload.error?.message ?? `MCP 桥接请求失败：${response.status}`);
  return payload.result;
}

function readRequestBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk: string) => {
      body += chunk;
      if (body.length > 2 * 1024 * 1024) {
        reject(new Error('MCP 请求体过大'));
        request.destroy();
      }
    });
    request.on('end', () => resolve(body));
    request.on('error', reject);
  });
}
