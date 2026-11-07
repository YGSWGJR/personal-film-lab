import { randomUUID } from 'node:crypto';
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

  /* ---------- S43 二期：连线系统 ---------- */

  /** 防误触 1.2：数据层不拦（阈值属交互），但重复边/自连/跨项目在这里拦截 */
  addEdge(
    projectId: string,
    fromShotId: string,
    toShotId: string,
    kind: 'solid' | 'dash',
  ): { fromShotId: string; toShotId: string; kind: 'solid' | 'dash' } {
    this.assertProject(projectId);
    if (fromShotId === toShotId) {
      throw new DataError('WALL_EDGE_SELF', '连线不能从卡片连到自身', { fromShotId });
    }
    if (kind !== 'solid' && kind !== 'dash') {
      throw new DataError('WALL_ITEM_INVALID', `连线类型无效：${kind}`, { kind });
    }
    const exists = this.db.prepare('SELECT id FROM shots WHERE project_id = ? AND id = ?');
    if (!exists.get(projectId, fromShotId) || !exists.get(projectId, toShotId)) {
      throw new DataError('WALL_SHOT_NOT_IN_PROJECT', '连线端点不属于该项目', {
        fromShotId,
        toShotId,
      });
    }
    this.layer.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO shot_edges (project_id, from_shot, to_shot, kind, created_at)
           VALUES (?, ?, ?, ?, strftime('%s','now') * 1000)
           ON CONFLICT(project_id, from_shot, to_shot) DO UPDATE SET kind = excluded.kind`,
        )
        .run(projectId, fromShotId, toShotId, kind);
    });
    return { fromShotId, toShotId, kind };
  }

  removeEdge(projectId: string, fromShotId: string, toShotId: string): void {
    this.assertProject(projectId);
    this.layer.transaction(() => {
      this.db
        .prepare('DELETE FROM shot_edges WHERE project_id = ? AND from_shot = ? AND to_shot = ?')
        .run(projectId, fromShotId, toShotId);
    });
  }

  listEdges(projectId: string): Array<{ fromShotId: string; toShotId: string; kind: string }> {
    this.assertProject(projectId);
    const rows = this.db
      .prepare('SELECT from_shot, to_shot, kind FROM shot_edges WHERE project_id = ? ORDER BY created_at ASC')
      .all(projectId) as Array<{ from_shot: string; to_shot: string; kind: string }>;
    return rows.map((row) => ({ fromShotId: row.from_shot, toShotId: row.to_shot, kind: row.kind }));
  }

  /* ---------- S43 二期：分组（独立板子，成组自动断开跨组边） ---------- */

  createGroup(projectId: string, name: string, shotIds: string[]): { groupId: string } {
    this.assertProject(projectId);
    if (shotIds.length < 2) {
      throw new DataError('WALL_GROUP_TOO_SMALL', '分组至少需要两张卡片', { shotIds });
    }
    const exists = this.db.prepare('SELECT id FROM shots WHERE project_id = ? AND id = ?');
    for (const shotId of shotIds) {
      if (!exists.get(projectId, shotId)) {
        throw new DataError('WALL_SHOT_NOT_IN_PROJECT', `镜头不属于该项目：${shotId}`, { shotId });
      }
    }
    const groupId = randomUUID();
    this.layer.transaction(() => {
      this.db
        .prepare(
          "INSERT INTO shot_groups (id, project_id, name, created_at) VALUES (?, ?, ?, strftime('%s','now') * 1000)",
        )
        .run(groupId, projectId, name);
      const insert = this.db.prepare(
        'INSERT INTO shot_group_members (project_id, group_id, shot_id) VALUES (?, ?, ?)',
      );
      for (const shotId of shotIds) insert.run(projectId, groupId, shotId);
      // 自动断连：组与组外之间的连线全部删除
      this.db
        .prepare(
          `DELETE FROM shot_edges WHERE project_id = ? AND (
             (from_shot IN (SELECT shot_id FROM shot_group_members WHERE group_id = ?)
               AND to_shot NOT IN (SELECT shot_id FROM shot_group_members WHERE group_id = ?))
             OR
             (to_shot IN (SELECT shot_id FROM shot_group_members WHERE group_id = ?)
               AND from_shot NOT IN (SELECT shot_id FROM shot_group_members WHERE group_id = ?))
           )`,
        )
        .run(projectId, groupId, groupId, groupId, groupId);
    });
    return { groupId };
  }

  dissolveGroup(projectId: string, groupId: string): void {
    this.assertProject(projectId);
    this.layer.transaction(() => {
      this.db
        .prepare('DELETE FROM shot_groups WHERE project_id = ? AND id = ?')
        .run(projectId, groupId);
    });
  }

  listGroups(projectId: string): Array<{
    groupId: string;
    name: string;
    shotIds: string[];
  }> {
    this.assertProject(projectId);
    const gRows = this.db
      .prepare('SELECT id, name FROM shot_groups WHERE project_id = ? ORDER BY created_at ASC')
      .all(projectId) as Array<{ id: string; name: string }>;
    const mStmt = this.db.prepare(
      'SELECT shot_id FROM shot_group_members WHERE group_id = ? ORDER BY rowid ASC',
    );
    return gRows.map((g) => ({
      groupId: g.id,
      name: g.name,
      shotIds: (mStmt.all(g.id) as Array<{ shot_id: string }>).map((r) => r.shot_id),
    }));
  }

  private assertProject(projectId: string): void {
    if (!this.layer.projects.exists(projectId)) {
      throw new DataError('WALL_PROJECT_NOT_FOUND', `项目不存在：${projectId}`, { projectId });
    }
  }
}
