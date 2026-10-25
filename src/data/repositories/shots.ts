import { randomUUID } from 'node:crypto';
import type { Shot, ShotCreateArgs, ShotPreview, ShotUpdateArgs } from '../../shared/types';
import type { DataLayer } from '../db';
import { DataError, isSqliteConstraintError } from '../errors';
import { removeProjectFiles } from '../paths';
import { nowIso } from './projects';

interface ShotRow {
  id: string;
  project_id: string;
  shot_index: number;
  start_ms: number;
  end_ms: number;
  duration_ms: number;
  shot_size: string | null;
  camera_method: string | null;
  dialogue: string | null;
  remark: string | null;
  origin: 'auto' | 'manual';
  locked: number;
  created_at: string;
  updated_at: string;
}

export class ShotRepository {
  constructor(private readonly layer: DataLayer) {}

  private get db() {
    return this.layer.db;
  }

  list(projectId: string): Shot[] {
    this.assertProject(projectId);
    const rows = this.db
      .prepare('SELECT * FROM shots WHERE project_id = ? ORDER BY start_ms ASC, shot_index ASC')
      .all(projectId) as ShotRow[];
    const tagIds = this.loadTagIds(rows.map((row) => row.id));
    return rows.map((row) => mapShot(row, tagIds.get(row.id) ?? []));
  }

  get(id: string): Shot {
    const row = this.db.prepare('SELECT * FROM shots WHERE id = ?').get(id) as ShotRow | undefined;
    if (!row) throw new DataError('SHOT_NOT_FOUND', `镜头不存在：${id}`, { id });
    const tagIds = this.loadTagIds([id]).get(id) ?? [];
    return mapShot(row, tagIds);
  }

  create(args: ShotCreateArgs): Shot {
    this.assertProject(args.projectId);
    this.validateRange(args.startMs, args.endMs);
    const id = randomUUID();
    const now = nowIso();
    const durationMs = args.endMs - args.startMs;

    try {
      this.layer.transaction(() => {
        const index =
          args.index ??
          ((this.db
            .prepare('SELECT COALESCE(MAX(shot_index), 0) + 1 AS next FROM shots WHERE project_id = ?')
            .get(args.projectId) as { next: number }).next);
        this.db
          .prepare(
            `INSERT INTO shots (
              id, project_id, shot_index, start_ms, end_ms, duration_ms,
              shot_size, camera_method, dialogue, remark, origin, locked, created_at, updated_at
            ) VALUES (
              @id, @projectId, @index, @startMs, @endMs, @durationMs,
              @shotSize, @cameraMethod, @dialogue, @remark, 'manual', 0, @createdAt, @updatedAt
            )`,
          )
          .run({
            id,
            projectId: args.projectId,
            index,
            startMs: args.startMs,
            endMs: args.endMs,
            durationMs,
            shotSize: args.shotSize ?? null,
            cameraMethod: args.cameraMethod ?? null,
            dialogue: args.dialogue ?? null,
            remark: args.remark ?? null,
            createdAt: now,
            updatedAt: now,
          });
        this.layer.projects.touch(args.projectId);
      });
    } catch (error) {
      if (isSqliteConstraintError(error)) {
        throw new DataError('SHOT_CREATE_FAILED', `镜头创建失败：${(error as Error).message}`);
      }
      throw error;
    }

    return this.get(id);
  }

  update(args: ShotUpdateArgs): Shot {
    const current = this.get(args.id);
    const patch = args.patch ?? {};
    const startMs = patch.startMs ?? current.startMs;
    const endMs = patch.endMs ?? current.endMs;
    this.validateRange(startMs, endMs);

    this.layer.transaction(() => {
      this.db
        .prepare(
          `UPDATE shots SET
            shot_index = @index, start_ms = @startMs, end_ms = @endMs, duration_ms = @durationMs,
            shot_size = @shotSize, camera_method = @cameraMethod, dialogue = @dialogue, remark = @remark,
            updated_at = @updatedAt
          WHERE id = @id`,
        )
        .run({
          id: current.id,
          index: patch.index ?? current.index,
          startMs,
          endMs,
          durationMs: endMs - startMs,
          shotSize: patch.shotSize !== undefined ? patch.shotSize : current.shotSize,
          cameraMethod: patch.cameraMethod !== undefined ? patch.cameraMethod : current.cameraMethod,
          dialogue: patch.dialogue !== undefined ? patch.dialogue : current.dialogue,
          remark: patch.remark !== undefined ? patch.remark : current.remark,
          updatedAt: nowIso(),
        });
      this.layer.projects.touch(current.projectId);
    });

    return this.get(current.id);
  }

  delete(id: string, extraSafeRoots: string[] = []): void {
    const current = this.get(id);
    const stillFiles = this.db
      .prepare('SELECT file_path, thumb_path FROM stills WHERE shot_id = ?')
      .all(id) as Array<{ file_path: string; thumb_path: string | null }>;
    this.layer.transaction(() => {
      this.db.prepare('DELETE FROM shot_tags WHERE shot_id = ?').run(id);
      this.db.prepare('DELETE FROM notes WHERE shot_id = ?').run(id);
      this.db.prepare('DELETE FROM stills WHERE shot_id = ?').run(id);
      this.db.prepare('DELETE FROM shots WHERE id = ?').run(id);
      this.layer.projects.touch(current.projectId);
    });
    removeProjectFiles(
      this.layer.dataRoot,
      current.projectId,
      stillFiles.flatMap((still) => [still.file_path, still.thumb_path]),
      extraSafeRoots,
    );
  }

  /** 应用检测预览：保留 locked 镜头，替换其他镜头并跳过与 locked 区间重叠的候选。 */
  applyDetected(projectId: string, previews: ShotPreview[]): number {
    this.assertProject(projectId);
    const now = nowIso();
    let applied = 0;
    this.layer.transaction(() => {
      const lockedRows = this.db
        .prepare('SELECT start_ms, end_ms, shot_index FROM shots WHERE project_id = ? AND locked = 1')
        .all(projectId) as Array<{ start_ms: number; end_ms: number; shot_index: number }>;
      this.db.prepare('DELETE FROM shots WHERE project_id = ? AND locked = 0').run(projectId);
      let nextIndex = Math.max(0, ...lockedRows.map((row) => row.shot_index)) + 1;
      const insert = this.db.prepare(
        `INSERT INTO shots (
          id, project_id, shot_index, start_ms, end_ms, duration_ms,
          shot_size, camera_method, dialogue, remark, origin, locked, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, 'auto', 0, ?, ?)`,
      );
      for (const preview of previews) {
        const overlapsLocked = lockedRows.some(
          (row) => preview.startMs < row.end_ms && preview.endMs > row.start_ms,
        );
        if (overlapsLocked) continue;
        insert.run(
          randomUUID(),
          projectId,
          nextIndex++,
          preview.startMs,
          preview.endMs,
          preview.endMs - preview.startMs,
          now,
          now,
        );
        applied += 1;
      }
      this.layer.projects.touch(projectId);
    });
    return applied;
  }

  private validateRange(startMs: number, endMs: number): void {
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || startMs < 0 || endMs < startMs) {
      throw new DataError('INVALID_ARGUMENT', `镜头时间区间无效：startMs=${startMs} endMs=${endMs}`);
    }
  }

  private assertProject(projectId: string): void {
    if (!this.layer.projects.exists(projectId)) {
      throw new DataError('PROJECT_NOT_FOUND', `项目不存在：${projectId}`, { projectId });
    }
  }

  private loadTagIds(shotIds: string[]): Map<string, string[]> {
    const result = new Map<string, string[]>();
    if (shotIds.length === 0) return result;
    const placeholders = shotIds.map(() => '?').join(',');
    const rows = this.db
      .prepare(`SELECT shot_id, tag_id FROM shot_tags WHERE shot_id IN (${placeholders}) ORDER BY tag_id ASC`)
      .all(...shotIds) as Array<{ shot_id: string; tag_id: string }>;
    for (const row of rows) {
      const list = result.get(row.shot_id) ?? [];
      list.push(row.tag_id);
      result.set(row.shot_id, list);
    }
    return result;
  }
}

function mapShot(row: ShotRow, tagIds: string[]): Shot {
  return {
    id: row.id,
    projectId: row.project_id,
    index: row.shot_index,
    startMs: row.start_ms,
    endMs: row.end_ms,
    durationMs: row.duration_ms,
    shotSize: row.shot_size,
    cameraMethod: row.camera_method,
    dialogue: row.dialogue,
    remark: row.remark,
    origin: row.origin === 'auto' ? 'auto' : 'manual',
    locked: row.locked !== 0,
    tagIds,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
