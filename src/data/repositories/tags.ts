import { randomUUID } from 'node:crypto';
import type { Tag, TagCreateArgs, TagUpdateArgs } from '../../shared/types';
import type { DataLayer } from '../db';
import { DataError, isSqliteConstraintError } from '../errors';
import { nowIso } from './projects';

interface TagRow {
  id: string;
  category: string;
  name: string;
  color: string | null;
  builtin: number;
  sort_order: number;
  created_at: string;
}

export class TagRepository {
  constructor(private readonly layer: DataLayer) {}

  private get db() {
    return this.layer.db;
  }

  list(category?: string): Tag[] {
    const rows = category
      ? (this.db
          .prepare('SELECT * FROM tags WHERE category = ? ORDER BY sort_order ASC, name ASC')
          .all(category) as TagRow[])
      : (this.db.prepare('SELECT * FROM tags ORDER BY category ASC, sort_order ASC, name ASC').all() as TagRow[]);
    return rows.map(mapTag);
  }

  create(args: TagCreateArgs): Tag {
    const category = args.category.trim();
    const name = args.name.trim();
    if (!category || !name) throw new DataError('INVALID_ARGUMENT', '标签分类与名称不能为空');
    const id = randomUUID();
    try {
      this.layer.transaction(() => {
        this.db
          .prepare(
            'INSERT INTO tags (id, category, name, color, builtin, sort_order, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
          )
          .run(id, category, name, args.color ?? null, args.builtin ? 1 : 0, args.sortOrder ?? 0, nowIso());
      });
    } catch (error) {
      if (isSqliteConstraintError(error)) {
        throw new DataError('TAG_EXISTS', `标签已存在：${category}/${name}`, { category, name });
      }
      throw error;
    }
    return this.get(id);
  }

  update(args: TagUpdateArgs): Tag {
    const current = this.get(args.id);
    const patch = args.patch ?? {};
    try {
      this.layer.transaction(() => {
        this.db
          .prepare('UPDATE tags SET category = ?, name = ?, color = ?, sort_order = ? WHERE id = ?')
          .run(
            patch.category ?? current.category,
            patch.name ?? current.name,
            patch.color !== undefined ? patch.color : current.color,
            patch.sortOrder ?? current.sortOrder,
            current.id,
          );
      });
    } catch (error) {
      if (isSqliteConstraintError(error)) {
        throw new DataError('TAG_EXISTS', '标签名称在同一分类下已存在');
      }
      throw error;
    }
    return this.get(current.id);
  }

  delete(id: string): void {
    this.get(id);
    this.layer.transaction(() => {
      this.db.prepare('DELETE FROM tags WHERE id = ?').run(id);
    });
  }

  assign(shotId: string, tagIds: string[]): string[] {
    const projectId = this.assertShot(shotId);
    for (const tagId of tagIds) this.get(tagId);
    this.layer.transaction(() => {
      const insert = this.db.prepare('INSERT OR IGNORE INTO shot_tags (shot_id, tag_id) VALUES (?, ?)');
      for (const tagId of tagIds) insert.run(shotId, tagId);
      this.layer.projects.touch(projectId);
    });
    return this.tagIdsOfShot(shotId);
  }

  unassign(shotId: string, tagIds: string[]): string[] {
    const projectId = this.assertShot(shotId);
    this.layer.transaction(() => {
      const remove = this.db.prepare('DELETE FROM shot_tags WHERE shot_id = ? AND tag_id = ?');
      for (const tagId of tagIds) remove.run(shotId, tagId);
      this.layer.projects.touch(projectId);
    });
    return this.tagIdsOfShot(shotId);
  }

  get(id: string): Tag {
    const row = this.db.prepare('SELECT * FROM tags WHERE id = ?').get(id) as TagRow | undefined;
    if (!row) throw new DataError('TAG_NOT_FOUND', `标签不存在：${id}`, { id });
    return mapTag(row);
  }

  private assertShot(shotId: string): string {
    const row = this.db.prepare('SELECT project_id FROM shots WHERE id = ?').get(shotId) as
      | { project_id: string }
      | undefined;
    if (!row) throw new DataError('SHOT_NOT_FOUND', `镜头不存在：${shotId}`, { shotId });
    return row.project_id;
  }

  private tagIdsOfShot(shotId: string): string[] {
    const rows = this.db.prepare('SELECT tag_id FROM shot_tags WHERE shot_id = ? ORDER BY tag_id').all(shotId) as Array<{
      tag_id: string;
    }>;
    return rows.map((row) => row.tag_id);
  }
}

function mapTag(row: TagRow): Tag {
  return {
    id: row.id,
    category: row.category,
    name: row.name,
    color: row.color,
    builtin: row.builtin !== 0,
    sortOrder: row.sort_order,
    createdAt: row.created_at,
  };
}