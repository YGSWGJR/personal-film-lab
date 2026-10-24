import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { app } from 'electron';
import { MediaError } from './media-error';

/**
 * FFmpeg 二进制解析（S01 §5.2 / README「媒体处理（FFmpeg）」）：
 * - 开发期：<repo>/resources/ffmpeg/{ffmpeg.exe,ffprobe.exe}
 * - 打包后：<process.resourcesPath>/ffmpeg/...（electron-builder extraResources）
 * - 兜底：系统 PATH 中的 ffmpeg / ffprobe（仅开发期便利）
 */

export interface FfmpegBinaries {
  ffmpeg: string;
  ffprobe: string;
  source: 'resources' | 'path';
  version: string;
}

let cached: Promise<FfmpegBinaries> | null = null;

function findInPath(names: string[]): string | null {
  const pathValue = process.env['PATH'] ?? '';
  const separators = pathValue.split(';').filter(Boolean);
  for (const dir of separators) {
    for (const name of names) {
      const candidate = join(dir, name);
      try {
        if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
      } catch {
        // ignore unreadable PATH entries
      }
    }
  }
  return null;
}

function resolveSync(): { ffmpeg: string; ffprobe: string; source: 'resources' | 'path' } {
  const dirs = app.isPackaged
    ? [join(process.resourcesPath, 'ffmpeg')]
    : [
        join(app.getAppPath(), 'resources', 'ffmpeg'),
        join(process.cwd(), 'resources', 'ffmpeg'),
      ];

  for (const dir of dirs) {
    const ffmpeg = join(dir, 'ffmpeg.exe');
    const ffprobe = join(dir, 'ffprobe.exe');
    if (existsSync(ffmpeg) && existsSync(ffprobe)) {
      return { ffmpeg, ffprobe, source: 'resources' };
    }
  }

  const ffmpeg = findInPath(['ffmpeg.exe', 'ffmpeg']);
  const ffprobe = findInPath(['ffprobe.exe', 'ffprobe']);
  if (ffmpeg && ffprobe) {
    return { ffmpeg, ffprobe, source: 'path' };
  }

  throw new MediaError(
    'FFMPEG_NOT_FOUND',
    '未找到 ffmpeg / ffprobe，请把二进制放到 resources/ffmpeg/ 或加入系统 PATH',
    {
      searched: dirs,
      hint: '开发期可执行 winget install Gyan.FFmpeg，或拷贝 ffmpeg.exe/ffprobe.exe 到 resources/ffmpeg/',
    },
  );
}

/** 读取并缓存 FFmpeg 版本，同时验证二进制可执行 */
export function resolveFfmpegBinaries(): Promise<FfmpegBinaries> {
  if (cached) return cached;

  cached = (async () => {
    const resolved = resolveSync();
    // 懒引入，避免主进程启动即加载 child_process
    const { spawnSync } = await import('node:child_process');
    const probe = spawnSync(resolved.ffmpeg, ['-version'], {
      windowsHide: true,
      encoding: 'utf8',
      timeout: 10_000,
    });
    if (probe.error || probe.status !== 0) {
      throw new MediaError('FFMPEG_BROKEN', `ffmpeg 无法执行：${probe.error?.message ?? probe.stderr ?? 'unknown'}`, {
        ffmpeg: resolved.ffmpeg,
        exitCode: probe.status,
      });
    }
    const firstLine = String(probe.stdout || '').split(/\r?\n/)[0] ?? '';
    const version = /ffmpeg version\s+([^\s]+)/i.exec(firstLine)?.[1] ?? 'unknown';
    return { ...resolved, version };
  })();

  cached.catch(() => {
    cached = null;
  });
  return cached;
}