/** 数据层领域错误：code 透传给渲染层 */
export class DataError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'DataError';
  }
}

export function isSqliteConstraintError(error: unknown): boolean {
  const err = error as { code?: string; message?: string };
  return err?.code === 'SQLITE_CONSTRAINT_FOREIGNKEY'
    || err?.code === 'SQLITE_CONSTRAINT_UNIQUE'
    || err?.code === 'SQLITE_CONSTRAINT_PRIMARYKEY'
    || err?.code === 'SQLITE_CONSTRAINT_CHECK'
    || (typeof err?.message === 'string' && /constraint failed/i.test(err.message));
}