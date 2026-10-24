export class CaptureError extends Error {
  readonly code: string;
  readonly details?: Record<string, unknown>;

  constructor(code: string, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = 'CaptureError';
    this.code = code;
    this.details = details;
  }
}
