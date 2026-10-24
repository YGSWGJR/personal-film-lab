import { randomUUID } from 'node:crypto';
import type { Note, NoteUpsertArgs } from '../../shared/types';
import type { DataLayer } from '../db';
import { DataError } from '../errors';
import { nowIso } from './projects';

interface NoteRow {
  id: string;
  project_id: string;
  shot_id: string;
  text: string;
  created_at: string;
  updated_at: string;
}

export class NoteRepository {
  constructor(private readonly layer: DataLayer) {}

  private get db() {
    return this.layer.db;
  }

  list(args: { projectId?: string; shotId?: string }): Note[] {
    let rows: NoteRow[];
    if (args.shotId) {
      rows = this.db
        .prepare('SELECT * FROM notes WHERE shot_id = ? ORDER BY created_at ASC')
        .all(args.shotId) as NoteRow[];
    } else {
      rows = this.db
        .prepare('SELECT * FROM notes WHERE project_id = ? ORDER BY created_at ASC')
        .all(args.projectId) as NoteRow[];
    }
    return rows.map(mapNote);
  }

  get(id: string): Note {
    const row = this.db.prepare('SELECT * FROM notes WHERE id = ?').get(id) as NoteRow | undefined;
    if (!row) throw new DataError('NOTE_NOT_FOUND', `笔记不存在：${id}`, { id });
    return mapNote(row);
  }

  upsert(args: NoteUpsertArgs): Note {
    if (!this.layer.projects.exists(args.projectId)) {
      throw new DataError('PROJECT_NOT_FOUND', `项目不存在：${args.projectId}`, { projectId: args.projectId });
    }
    const shot = this.db.prepare('SELECT project_id FROM shots WHERE id = ?').get(args.shotId) as
      | { project_id: string }
      | undefined;
    if (!shot) throw new DataError('SHOT_NOT_FOUND', `镜头不存在：${args.shotId}`, { shotId: args.shotId });
    if (shot.project_id !== args.projectId) {
      throw new DataError('SHOT_PROJECT_MISMATCH', '镜头不属于该项目', { shotId: args.shotId });
    }

    const now = nowIso();
    if (args.id) {
      this.get(args.id);
      this.layer.transaction(() => {
        this.db.prepare('UPDATE notes SET text = ?, updated_at = ? WHERE id = ?').run(args.text, now, args.id);
        this.layer.projects.touch(args.projectId);
      });
      return this.get(args.id);
    }

    const id = randomUUID();
    this.layer.transaction(() => {
      this.db
        .prepare('INSERT INTO notes (id, project_id, shot_id, text, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run(id, args.projectId, args.shotId, args.text, now, now);
      this.layer.projects.touch(args.projectId);
    });
    return this.get(id);
  }

  delete(id: string): void {
    const current = this.get(id);
    this.layer.transaction(() => {
      this.db.prepare('DELETE FROM notes WHERE id = ?').run(id);
      this.layer.projects.touch(current.projectId);
    });
  }
}

function mapNote(row: NoteRow): Note {
  return {
    id: row.id,
    projectId: row.project_id,
    shotId: row.shot_id,
    text: row.text,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
