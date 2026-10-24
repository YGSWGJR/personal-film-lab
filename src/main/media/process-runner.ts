import { spawn } from 'node:child_process';
import { MediaError } from './media-error';

export interface RunProcessOptions {
  command: string;
  args: string[];
  timeoutMs: number;
  signal?: AbortSignal;
  onStdoutLine?: (line: string) => void;
  onStderrLine?: (line: string) => void;
  maxStdoutBytes?: number;
  maxStderrBytes?: number;
}

export interface RunProcessResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  elapsedMs: number;
  timedOut: boolean;
  aborted: boolean;
}

const DEFAULT_MAX_STDOUT = 16 * 1024 * 1024;
const DEFAULT_MAX_STDERR = 256 * 1024;

/** 生成便于日志阅读的命令行（仅诊断用，不用于执行） */
export function formatCommand(command: string, args: string[]): string {
  const quote = (value: string): string => (/[\s"]/u.test(value) ? `"${value.replace(/"/g, '\\"')}"` : value);
  return [command, ...args].map(quote).join(' ');
}

/**
 * 统一子进程执行器（S01 §5.2）：
 * - 收集 stdout/stderr（stderr 保留尾部，避免长转码刷屏占用内存）；
 * - 支持超时与 AbortSignal 取消，超时/取消时结束进程树；
 * - 子进程启动失败抛 MediaError('FFMPEG_SPAWN_FAILED')。
 */
export function runProcess(options: RunProcessOptions): Promise<RunProcessResult> {
  const {
    command,
    args,
    timeoutMs,
    signal,
    onStdoutLine,
    onStderrLine,
    maxStdoutBytes = DEFAULT_MAX_STDOUT,
    maxStderrBytes = DEFAULT_MAX_STDERR,
  } = options;

  return new Promise<RunProcessResult>((resolve, reject) => {
    const startedAt = Date.now();
    let child;
    try {
      child = spawn(command, args, {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      reject(
        new MediaError('FFMPEG_SPAWN_FAILED', `启动子进程失败：${(error as Error).message}`, {
          command: formatCommand(command, args),
        }),
      );
      return;
    }

    let stdout = '';
    let stderr = '';
    let stdoutTruncated = false;
    let stdoutLineBuffer = '';
    let stderrLineBuffer = '';
    let timedOut = false;
    let aborted = false;
    let exited = false;
    let settled = false;

    const appendStdout = (chunk: string): void => {
      if (stdout.length + chunk.length > maxStdoutBytes) {
        stdoutTruncated = true;
        stdout += chunk.slice(0, Math.max(0, maxStdoutBytes - stdout.length));
      } else {
        stdout += chunk;
      }
    };

    const appendStderr = (chunk: string): void => {
      stderr += chunk;
      if (stderr.length > maxStderrBytes) {
        stderr = stderr.slice(-maxStderrBytes);
      }
    };

    const flushLines = (buffer: string, handler: ((line: string) => void) | undefined): string => {
      if (!handler) return buffer;
      const lines = buffer.split(/\r?\n/);
      const rest = lines.pop() ?? '';
      for (const line of lines) {
        if (line.length > 0) handler(line);
      }
      return rest;
    };

    child.stdout?.on('data', (data: Buffer) => {
      const text = data.toString('utf8');
      appendStdout(text);
      if (onStdoutLine) {
        stdoutLineBuffer += text;
        stdoutLineBuffer = flushLines(stdoutLineBuffer, onStdoutLine);
      }
    });

    child.stderr?.on('data', (data: Buffer) => {
      const text = data.toString('utf8');
      appendStderr(text);
      if (onStderrLine) {
        stderrLineBuffer += text;
        stderrLineBuffer = flushLines(stderrLineBuffer, onStderrLine);
      }
    });

    const killTree = (): void => {
      if (exited) return;
      try {
        child.kill();
      } catch {
        // ignore
      }
      // Windows 下确保进程树结束（ffmpeg 通常无子进程，兜底 taskkill）
      setTimeout(() => {
        if (exited || !child.pid) return;
        try {
          const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
            windowsHide: true,
            stdio: 'ignore',
          });
          killer.unref();
        } catch {
          // ignore
        }
      }, 1200).unref?.();
    };

    const timeout = setTimeout(() => {
      timedOut = true;
      killTree();
    }, timeoutMs);
    timeout.unref?.();

    const onAbort = (): void => {
      aborted = true;
      killTree();
    };
    if (signal) {
      if (signal.aborted) {
        aborted = true;
        killTree();
      } else {
        signal.addEventListener('abort', onAbort, { once: true });
      }
    }

    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      signal?.removeEventListener('abort', onAbort);
      reject(
        new MediaError('FFMPEG_SPAWN_FAILED', `子进程执行失败：${error.message}`, {
          command: formatCommand(command, args),
        }),
      );
    });

    child.on('close', (code, signalName) => {
      exited = true;
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      signal?.removeEventListener('abort', onAbort);

      const elapsedMs = Date.now() - startedAt;
      if (stdoutTruncated) {
        stderr += '\n[stdout truncated by media service]';
      }
      resolve({
        exitCode: code,
        signal: signalName ?? null,
        stdout,
        stderr,
        elapsedMs,
        timedOut,
        aborted,
      });
    });
  });
}