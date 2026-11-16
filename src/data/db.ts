import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { DataError } from './errors';
import { MIGRATIONS } from './migrations';
import { NoteRepository } from './repositories/notes';
import { ProjectRepository } from './repositories/projects';
import { ProjectMediaRepository } from './repositories/project-media';
import { SceneRepository } from './repositories/scenes';
import { ShotRepository } from './repositories/shots';
import { StillRepository } from './repositories/stills';
import { TagRepository } from './repositories/tags';
import { TermRepository } from './repositories/terms';
import { WallRepository } from './repositories/wall';
import { WallBoardsRepository } from './repositories/wall-boards';

/**
 * 数据层（docs/S01 §5.8 / §7.4）：
 * - 单库 userData/lapian/lapian.db（可用 DSH_DATA_ROOT 覆盖，测试用）；
 * - WAL + 外键开启；版本化迁移（PRAGMA user_version）；
 * - 仓储只由主进程调用，渲染层经 IPC 访问；
 * - 所有写操作由仓储内 db.transaction 包裹。
 */
export class DataLayer {
  readonly db: Database.Database;
  readonly dataRoot: string;
  readonly projects: ProjectRepository;
  readonly projectMedia: ProjectMediaRepository;
  readonly scenes: SceneRepository;
  readonly shots: ShotRepository;
  readonly stills: StillRepository;
  readonly tags: TagRepository;
  readonly notes: NoteRepository;
  readonly terms: TermRepository;
  readonly wall: WallRepository;
  readonly wallBoards: WallBoardsRepository;
  private closed = false;

  constructor(dataRoot: string) {
    this.dataRoot = dataRoot;
    mkdirSync(dataRoot, { recursive: true });
    this.db = new Database(join(dataRoot, 'lapian.db'));
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.db.pragma('busy_timeout = 5000');

    this.runMigrations();

    this.projects = new ProjectRepository(this);
    this.projectMedia = new ProjectMediaRepository(this);
    this.scenes = new SceneRepository(this);
    this.shots = new ShotRepository(this);
    this.stills = new StillRepository(this);
    this.tags = new TagRepository(this);
    this.notes = new NoteRepository(this);
    this.terms = new TermRepository(this);
    this.wall = new WallRepository(this);
    this.wallBoards = new WallBoardsRepository(this);
  }

  /** 写事务封装（S01 §7.4：所有写操作必须走事务） */
  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      this.db.pragma('wal_checkpoint(TRUNCATE)');
    } catch {
      // ignore checkpoint failures on shutdown
    }
    this.db.close();
  }

  private runMigrations(): void {
    const current = Number(this.db.pragma('user_version', { simple: true }));
    const latest = MIGRATIONS.at(-1)?.version ?? current;
    if (current > 0 && current < latest) {
      try {
        const [checkpoint] = this.db.pragma('wal_checkpoint(FULL)') as Array<{ busy: number }>;
        if (checkpoint?.busy) throw new Error('数据库仍有未写入主文件的记录');
        const backupDir = join(this.dataRoot, 'backups');
        mkdirSync(backupDir, { recursive: true });
        const stamp = new Date().toISOString().replace(/[:.]/gu, '-');
        const databasePath = join(this.dataRoot, 'lapian.db');
        if (existsSync(databasePath)) {
          copyFileSync(
            databasePath,
            join(backupDir, `lapian-v${current}-${stamp}.db`),
          );
        }
      } catch (error) {
        throw new DataError(
          'MIGRATION_BACKUP_FAILED',
          `迁移前备份失败：${(error as Error).message}`,
          { version: current },
        );
      }
    }
    for (const migration of MIGRATIONS) {
      if (migration.version <= current) continue;
      try {
        this.db.exec('BEGIN');
        this.db.exec(migration.sql);
        this.db.pragma(`user_version = ${migration.version}`);
        this.db.exec('COMMIT');
      } catch (error) {
        try {
          this.db.exec('ROLLBACK');
        } catch {
          // ignore
        }
        throw new DataError('MIGRATION_FAILED', `数据库迁移失败（v${migration.version}）：${(error as Error).message}`, {
          version: migration.version,
        });
      }
    }
  }
}
