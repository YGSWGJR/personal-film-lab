import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Annotation, Still } from '../../shared/types';
import { formatTimeMs } from '../../shared/time';
import type { DataLayer } from '../../data/db';
import { ensureProjectDirs } from '../../data/paths';
import type { MediaService } from '../media/media-service';
import { resolveProjectStillDir } from '../paths';
import { CaptureError } from './capture-error';

/**
 * CaptureService（S01 §5.5）：
 * 精确时间点抽 PNG 原图 → 同帧生成 JPEG 缩略图 → 创建 still 记录 → 维护标注。
 * 截图不依赖 libmpv 的当前输出，避免播放状态和 seek 时序造成非确定性。
 */
export class CaptureService {
  constructor(
    private readonly data: DataLayer,
    private readonly media: MediaService,
    private readonly onCreated?: (still: Still) => void,
  ) {}

  async capture(args: {
    projectId: string;
    timeMs: number;
    shotId?: string | null;
    caption?: string | null;
  }): Promise<Still> {
    return this.captureWithRole(args, 'main');
  }

  private async captureWithRole(
    args: {
      projectId: string;
      timeMs: number;
      shotId?: string | null;
      caption?: string | null;
    },
    role: 'main' | 'auto-thumb',
  ): Promise<Still> {
    const project = this.data.projects.get(args.projectId);
    const sourcePath = project.source.path || project.media.proxyPath;
    if (!sourcePath) {
      throw new CaptureError('CAPTURE_SOURCE_MISSING', '项目没有可读取的本地影片路径', {
        projectId: project.id,
      });
    }

    let shotId = args.shotId ?? null;
    if (shotId) {
      const shot = this.data.shots.get(shotId);
      if (shot.projectId !== project.id) {
        throw new CaptureError('SHOT_PROJECT_MISMATCH', '镜头不属于当前项目', {
          projectId: project.id,
          shotId,
        });
      }
    } else {
      const shot = this.data.shots
        .list(project.id)
        .find((item) => args.timeMs >= item.startMs && args.timeMs < item.endMs);
      shotId = shot?.id ?? null;
    }

    ensureProjectDirs(this.data.dataRoot, project.id);
    const stillDir = resolveProjectStillDir(project.id);
    mkdirSync(stillDir, { recursive: true });
    const capturedTimeMs = Math.max(0, Math.round(args.timeMs));
    const suffix = `${String(capturedTimeMs).padStart(8, '0')}-${randomUUID().slice(0, 8)}`;
    const pngPath = join(stillDir, `still-${suffix}.png`);
    const thumbPath = join(stillDir, `still-${suffix}-thumb.jpg`);

    try {
      const frame = await this.media.extractFrame({
        path: sourcePath,
        timeMs: capturedTimeMs,
        outputPath: pngPath,
        format: 'png',
      });
      try {
        writePngTimeMetadata(pngPath, capturedTimeMs);
      } catch (error) {
        console.warn(`[capture] PNG time metadata failed: ${(error as Error).message}`);
      }
      await this.media.createThumbnail(pngPath, thumbPath, 480);

      const still = this.data.stills.create({
        projectId: project.id,
        shotId,
        timeMs: capturedTimeMs,
        filePath: pngPath,
        thumbPath,
        width: frame.width,
        height: frame.height,
        caption: args.caption ?? null,
        role,
        annotations: [],
      });
      try {
        this.onCreated?.(still);
      } catch {
        // 事件推送失败不能回滚已成功落库的静帧
      }
      return still;
    } catch (error) {
      this.removeFile(pngPath);
      this.removeFile(thumbPath);
      throw error;
    }
  }

  async captureAt(args: { shotId: string; caption?: string | null }): Promise<Still> {
    const shot = this.data.shots.get(args.shotId);
    const existing = this.data.stills
      .list({ shotId: shot.id })
      .find(
        (still) =>
          still.role === 'auto-thumb' &&
          existsSync(this.resolveStillPath(still.projectId, still.filePath)) &&
          Boolean(still.thumbPath) &&
          existsSync(this.resolveStillPath(still.projectId, still.thumbPath as string)),
      );
    if (existing) return existing;
    return this.captureWithRole({
      projectId: shot.projectId,
      shotId: shot.id,
      timeMs: Math.round((shot.startMs + shot.endMs) / 2),
      caption: args.caption ?? `镜头 ${String(shot.index).padStart(2, '0')} 自动缩略图`,
    }, 'auto-thumb');
  }

  setAnnotations(id: string, annotations: Annotation[]): Still {
    return this.data.stills.update({ id, patch: { annotations } });
  }

  private removeFile(filePath: string): void {
    try {
      if (existsSync(filePath)) unlinkSync(filePath);
    } catch {
      // 清理失败不覆盖原始领域错误
    }
  }

  private resolveStillPath(projectId: string, filePath: string): string {
    return /^[a-zA-Z]:[\\/]/u.test(filePath) || filePath.startsWith('/')
      ? filePath
      : join(this.data.dataRoot, 'projects', projectId, filePath);
  }
}

export function writePngTimeMetadata(pngPath: string, timeMs: number): void {
  const source = readFileSync(pngPath);
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (source.length < 8 || !source.subarray(0, 8).equals(signature)) {
    throw new Error('not a PNG file');
  }

  let iendOffset = -1;
  let offset = 8;
  while (offset + 12 <= source.length) {
    const length = source.readUInt32BE(offset);
    const type = source.toString('ascii', offset + 4, offset + 8);
    const next = offset + 12 + length;
    if (next > source.length) throw new Error('invalid PNG chunk length');
    if (type === 'IEND') {
      iendOffset = offset;
      break;
    }
    offset = next;
  }
  if (iendOffset < 0) throw new Error('PNG IEND chunk not found');

  const metadata = [
    pngTextChunk('Time', formatTimeMs(timeMs)),
    pngTextChunk('TimeMs', String(Math.max(0, Math.round(timeMs)))),
  ];
  const output = Buffer.concat([
    source.subarray(0, iendOffset),
    ...metadata,
    source.subarray(iendOffset),
  ]);
  writeFileSync(pngPath, output);
}

function pngTextChunk(keyword: string, value: string): Buffer {
  const data = Buffer.from(`${keyword}\0${value}`, 'latin1');
  const type = Buffer.from('tEXt', 'ascii');
  const chunk = Buffer.allocUnsafe(12 + data.length);
  chunk.writeUInt32BE(data.length, 0);
  type.copy(chunk, 4);
  data.copy(chunk, 8);
  chunk.writeUInt32BE(crc32(Buffer.concat([type, data])), 8 + data.length);
  return chunk;
}

const CRC_TABLE = Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) {
    value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  }
  return value >>> 0;
});

function crc32(data: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc = (CRC_TABLE[(crc ^ byte) & 0xff] ?? 0) ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
