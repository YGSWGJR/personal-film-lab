import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { app } from 'electron';
import type { LocalAiStatus } from '../../shared/types';

export interface LocalVisionInput {
  id: string;
  index: number;
  startMs: number;
  endMs: number;
  imagePath: string;
}

export interface LocalVisionResult {
  id: string;
  index: number;
  remark: string;
  shotSize: string;
  cameraMethod: string;
  movement: string;
  lighting: string;
  subjects: string[];
  tags: Record<string, string[]>;
  confidence: number;
}

interface RuntimePaths {
  root: string;
  pythonPath: string;
  comfyRoot: string;
  modelPath: string;
  scriptPath: string;
}

interface WorkerMessage {
  id?: number;
  method?: string;
  result?: {
    items?: LocalVisionResult[];
    available?: boolean;
    loaded?: boolean;
    comfyRoot?: string;
    modelPath?: string;
  };
  params?: {
    percent?: number;
    completed?: number;
    total?: number;
  };
  error?: {
    code?: string;
    message?: string;
  };
}

const DEV_COMFY_ROOT = 'G:\\ai\\ComfyUI_ROB3700\\ComfyUI';
const DEV_MODEL_PATH = join(
  DEV_COMFY_ROOT,
  'models',
  'text_encoders',
  'qwen3vl_8b_w4a8.safetensors',
);

export class LocalVisionError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'LocalVisionError';
    this.code = code;
  }
}

export class LocalVisionService {
  private readonly appRoot = app.getAppPath();
  private activeChild: ChildProcessWithoutNullStreams | null = null;

  getStatus(): LocalAiStatus {
    const paths = this.resolvePaths();
    const available =
      existsSync(paths.pythonPath)
      && existsSync(paths.comfyRoot)
      && existsSync(paths.modelPath)
      && existsSync(paths.scriptPath);
    return {
      available,
      running: this.activeChild !== null,
      engine: 'qwen3vl-8b-w4a8',
      pythonPath: paths.pythonPath,
      comfyRoot: paths.comfyRoot,
      modelPath: paths.modelPath,
      error: available ? null : '本地 Qwen3-VL 运行环境或模型文件缺失',
    };
  }

  async analyze(
    items: LocalVisionInput[],
    options: {
      signal: AbortSignal;
      onProgress?: (completed: number, total: number, percent: number) => void;
    },
  ): Promise<LocalVisionResult[]> {
    if (items.length === 0) return [];
    if (this.activeChild) {
      throw new LocalVisionError('LOCAL_AI_BUSY', '本地视觉模型正在执行其他分析任务');
    }
    const paths = this.resolvePaths();
    const status = this.getStatus();
    if (!status.available) {
      throw new LocalVisionError('LOCAL_AI_NOT_READY', status.error ?? '本地视觉模型不可用');
    }

    const requestId = Math.floor(Date.now() % 2_000_000_000);
    const child = spawn(
      paths.pythonPath,
      [
        '-s',
        paths.scriptPath,
        '--comfy-root',
        paths.comfyRoot,
        '--model-path',
        paths.modelPath,
        '--batch-size',
        '4',
        '--max-image-side',
        '256',
        '--max-tokens',
        '512',
      ],
      {
        cwd: paths.comfyRoot,
        windowsHide: true,
        env: {
          ...process.env,
          PYTHONIOENCODING: 'utf-8',
          PYTHONUNBUFFERED: '1',
          HF_HUB_OFFLINE: '1',
          TRANSFORMERS_OFFLINE: '1',
          TQDM_DISABLE: '1',
        },
      },
    );
    this.activeChild = child;

    let stderr = '';
    let stdoutBuffer = '';
    const timeoutMs = Math.max(
      30 * 60_000,
      Math.min(12 * 60 * 60_000, items.length * 45_000),
    );

    const promise = new Promise<LocalVisionResult[]>((resolveResult, reject) => {
      let settled = false;
      const settle = (fn: () => void): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        options.signal.removeEventListener('abort', onAbort);
        fn();
      };
      const onAbort = (): void => {
        child.kill();
        settle(() => reject(new LocalVisionError('LOCAL_AI_CANCELLED', '本地视觉分析已取消')));
      };
      const timeout = setTimeout(() => {
        child.kill();
        settle(() => reject(new LocalVisionError('LOCAL_AI_TIMEOUT', '本地视觉分析超时')));
      }, timeoutMs);
      timeout.unref?.();

      if (options.signal.aborted) {
        onAbort();
        return;
      }
      options.signal.addEventListener('abort', onAbort, { once: true });

      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => {
        stdoutBuffer += chunk;
        let newline = stdoutBuffer.indexOf('\n');
        while (newline >= 0) {
          const line = stdoutBuffer.slice(0, newline).trim();
          stdoutBuffer = stdoutBuffer.slice(newline + 1);
          newline = stdoutBuffer.indexOf('\n');
          if (!line) continue;
          let message: WorkerMessage;
          try {
            message = JSON.parse(line) as WorkerMessage;
          } catch {
            console.warn(`[local-ai] 忽略非协议输出：${line.slice(0, 240)}`);
            continue;
          }
          if (message.id !== requestId) continue;
          if (message.method === 'progress') {
            const completed = Number(message.params?.completed ?? 0);
            const total = Number(message.params?.total ?? items.length);
            const percent = Number(message.params?.percent ?? 0);
            options.onProgress?.(completed, total, percent);
            continue;
          }
          if (message.result?.items) {
            settle(() => resolveResult(message.result?.items ?? []));
            continue;
          }
          if (message.error) {
            settle(() =>
              reject(
                new LocalVisionError(
                  message.error?.code ?? 'LOCAL_AI_FAILED',
                  message.error?.message ?? '本地视觉模型执行失败',
                ),
              ),
            );
          }
        }
      });

      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (chunk: string) => {
        stderr = `${stderr}${chunk}`.slice(-8000);
      });
      child.on('error', (error) => {
        settle(() => reject(new LocalVisionError('LOCAL_AI_SPAWN_FAILED', error.message)));
      });
      child.on('exit', (code) => {
        if (!settled) {
          const detail = stderr.trim().slice(-2500);
          settle(() =>
            reject(
              new LocalVisionError(
                'LOCAL_AI_PROCESS_FAILED',
                `本地视觉进程退出（${code ?? 'unknown'}）${detail ? `：${detail}` : ''}`,
              ),
            ),
          );
        }
      });

      child.stdin.write(
        `${JSON.stringify({
          id: requestId,
          method: 'analyze',
          params: {
            batchSize: 4,
            items: items.map((item) => ({
              id: item.id,
              index: item.index,
              startMs: item.startMs,
              endMs: item.endMs,
              imagePath: resolve(item.imagePath).replace(/\\/gu, '/'),
            })),
          },
        })}\n`,
      );
    });

    try {
      return await promise;
    } finally {
      if (!child.killed) child.kill();
      if (this.activeChild === child) this.activeChild = null;
    }
  }

  dispose(): void {
    this.activeChild?.kill();
    this.activeChild = null;
  }

  private resolvePaths(): RuntimePaths {
    const bundledRoots = [
      process.env['LAPIAN_LOCAL_AI_ROOT'],
      process.resourcesPath ? join(process.resourcesPath, 'local-ai') : null,
      join(this.appRoot, 'resources', 'local-ai'),
    ].filter((value): value is string => Boolean(value));
    const bundledRoot = bundledRoots.find((root) =>
      existsSync(join(root, 'bridge', 'local_ai_worker.py')),
    );

    const runtimeRoot = bundledRoot ?? 'G:\\ai\\ComfyUI_ROB3700';
    const pythonCandidates = [
      join(runtimeRoot, 'runtime', 'python_embeded', 'python.exe'),
      join(runtimeRoot, 'python_embeded', 'python.exe'),
      join(DEV_COMFY_ROOT, '..', 'python_embeded', 'python.exe'),
      'G:\\ai\\ComfyUI_ROB3700\\python_embeded\\python.exe',
    ];
    const comfyCandidates = [
      join(runtimeRoot, 'ComfyUI'),
      DEV_COMFY_ROOT,
    ];
    const modelCandidates = [
      join(
        runtimeRoot,
        'models',
        'text_encoders',
        'qwen3vl_8b_w4a8.safetensors',
      ),
      DEV_MODEL_PATH,
    ];
    const scriptCandidates = [
      bundledRoot ? join(bundledRoot, 'bridge', 'local_ai_worker.py') : null,
      join(this.appRoot, 'resources', 'local-ai', 'bridge', 'local_ai_worker.py'),
    ].filter((value): value is string => Boolean(value));

    return {
      root: runtimeRoot,
      pythonPath: firstExisting(pythonCandidates) ?? pythonCandidates[0],
      comfyRoot: firstExisting(comfyCandidates) ?? comfyCandidates[0],
      modelPath: firstExisting(modelCandidates) ?? modelCandidates[0],
      scriptPath: firstExisting(scriptCandidates) ?? scriptCandidates[0],
    };
  }
}

function firstExisting(paths: string[]): string | null {
  return paths.find((path) => existsSync(path)) ?? null;
}
