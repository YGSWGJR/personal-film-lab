import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { app } from 'electron';
import { workspaceStateSchema } from '../../shared/schemas';
import type { WorkspaceState } from '../../shared/types';

export class SessionError extends Error {
  readonly code: string;
  readonly details?: Record<string, unknown>;

  constructor(code: string, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = 'SessionError';
    this.code = code;
    this.details = details;
  }
}

/** 工作区会话：settings.json 之外单独存放，避免路径设置与瞬时 UI 状态耦合。 */
export class SessionService {
  private readonly sessionPath: string;
  private latest: WorkspaceState | null = null;
  private readComplete = false;

  constructor() {
    this.sessionPath = join(app.getPath('userData'), 'session.json');
  }

  get(): WorkspaceState | null {
    if (!this.readComplete) {
      this.latest = this.readSession();
      this.readComplete = true;
    }
    return this.latest;
  }

  save(state: WorkspaceState): WorkspaceState {
    const parsed = workspaceStateSchema.safeParse(state);
    if (!parsed.success) {
      throw new SessionError('SESSION_INVALID', parsed.error.message);
    }
    this.latest = parsed.data;
    this.readComplete = true;
    this.writeAtomically(this.latest);
    return this.latest;
  }

  clear(): { cleared: true } {
    this.latest = null;
    this.readComplete = true;
    rmSync(this.sessionPath, { force: true });
    rmSync(`${this.sessionPath}.tmp`, { force: true });
    return { cleared: true };
  }

  /** before-quit 最后兜底；写盘失败不能阻止应用退出。 */
  flush(): void {
    if (!this.latest) return;
    try {
      this.writeAtomically(this.latest);
    } catch (error) {
      console.warn(`[session] 退出时保存失败：${(error as Error).message}`);
    }
  }

  private readSession(): WorkspaceState | null {
    if (!existsSync(this.sessionPath)) return null;
    try {
      const parsed = workspaceStateSchema.safeParse(
        JSON.parse(readFileSync(this.sessionPath, 'utf8')) as unknown,
      );
      if (parsed.success) return parsed.data;
      rmSync(this.sessionPath, { force: true });
      return null;
    } catch {
      rmSync(this.sessionPath, { force: true });
      return null;
    }
  }

  private writeAtomically(state: WorkspaceState): void {
    const tmpPath = `${this.sessionPath}.tmp`;
    writeFileSync(tmpPath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
    try {
      renameSync(tmpPath, this.sessionPath);
    } catch (error) {
      rmSync(tmpPath, { force: true });
      throw new SessionError('SESSION_WRITE_FAILED', (error as Error).message, {
        path: this.sessionPath,
      });
    }
  }
}
