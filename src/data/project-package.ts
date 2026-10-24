import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import Database from 'better-sqlite3';
import { unzipSync, zipSync, strToU8, strFromU8 } from 'fflate';
import type { ProjectOpenResult, ProjectSaveArgs, ProjectSaveResult } from '../shared/types';
import { DataLayer } from './db';
import { DataError } from './errors';
import { MIGRATIONS } from './migrations';
import { ensureProjectDirs, projectDirOf, removeProjectDir, sanitizeName } from './paths';

interface PackageManifest {
  format: 'lapian-project';
  version: number;
  projectId: string;
  name: string;
  exportedAt: string;
  includesAssets: boolean;
  includesMedia: boolean;
}

const PACKAGE_FORMAT = 'lapian-project';
const PACKAGE_VERSION = 1;
const ASSET_DIRS = ['stills', 'frames', 'exports'];
const MEDIA_DIRS = ['source', 'proxy'];

/**
 * 项目包（S01 §7.4 扩展）：
 * - 项目文件 = 项目数据库快照（只含该项目数据）+ 资源目录 + manifest.json，打包为单个 .lapian（zip）；
 * - 导出的快照库与主库同 schema，可直接被 SQLite 工具打开排查；
 * - 导入时 id 冲突自动换新 id，镜头/静帧/笔记/标签全部重映射，资源文件复制进项目目录。
 */
export class ProjectPackageService {
  constructor(private readonly layer: DataLayer) {}

  exportProject(args: ProjectSaveArgs): ProjectSaveResult {
    const project = this.layer.projects.get(args.id);
    const includeAssets = args.includeAssets ?? true;
    const includeMedia = args.includeMedia ?? false;
    const targetPath = args.targetPath
      ? resolve(args.targetPath)
      : join(
          this.layer.dataRoot,
          'packages',
          `${sanitizeName(project.name)}-${project.id.slice(0, 8)}.lapian`,
        );
    mkdirSync(dirname(targetPath), { recursive: true });

    const workDir = mkdtempSync(join(tmpdir(), 'lapian-export-'));
    const snapshotPath = join(workDir, 'project.db');
    try {
      this.buildSnapshot(project.id, snapshotPath);

      const zipEntries: Record<string, Uint8Array> = {};
      const manifest: PackageManifest = {
        format: PACKAGE_FORMAT,
        version: PACKAGE_VERSION,
        projectId: project.id,
        name: project.name,
        exportedAt: new Date().toISOString(),
        includesAssets: includeAssets,
        includesMedia: includeMedia,
      };
      zipEntries['manifest.json'] = strToU8(JSON.stringify(manifest, null, 2));
      zipEntries['project.db'] = new Uint8Array(readFileSync(snapshotPath));

      if (includeAssets) {
        const projectDir = projectDirOf(this.layer.dataRoot, project.id);
        const dirs = includeMedia ? [...ASSET_DIRS, ...MEDIA_DIRS] : ASSET_DIRS;
        for (const sub of dirs) {
          const absDir = join(projectDir, sub);
          if (!existsSync(absDir)) continue;
          this.walkFiles(absDir, (filePath, relPath) => {
            zipEntries[`assets/${sub}/${relPath.split(sep).join('/')}`] = new Uint8Array(readFileSync(filePath));
          });
        }
      }

      const zipped = zipSync(zipEntries, { level: 6 });
      writeFileSync(targetPath, zipped);
      return { path: targetPath, sizeBytes: zipped.byteLength, projectId: project.id };
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
  }

  importProject(packagePath: string): ProjectOpenResult {
    if (!existsSync(packagePath)) {
      throw new DataError('PACKAGE_NOT_FOUND', `项目包不存在：${packagePath}`, { path: packagePath });
    }
    const buffer = readFileSync(packagePath);
    if (buffer.length === 0) {
      throw new DataError('PACKAGE_INVALID', '项目包为空');
    }

    let entries: Record<string, Uint8Array>;
    try {
      entries = unzipSync(new Uint8Array(buffer));
    } catch (error) {
      throw new DataError('PACKAGE_INVALID', `项目包解压失败：${(error as Error).message}`, { path: packagePath });
    }

    const manifestRaw = entries['manifest.json'];
    const dbRaw = entries['project.db'];
    if (!manifestRaw || !dbRaw) {
      throw new DataError('PACKAGE_INVALID', '项目包缺少 manifest.json 或 project.db');
    }

    let manifest: PackageManifest;
    try {
      manifest = JSON.parse(strFromU8(manifestRaw)) as PackageManifest;
    } catch (error) {
      throw new DataError('PACKAGE_INVALID', `manifest.json 解析失败：${(error as Error).message}`);
    }
    if (manifest.format !== PACKAGE_FORMAT || manifest.version !== PACKAGE_VERSION) {
      throw new DataError('PACKAGE_UNSUPPORTED', `不支持的项目包格式：${manifest.format} v${manifest.version}`);
    }

    const workDir = mkdtempSync(join(tmpdir(), 'lapian-import-'));
    const snapshotPath = join(workDir, 'project.db');
    writeFileSync(snapshotPath, dbRaw);

    let renamed = false;
    const projectId = this.layer.projects.exists(manifest.projectId)
      || existsSync(projectDirOf(this.layer.dataRoot, manifest.projectId))
      ? (renamed = true, randomUUID())
      : manifest.projectId;

    try {
      const snapshot = new Database(snapshotPath, { readonly: true });
      try {
        const projectRow = snapshot.prepare('SELECT * FROM projects WHERE id = ?').get(manifest.projectId) as
          | Record<string, unknown>
          | undefined;
        if (!projectRow) throw new DataError('PACKAGE_INVALID', '项目包内项目数据缺失');

        const shotRows = snapshot
          .prepare('SELECT * FROM shots WHERE project_id = ?')
          .all(manifest.projectId) as Array<Record<string, unknown>>;
        const stillRows = snapshot
          .prepare('SELECT * FROM stills WHERE project_id = ?')
          .all(manifest.projectId) as Array<Record<string, unknown>>;
        const noteRows = snapshot
          .prepare('SELECT * FROM notes WHERE project_id = ?')
          .all(manifest.projectId) as Array<Record<string, unknown>>;
        const shotIds = shotRows.map((row) => String(row.id));
        const tagRows = shotIds.length
          ? (snapshot
              .prepare(
                `SELECT DISTINCT t.* FROM tags t
                 JOIN shot_tags st ON st.tag_id = t.id
                 WHERE st.shot_id IN (${shotIds.map(() => '?').join(',')})`,
              )
              .all(...shotIds) as Array<Record<string, unknown>>)
          : [];
        const shotTagRows = shotIds.length
          ? (snapshot
              .prepare(`SELECT * FROM shot_tags WHERE shot_id IN (${shotIds.map(() => '?').join(',')})`)
              .all(...shotIds) as Array<{ shot_id: string; tag_id: string }>)
          : [];

        ensureProjectDirs(this.layer.dataRoot, projectId);

        const shotIdMap = new Map<string, string>();
        for (const row of shotRows) shotIdMap.set(String(row.id), randomUUID());
        const tagIdMap = new Map<string, string>();
        for (const row of tagRows) tagIdMap.set(String(row.id), this.resolveImportedTagId(row));

        this.layer.transaction(() => {
          this.insertProject(projectRow, projectId, renamed);
          for (const row of shotRows) this.insertShot(row, projectId, shotIdMap.get(String(row.id))!);
          for (const row of stillRows) {
            const shotId = row.shot_id ? shotIdMap.get(String(row.shot_id)) ?? null : null;
            this.insertStill(row, projectId, randomUUID(), shotId);
          }
          for (const row of noteRows) {
            const shotId = shotIdMap.get(String(row.shot_id));
            if (shotId) this.insertNote(row, projectId, randomUUID(), shotId);
          }
          for (const link of shotTagRows) {
            const shotId = shotIdMap.get(link.shot_id);
            const tagId = tagIdMap.get(link.tag_id);
            if (shotId && tagId) this.insertShotTag(shotId, tagId);
          }
        });

        // 资源文件复制到新项目目录
        for (const [name, data] of Object.entries(entries)) {
          if (!name.startsWith('assets/')) continue;
          const relPath = name.slice('assets/'.length);
          if (relPath.length === 0 || relPath.split('/').includes('..')) continue;
          const target = join(projectDirOf(this.layer.dataRoot, projectId), relPath.split('/').join(sep));
          mkdirSync(dirname(target), { recursive: true });
          writeFileSync(target, data);
        }

        const project = this.layer.projects.get(projectId);
        return { project, renamed };
      } finally {
        snapshot.close();
      }
    } catch (error) {
      removeProjectDir(this.layer.dataRoot, projectId);
      throw error;
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
  }

  // ---------- 内部实现 ----------

  private buildSnapshot(projectId: string, snapshotPath: string): void {
    this.layer.db.pragma('wal_checkpoint(PASSIVE)');
    const snapshot = new Database(snapshotPath);
    try {
      for (const migration of MIGRATIONS) snapshot.exec(migration.sql);
      const livePath = String(this.layer.db.name).replace(/'/g, "''");
      snapshot.exec(`ATTACH DATABASE '${livePath}' AS src`);
      snapshot.transaction(() => {
        const copy = (sql: string, params: unknown[]): void => {
          snapshot.prepare(sql).run(...params);
        };
        copy('INSERT INTO projects SELECT * FROM src.projects WHERE id = ?', [projectId]);
        copy(
          `INSERT INTO tags SELECT * FROM src.tags
           WHERE id IN (SELECT tag_id FROM src.shot_tags
                        WHERE shot_id IN (SELECT id FROM src.shots WHERE project_id = ?))`,
          [projectId],
        );
        copy('INSERT INTO shots SELECT * FROM src.shots WHERE project_id = ?', [projectId]);
        copy('INSERT INTO stills SELECT * FROM src.stills WHERE project_id = ?', [projectId]);
        copy('INSERT INTO notes SELECT * FROM src.notes WHERE project_id = ?', [projectId]);
        copy(
          `INSERT INTO shot_tags SELECT * FROM src.shot_tags
           WHERE shot_id IN (SELECT id FROM src.shots WHERE project_id = ?)`,
          [projectId],
        );
      })();
    } finally {
      snapshot.close();
    }
  }

  private resolveImportedTagId(row: Record<string, unknown>): string {
    const existing = this.layer.db
      .prepare('SELECT id FROM tags WHERE category = ? AND name = ?')
      .get(String(row.category), String(row.name)) as { id: string } | undefined;
    if (existing) return existing.id;

    const id = String(row.id);
    const taken = this.layer.db.prepare('SELECT 1 FROM tags WHERE id = ?').get(id);
    const finalId = taken ? randomUUID() : id;
    this.layer.transaction(() => {
      this.layer.db
        .prepare('INSERT INTO tags (id, category, name, color, builtin, sort_order, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(
          finalId,
          String(row.category),
          String(row.name),
          (row.color as string | null) ?? null,
          Number(row.builtin) ? 1 : 0,
          Number(row.sort_order) || 0,
          String(row.created_at),
        );
    });
    return finalId;
  }

  private insertProject(row: Record<string, unknown>, id: string, renamed: boolean): void {
    this.layer.db
      .prepare(
        `INSERT INTO projects (
          id, name, source_type, source_path, source_url, source_platform,
          media_filename, media_container, media_duration_ms, media_width, media_height, media_fps,
          media_video_codec, media_audio_codec, media_size_bytes, proxy_path,
          detect_options_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        renamed ? `${String(row.name)}（导入）` : String(row.name),
        String(row.source_type ?? 'local'),
        (row.source_path as string | null) ?? null,
        (row.source_url as string | null) ?? null,
        (row.source_platform as string | null) ?? null,
        (row.media_filename as string | null) ?? null,
        (row.media_container as string | null) ?? null,
        Number(row.media_duration_ms) || 0,
        (row.media_width as number | null) ?? null,
        (row.media_height as number | null) ?? null,
        (row.media_fps as number | null) ?? null,
        (row.media_video_codec as string | null) ?? null,
        (row.media_audio_codec as string | null) ?? null,
        (row.media_size_bytes as number | null) ?? null,
        (row.proxy_path as string | null) ?? null,
        String(row.detect_options_json ?? '{}'),
        String(row.created_at ?? new Date().toISOString()),
        new Date().toISOString(),
      );
  }

  private insertShot(row: Record<string, unknown>, projectId: string, id: string): void {
    this.layer.db
      .prepare(
        `INSERT INTO shots (
          id, project_id, shot_index, start_ms, end_ms, duration_ms,
          shot_size, camera_method, dialogue, remark, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        projectId,
        Number(row.shot_index) || 0,
        Number(row.start_ms) || 0,
        Number(row.end_ms) || 0,
        Number(row.duration_ms) || 0,
        (row.shot_size as string | null) ?? null,
        (row.camera_method as string | null) ?? null,
        (row.dialogue as string | null) ?? null,
        (row.remark as string | null) ?? null,
        String(row.created_at ?? new Date().toISOString()),
        String(row.updated_at ?? new Date().toISOString()),
      );
  }

  private insertStill(row: Record<string, unknown>, projectId: string, id: string, shotId: string | null): void {
    this.layer.db
      .prepare(
        `INSERT INTO stills (
          id, project_id, shot_id, time_ms, file_path, thumb_path, width, height,
          caption, role, annotations_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        projectId,
        shotId,
        Number(row.time_ms) || 0,
        String(row.file_path),
        (row.thumb_path as string | null) ?? null,
        (row.width as number | null) ?? null,
        (row.height as number | null) ?? null,
        (row.caption as string | null) ?? null,
        String(row.role ?? 'main'),
        String(row.annotations_json ?? '[]'),
        String(row.created_at ?? new Date().toISOString()),
        String(row.updated_at ?? new Date().toISOString()),
      );
  }

  private insertNote(row: Record<string, unknown>, projectId: string, id: string, shotId: string): void {
    this.layer.db
      .prepare('INSERT INTO notes (id, project_id, shot_id, text, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(
        id,
        projectId,
        shotId,
        String(row.text ?? ''),
        String(row.created_at ?? new Date().toISOString()),
        String(row.updated_at ?? new Date().toISOString()),
      );
  }

  private insertShotTag(shotId: string, tagId: string): void {
    this.layer.db.prepare('INSERT OR IGNORE INTO shot_tags (shot_id, tag_id) VALUES (?, ?)').run(shotId, tagId);
  }

  private walkFiles(dir: string, visit: (filePath: string, relPath: string) => void): void {
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        this.walkFiles(full, visit);
      } else if (entry.isFile()) {
        const rel = relative(dir, full);
        visit(full, rel);
      }
    }
  }
}
