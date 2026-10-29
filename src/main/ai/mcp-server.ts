import { randomBytes, randomUUID } from 'node:crypto';
import {
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
  AiMcpAuthRequest,
  AiMcpAuthResponseArgs,
  AiMcpDataChangedEvent,
  AiMcpStatus,
  AiProjectSnapshot,
  WorkspaceState,
} from '../../shared/types';
import { buildAiPrompt, buildSnapshotOnlyPrompt } from './ai-prompts';
import {
  buildContinuityCandidates,
  buildProjectSnapshot,
  buildProjectSummary,
} from './shot-snapshot';

interface AiAccessDeps {
  getWindow: () => BrowserWindow | null;
  getData: () => DataLayer | null;
  getSessionState: () => WorkspaceState | null;
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
    const projectId = this.deps.getSessionState()?.projectId;
    if (!projectId) throw new Error('当前没有打开的项目');
    const snapshot = buildProjectSnapshot(data, projectId);

    switch (payload.tool) {
      case 'list_shots':
        return {
          project: snapshot.project,
          shots: snapshot.shots.map((shot) => ({
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
      case 'get_shot_detail': {
        const shotId = String(payload.args?.shotId ?? '');
        const shot = snapshot.shots.find((item) => item.id === shotId);
        if (!shot) throw new Error('镜头不存在或不属于当前项目');
        return shot;
      }
      case 'check_continuity':
        return { candidates: buildContinuityCandidates(snapshot) };
      case 'get_project_summary':
        return buildProjectSummary(snapshot);
      case 'write_shot_note': {
        const shotId = String(payload.args?.shotId ?? '');
        const content = String(payload.args?.content ?? '');
        const shot = snapshot.shots.find((item) => item.id === shotId);
        if (!shot) throw new Error('镜头不存在或不属于当前项目');
        const agentName = normalizeAgentName(payload.agentName);
        const allowed =
          this.isAgentAllowed(agentName) ||
          (await this.requestAuthorization(
            agentName,
            '写入镜头笔记',
            `镜头 ${String(shot.index).padStart(2, '0')}，${content.length} 个字符`,
          ));
        if (!allowed) throw new Error('用户拒绝了 MCP 写入请求');
        const existing = data.notes.list({ shotId })[0];
        const note = data.notes.upsert({
          id: existing?.id,
          projectId,
          shotId,
          text: content,
        });
        const changed: AiMcpDataChangedEvent = { projectId, shotId };
        const win = this.deps.getWindow();
        if (win && !win.isDestroyed()) win.webContents.send(IPC.AI_MCP_DATA_CHANGED, changed);
        return { written: true, note };
      }
      default:
        throw new Error(`未知 MCP 工具：${payload.tool}`);
    }
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
