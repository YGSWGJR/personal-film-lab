import { randomUUID } from 'node:crypto';
import { existsSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import type { Annotation, Still } from '../../shared/types';
import type { DataLayer } from '../../data/db';
import { ensureProjectDirs } from '../../data/paths';
import type { MediaService } from '../media/media-service';
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

    const projectDir = ensureProjectDirs(this.data.dataRoot, project.id);
    const suffix = `${String(Math.round(args.timeMs)).padStart(8, '0')}-${randomUUID().slice(0, 8)}`;
    const pngPath = join(projectDir, 'stills', `still-${suffix}.png`);
    const thumbPath = join(projectDir, 'stills', `still-${suffix}-thumb.jpg`);

    try {
      const frame = await this.media.extractFrame({
        path: sourcePath,
        timeMs: args.timeMs,
        outputPath: pngPath,
        format: 'png',
      });
      await this.media.createThumbnail(pngPath, thumbPath, 480);

      const still = this.data.stills.create({
        projectId: project.id,
        shotId,
        timeMs: args.timeMs,
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
