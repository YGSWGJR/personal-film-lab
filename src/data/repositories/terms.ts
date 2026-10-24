import { randomUUID } from 'node:crypto';
import type { Term, TermCreateArgs, TermUpdateArgs } from '../../shared/types';
import type { DataLayer } from '../db';
import { DataError, isSqliteConstraintError } from '../errors';
import { nowIso } from './projects';

interface TermRow {
  id: string;
  category: string;
  term: string;
  definition: string;
  builtin: number;
  sort_order: number;
  created_at: string;
}

export class TermRepository {
  constructor(private readonly layer: DataLayer) {}

  private get db() {
    return this.layer.db;
  }

  list(category?: string): Term[] {
    const rows = category
      ? (this.db
          .prepare('SELECT * FROM terms WHERE category = ? ORDER BY sort_order ASC, term ASC')
          .all(category) as TermRow[])
      : (this.db.prepare('SELECT * FROM terms ORDER BY category ASC, sort_order ASC, term ASC').all() as TermRow[]);
    return rows.map(mapTerm);
  }

  create(args: TermCreateArgs): Term {
    const term = args.term.trim();
    if (!term) throw new DataError('INVALID_ARGUMENT', '术语不能为空');
    const id = randomUUID();
    try {
      this.layer.transaction(() => {
        this.db
          .prepare(
            'INSERT INTO terms (id, category, term, definition, builtin, sort_order, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
          )
          .run(
            id,
            args.category ?? 'custom',
            term,
            args.definition,
            args.builtin ? 1 : 0,
            args.sortOrder ?? 0,
            nowIso(),
          );
      });
    } catch (error) {
      if (isSqliteConstraintError(error)) {
        throw new DataError('TERM_EXISTS', `术语已存在：${term}`, { term });
      }
      throw error;
    }
    return this.get(id);
  }

  update(args: TermUpdateArgs): Term {
    const current = this.get(args.id);
    const patch = args.patch ?? {};
    try {
      this.layer.transaction(() => {
        this.db
          .prepare('UPDATE terms SET category = ?, term = ?, definition = ?, sort_order = ? WHERE id = ?')
          .run(
            patch.category ?? current.category,
            patch.term ?? current.term,
            patch.definition ?? current.definition,
            patch.sortOrder ?? current.sortOrder,
            current.id,
          );
      });
    } catch (error) {
      if (isSqliteConstraintError(error)) throw new DataError('TERM_EXISTS', '术语已存在');
      throw error;
    }
    return this.get(current.id);
  }

  delete(id: string): void {
    this.get(id);
    this.layer.transaction(() => {
      this.db.prepare('DELETE FROM terms WHERE id = ?').run(id);
    });
  }

  get(id: string): Term {
    const row = this.db.prepare('SELECT * FROM terms WHERE id = ?').get(id) as TermRow | undefined;
    if (!row) throw new DataError('TERM_NOT_FOUND', `术语不存在：${id}`, { id });
    return mapTerm(row);
  }
}

function mapTerm(row: TermRow): Term {
  return {
    id: row.id,
    category: row.category,
    term: row.term,
    definition: row.definition,
    builtin: row.builtin !== 0,
    sortOrder: row.sort_order,
    createdAt: row.created_at,
  };
}