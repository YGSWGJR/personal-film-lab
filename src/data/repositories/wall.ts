import type { DataLayer } from '../db';
import { DataError } from '../errors';

export interface ShotLayoutRow {
  shotId: string;
  x: number;
  y: number;
}

/**
 * 分镜墙画布一期（看板）：镜头卡世界坐标布局。
 * - saveLayout 批量 upsert、单事务；shotId 必须属于该项目（写入时校验，不静默丢弃）。
 * - shots 删除时布局随外键 CASCADE 消失，不做反向触发器。
 */
export class WallRepository {
  constructor(private readonly layer: DataLayer) {}

  private get db() {
    return this.layer.db;
  }

  getLayout(projectId: string): ShotLayoutRow[] {
    this.assertProject(projectId);
    const rows = this.db
      .prepare('SELECT shot_id, x, y FROM shot_layout WHERE project_id = ?')
      .all(projectId) as Array<{ shot_id: string; x: number; y: number }>;
    return rows.map((row) => ({ shotId: row.shot_id, x: row.x, y: row.y }));
  }

  saveLayout(projectId: string, items: ShotLayoutRow[]): void {
    this.assertProject(projectId);
    if (items.length === 0) return;
    for (const item of items) {
      if (
        typeof item.x !== 'number' ||
        !Number.isFinite(item.x) ||
        typeof item.y !== 'number' ||
        !Number.isFinite(item.y)
      ) {
        throw new DataError('WALL_ITEM_INVALID', `布局坐标无效：${item.shotId}`, { item });
      }
    }
    const exists = this.db.prepare('SELECT id FROM shots WHERE project_id = ? AND id = ?');
    for (const item of items) {
      if (!exists.get(projectId, item.shotId)) {
        throw new DataError('WALL_SHOT_NOT_IN_PROJECT', `镜头不属于该项目：${item.shotId}`, {
          shotId: item.shotId,
        });
      }
    }
    this.layer.transaction(() => {
      const upsert = this.db.prepare(
        `INSERT INTO shot_layout (project_id, shot_id, x, y, updated_at)
         VALUES (?, ?, ?, ?, strftime('%s','now') * 1000)
         ON CONFLICT(project_id, shot_id) DO UPDATE SET
           x = excluded.x, y = excluded.y, updated_at = excluded.updated_at`,
      );
      for (const item of items) upsert.run(projectId, item.shotId, item.x, item.y);
    });
  }

  private assertProject(projectId: string): void {
    if (!this.layer.projects.exists(projectId)) {
      throw new DataError('WALL_PROJECT_NOT_FOUND', `项目不存在：${projectId}`, { projectId });
    }
  }
}
