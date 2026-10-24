import { randomUUID } from 'node:crypto';
import type { Annotation, Still, StillCreateArgs, StillUpdateArgs } from '../../shared/types';
import type { DataLayer } from '../db';
import { DataError } from '../errors';
import { toProjectRelativePath } from '../paths';
import { nowIso } from './projects';

interface StillRow {
  id: string;
  project_id: string;
  shot_id: string | null;
  time_ms: number;
  file_path: string;
  thumb_path: string | null;
  width: number | null;
  height: number | null;
  caption: string | null;
  role: string;
  annotations_json: string;
  created_at: string;
  updated_at: string;
}

export class StillRepository {
  constructor(private readonly layer: DataLayer) {}

  private get db() {
    return this.layer.db;
  }

  list(args: { projectId?: string; shotId?: string }): Still[] {
    let rows: StillRow[];
    if (args.shotId) {
      rows = this.db
        .prepare('SELECT * FROM stills WHERE shot_id = ? ORDER BY time_ms ASC')
        .all(args.shotId) as StillRow[];
    } else {
      rows = this.db
        .prepare('SELECT * FROM stills WHERE project_id = ? ORDER BY time_ms ASC')
        .all(args.projectId) as StillRow[];
    }
    return rows.map(mapStill);
  }

  get(id: string): Still {
    const row = this.db.prepare('SELECT * FROM stills WHERE id = ?').get(id) as StillRow | undefined;
    if (!row) throw new DataError('STILL_NOT_FOUND', `静帧不存在：${id}`, { id });
    return mapStill(row);
  }

  create(args: StillCreateArgs): Still {
    this.assertProject(args.projectId);
    if (args.shotId) this.assertShotInProject(args.shotId, args.projectId);
    const id = randomUUID();
    const now = nowIso();
    const filePath = toProjectRelativePath(this.layer.dataRoot, args.projectId, args.filePath);
    const thumbPath = args.thumbPath
      ? toProjectRelativePath(this.layer.dataRoot, args.projectId, args.thumbPath)
      : null;

    this.layer.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO stills (
            id, project_id, shot_id, time_ms, file_path, thumb_path, width, height,
            caption, role, annotations_json, created_at, updated_at
          ) VALUES (
            @id, @projectId, @shotId, @timeMs, @filePath, @thumbPath, @width, @height,
            @caption, @role, @annotationsJson, @createdAt, @updatedAt
          )`,
        )
        .run({
          id,
          projectId: args.projectId,
          shotId: args.shotId ?? null,
          timeMs: Math.max(0, Math.round(args.timeMs)),
          filePath,
          thumbPath,
          width: args.width ?? null,
          height: args.height ?? null,
          caption: args.caption ?? null,
          role: args.role ?? 'main',
          annotationsJson: JSON.stringify(args.annotations ?? []),
          createdAt: now,
          updatedAt: now,
        });
      this.layer.projects.touch(args.projectId);
    });

    return this.get(id);
  }

  update(args: StillUpdateArgs): Still {
    const current = this.get(args.id);
    const patch = args.patch ?? {};
    const shotId = patch.shotId !== undefined ? patch.shotId : current.shotId;
    if (shotId) this.assertShotInProject(shotId, current.projectId);
    const filePath =
      patch.filePath !== undefined
        ? toProjectRelativePath(this.layer.dataRoot, current.projectId, patch.filePath)
        : current.filePath;
    const thumbPath =
      patch.thumbPath !== undefined
        ? patch.thumbPath
          ? toProjectRelativePath(this.layer.dataRoot, current.projectId, patch.thumbPath)
          : null
        : current.thumbPath;

    this.layer.transaction(() => {
      this.db
        .prepare(
          `UPDATE stills SET
            shot_id = @shotId, time_ms = @timeMs, file_path = @filePath, thumb_path = @thumbPath,
            width = @width, height = @height, caption = @caption, role = @role,
            annotations_json = @annotationsJson, updated_at = @updatedAt
          WHERE id = @id`,
        )
        .run({
          id: current.id,
          shotId,
          timeMs: patch.timeMs ?? current.timeMs,
          filePath,
          thumbPath,
          width: patch.width !== undefined ? patch.width : current.width,
          height: patch.height !== undefined ? patch.height : current.height,
          caption: patch.caption !== undefined ? patch.caption : current.caption,
          role: patch.role ?? current.role,
          annotationsJson: JSON.stringify(patch.annotations !== undefined ? patch.annotations : current.annotations),
          updatedAt: nowIso(),
        });
      this.layer.projects.touch(current.projectId);
    });

    return this.get(current.id);
  }

  delete(id: string): void {
    const current = this.get(id);
    this.layer.transaction(() => {
      this.db.prepare('DELETE FROM stills WHERE id = ?').run(id);
      this.layer.projects.touch(current.projectId);
    });
  }

  private assertProject(projectId: string): void {
    if (!this.layer.projects.exists(projectId)) {
      throw new DataError('PROJECT_NOT_FOUND', `项目不存在：${projectId}`, { projectId });
    }
  }

  private assertShotInProject(shotId: string, projectId: string): void {
    const row = this.db.prepare('SELECT project_id FROM shots WHERE id = ?').get(shotId) as
      | { project_id: string }
      | undefined;
    if (!row) throw new DataError('SHOT_NOT_FOUND', `镜头不存在：${shotId}`, { shotId });
    if (row.project_id !== projectId) {
      throw new DataError('SHOT_PROJECT_MISMATCH', '镜头不属于该项目', { shotId, projectId });
    }
  }
}

function mapStill(row: StillRow): Still {
  return {
    id: row.id,
    projectId: row.project_id,
    shotId: row.shot_id,
    timeMs: row.time_ms,
    filePath: row.file_path,
    thumbPath: row.thumb_path,
    width: row.width,
    height: row.height,
    caption: row.caption,
    role: row.role === 'auto-thumb' ? 'auto-thumb' : 'main',
    annotations: parseAnnotations(row.annotations_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function parseAnnotations(json: string): Annotation[] {
  try {
    const parsed = JSON.parse(json);
    return Array.isArray(parsed) ? (parsed as Annotation[]) : [];
  } catch {
    return [];
  }
}