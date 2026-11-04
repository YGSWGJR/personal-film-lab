/** 统一时间码：HH:MM:SS.mmm；小时按实际值累计，不截断到 24 小时。 */
export function formatTimeMs(ms: number): string {
  const safeMs = Number.isFinite(ms) ? Math.max(0, Math.floor(ms)) : 0;
  const hours = Math.floor(safeMs / 3_600_000);
  const minutes = Math.floor((safeMs % 3_600_000) / 60_000);
  const seconds = Math.floor((safeMs % 60_000) / 1_000);
  const millis = safeMs % 1_000;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}.${String(millis).padStart(3, '0')}`;
}

/** 安全帧率：非法或非正数回退 24fps。全端帧级口径的唯一归一入口。 */
export function safeFps(fps: number): number {
  return Number.isFinite(fps) && fps > 0 ? fps : 24;
}

/** 帧号 = round(t × fps)。与 S36-4 口径一致：全端同源。 */
export function frameFromMs(timeMs: number, fps: number): number {
  const safeMs = Number.isFinite(timeMs) ? Math.max(0, timeMs) : 0;
  return Math.round((safeMs / 1000) * safeFps(fps));
}

/** 帧号 → 毫秒（round 到最近整毫秒）。 */
export function frameToMs(frame: number, fps: number): number {
  const safeFrame = Number.isFinite(frame) ? Math.max(0, Math.round(frame)) : 0;
  return Math.round((safeFrame / safeFps(fps)) * 1000);
}

/** HH:MM:SS:FF 时间码，FF 段 = frame % fps（round 口径）。 */
export function formatTimecodeFF(ms: number, fps: number): string {
  const safeMs = Number.isFinite(ms) ? Math.max(0, Math.floor(ms)) : 0;
  const fpsInt = Math.max(1, Math.round(safeFps(fps)));
  const frame = frameFromMs(safeMs, fps);
  const totalSeconds = Math.floor(safeMs / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const ff = frame % fpsInt;
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${pad(hours)}:${pad(minutes)}:${pad(seconds)}:${pad(ff)}`;
}

/**
 * 解析时间码输入：支持纯帧号（如 1234）或 HH:MM:SS:FF / HH:MM:SS / MM:SS。
 * 返回毫秒（round 到最近帧）；无法解析返回 null。
 */
export function parseTimecodeFF(text: string, fps: number): number | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  const fpsInt = Math.max(1, Math.round(safeFps(fps)));
  if (/^\d{1,9}$/u.test(trimmed)) {
    return frameToMs(Number(trimmed), fps);
  }
  const parts = trimmed.split(':');
  if (parts.length < 2 || parts.length > 4) return null;
  const values = parts.map((part) => Number(part.trim()));
  if (values.some((value) => !Number.isInteger(value) || value < 0)) return null;
  let hours = 0;
  let minutes = 0;
  let seconds = 0;
  let frames = 0;
  if (parts.length === 4) {
    [hours, minutes, seconds, frames] = values;
  } else if (parts.length === 3) {
    [hours, minutes, seconds] = values;
  } else {
    [minutes, seconds] = values;
  }
  if (minutes >= 60 || seconds >= 60 || frames >= fpsInt) return null;
  const totalSeconds = hours * 3600 + minutes * 60 + seconds;
  return Math.round(totalSeconds * 1000 + (frames / safeFps(fps)) * 1000);
}
