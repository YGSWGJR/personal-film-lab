import { randomUUID } from 'node:crypto';
import { copyFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
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

  /* ---------- S43 分镜PPT：镜头卡标注 ---------- */

  listAnnotations(
    projectId: string,
    shotIds?: string[],
  ): Record<string, Array<{ id: string; type: string; color: string; data: unknown }>> {
    this.assertProject(projectId);
    const out: Record<string, Array<{ id: string; type: string; color: string; data: unknown }>> = {};
    let rows: Array<{ shot_id: string; id: string; type: string; color: string; data_json: string }>;
    if (shotIds && shotIds.length > 0) {
      const placeholders = shotIds.map(() => '?').join(',');
      rows = this.db
        .prepare(
          `SELECT shot_id, id, type, color, data_json FROM shot_annotations
           WHERE project_id = ? AND shot_id IN (${placeholders}) ORDER BY created_at ASC`,
        )
        .all(projectId, ...shotIds) as typeof rows;
    } else {
      rows = this.db
        .prepare(
          'SELECT shot_id, id, type, color, data_json FROM shot_annotations WHERE project_id = ? ORDER BY created_at ASC',
        )
        .all(projectId) as typeof rows;
    }
    for (const row of rows) {
      let data: unknown = {};
      try {
        data = JSON.parse(row.data_json);
      } catch {
        data = {};
      }
      (out[row.shot_id] = out[row.shot_id] || []).push({
        id: row.id,
        type: row.type,
        color: row.color,
        data,
      });
    }
    return out;
  }

  saveAnnotations(
    projectId: string,
    shotId: string,
    items: Array<{ type: string; color: string; data: unknown }>,
  ): void {
    this.assertProject(projectId);
    const exists = this.db.prepare('SELECT id FROM shots WHERE project_id = ? AND id = ?');
    if (!exists.get(projectId, shotId)) {
      throw new DataError('WALL_SHOT_NOT_IN_PROJECT', `镜头不属于该项目：${shotId}`, { shotId });
    }
    const TYPES = new Set(['brush', 'smear', 'line', 'arrow', 'rect', 'ellipse', 'text', 'mosaic']);
    for (const item of items) {
      if (!TYPES.has(item.type)) {
        throw new DataError('WALL_ITEM_INVALID', `标注类型无效：${item.type}`, { item });
      }
    }
    this.layer.transaction(() => {
      this.db.prepare('DELETE FROM shot_annotations WHERE project_id = ? AND shot_id = ?').run(projectId, shotId);
      const insert = this.db.prepare(
        "INSERT INTO shot_annotations (id, project_id, shot_id, type, color, data_json, created_at) VALUES (?, ?, ?, ?, ?, ?, strftime('%s','now') * 1000)",
      );
      for (const item of items) {
        insert.run(randomUUID(), projectId, shotId, item.type, item.color, JSON.stringify(item.data ?? {}));
      }
    });
  }

  /* ---------- S43 分镜PPT：按连线顺序一键导出图片 ---------- */

  /**
   * 沿连线顺序导出镜头缩略图：每个弱连通分量取无入边的卡为起点，
   * 主线（solid）优先 DFS，其后备选（dash），分量内未连通卡按镜号补齐。
   * 隔离卡排在最后（按镜号）。缩略图为 lapian-asset://<projectId>/<rel> 时映射回项目目录复制。
   */
  exportImages(
    projectId: string,
    dataRoot: string,
  ): { dir: string; count: number; skipped: number } {
    this.assertProject(projectId);
    const shots = this.layer.shots.list(projectId) as Array<{
      id: string;
      index: number;
      thumbnail?: string | null;
    }>;
    const edgeRows = this.listEdges(projectId);
    const byId = new Map(shots.map((shot) => [shot.id, shot]));
    const solidNext = new Map<string, string[]>();
    const incoming = new Map<string, number>();
    for (const shot of shots) {
      solidNext.set(shot.id, []);
      incoming.set(shot.id, 0);
    }
    for (const e of edgeRows) {
      if (!byId.has(e.fromShotId) || !byId.has(e.toShotId)) continue;
      if (e.kind === 'solid') solidNext.get(e.fromShotId)?.push(e.toShotId);
      incoming.set(e.toShotId, (incoming.get(e.toShotId) ?? 0) + 1);
    }
    const order: string[] = [];
    const seen = new Set<string>();
    const dfs = (id: string): void => {
      if (seen.has(id)) return;
      seen.add(id);
      order.push(id);
      for (const next of solidNext.get(id) ?? []) dfs(next);
    };
    for (const shot of shots) {
      if ((incoming.get(shot.id) ?? 0) === 0) dfs(shot.id);
    }
    for (const shot of shots) dfs(shot.id);

    const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
    const dir = join(dataRoot, 'exports', 'wall', `${projectId}-${stamp}`);
    mkdirSync(dir, { recursive: true });
    let count = 0;
    let skipped = 0;
    let n = 0;
    for (const id of order) {
      const shot = byId.get(id);
      if (!shot) continue;
      n += 1;
      const thumb = shot.thumbnail ?? '';
      const m = /^lapian-asset:\/\/([^/]+)\/(.+)$/.exec(thumb);
      const src = m ? join(dataRoot, 'projects', m[1], ...m[2].split('/')) : thumb;
      let copied = false;
      try {
        if (src && !thumb.startsWith('data:')) {
          copyFileSync(src, join(dir, `${String(n).padStart(3, '0')}-shot${String(shot.index).padStart(2, '0')}.jpg`));
          copied = true;
        }
      } catch {
        copied = false;
      }
      if (copied) count += 1;
      else skipped += 1;
    }
    return { dir, count, skipped };
  }

  private assertProject(projectId: string): void {
    if (!this.layer.projects.exists(projectId)) {
      throw new DataError('WALL_PROJECT_NOT_FOUND', `项目不存在：${projectId}`, { projectId });
    }
  }
}
