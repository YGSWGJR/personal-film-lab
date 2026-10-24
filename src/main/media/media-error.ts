/**
 * MediaService 领域错误与诊断信息（S01 §5.2）。
 * code 会透传给渲染层；details 用于失败诊断（stderr 尾部 / 退出码 / 命令 / 耗时）。
 */

export interface MediaDiagnostics {
  command?: string;
  exitCode?: number | null;
  stderr?: string;
  elapsedMs?: number;
  timeoutMs?: number;
  [key: string]: unknown;
}

export class MediaError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly details?: MediaDiagnostics,
  ) {
    super(message);
    this.name = 'MediaError';
  }
}

/** 保留 stderr 尾部，避免错误对象过大 */
export function tailText(text: string, maxLength = 2000): string {
  const trimmed = text.trim();
  if (trimmed.length <= maxLength) return trimmed;
  return `…${trimmed.slice(-maxLength)}`;
}

export function diagnosticsOf(
  command: string,
  result: { exitCode: number | null; stderr: string; elapsedMs: number; timedOut?: boolean; aborted?: boolean },
  extra?: Record<string, unknown>,
): MediaDiagnostics {
  return {
    command,
    exitCode: result.exitCode,
    stderr: tailText(result.stderr),
    elapsedMs: result.elapsedMs,
    timedOut: result.timedOut ?? false,
    aborted: result.aborted ?? false,
    ...extra,
  };
}