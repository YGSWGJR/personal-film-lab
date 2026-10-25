import { cpSync, existsSync, mkdirSync, rmSync, statSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import Database from 'better-sqlite3';
import type { DataLayer } from '../../data/db';
import { DataError } from '../../data/errors';
import type {
  CandidateProject,
  CandidateSource,
  ImportResult,
} from '../../shared/types';
import { resolveCandidateDataRoots } from '../paths';

const PROJECT_TABLES = ['shots', 'stills', 'scenes', 'notes'] as const;

export function scanCandidateRoots(layer: DataLayer, extraRoots: string[] = []): CandidateSource[] {
  const targetVersion = Number(layer.db.pragma('user_version', { simple: true }));
  const existingIds = new Set(layer.projects.list().map((project) => project.id));
  const roots = [...new Set([...resolveCandidateDataRoots(), ...extraRoots].map((root) => resolve(root)))]
    .filter((root) => root !== resolve(layer.dataRoot));
  const sources: CandidateSource[] = [];

  for (const root of roots) {
    const databasePath = join(root, 'lapian.db');
    if (!existsSync(databasePath) || !statSync(databasePath).isFile()) continue;

    let candidateDb: Database.Database | null = null;
    try {
      candidateDb = new Database(databasePath, { readonly: true, fileMustExist: true });
      const candidateVersion = Number(candidateDb.pragma('user_version', { simple: true }));
      if (candidateVersion !== targetVersion) {
        console.warn(
          `[data-import] skip ${root}: schema version ${candidateVersion}, expected ${targetVersion}`,
        );
        continue;
      }
      const rows = candidateDb
        .prepare(
          `SELECT p.id, p.name, p.updated_at, COUNT(s.id) AS shot_count
           FROM projects p
           LEFT JOIN shots s ON s.project_id = p.id
           GROUP BY p.id
           ORDER BY p.updated_at DESC`,
        )
        .all() as Array<{ id: string; name: string; updated_at: string; shot_count: number }>;
      const projects: CandidateProject[] = rows
        .filter((row) => !existingIds.has(row.id))
        .map((row) => ({
          id: row.id,
          name: row.name,
          shotCount: Number(row.shot_count) || 0,
          updatedAt: row.updated_at,
        }));
      if (projects.length > 0) sources.push({ root, projects });
    } catch (error) {
      console.warn(`[data-import] failed to scan ${root}: ${(error as Error).message}`);
    } finally {
      candidateDb?.close();
    }
  }
  return sources;
}

export function importProjectFrom(
  layer: DataLayer,
  root: string,
  projectId: string,
  extraAssetRoots: string[] = [],
): ImportResult {
  const sourceRoot = resolve(root);
  if (!/^[A-Za-z0-9_-]+$/u.test(projectId)) {
    throw new DataError('IMPORT_INVALID_PROJECT_ID', `项目 ID 非法：${projectId}`);
  }
  if (layer.projects.exists(projectId)) {
    return { project: layer.projects.get(projectId), imported: false, reason: 'already-exists' };
  }

  const sourceDbPath = join(sourceRoot, 'lapian.db');
  if (!existsSync(sourceDbPath)) {
    throw new DataError('IMPORT_SOURCE_NOT_FOUND', `候选数据库不存在：${sourceDbPath}`);
  }

  const sourceDb = new Database(sourceDbPath, { readonly: true, fileMustExist: true });
  const targetProjectDir = join(layer.dataRoot, 'projects', projectId);
  const projectDirExisted = existsSync(targetProjectDir);
  let copiedAssets = false;
  try {
    const targetVersion = Number(layer.db.pragma('user_version', { simple: true }));
    const sourceVersion = Number(sourceDb.pragma('user_version', { simple: true }));
    if (sourceVersion !== targetVersion) {
      throw new DataError(
        'IMPORT_SCHEMA_MISMATCH',
        `候选数据库版本不匹配：${sourceVersion}，当前版本：${targetVersion}`,
      );
    }
    const projectRow = sourceDb.prepare('SELECT * FROM projects WHERE id = ?').get(projectId) as
      | Record<string, unknown>
      | undefined;
    if (!projectRow) {
      throw new DataError('IMPORT_PROJECT_NOT_FOUND', `候选库中不存在项目：${projectId}`);
    }

    copyProjectAssets(sourceRoot, projectId, targetProjectDir, extraAssetRoots);
    copiedAssets = !projectDirExisted && existsSync(targetProjectDir);

    layer.transaction(() => {
      copyRow(layer.db, 'projects', projectRow);
      for (const table of PROJECT_TABLES) {
        const rows = sourceDb.prepare(`SELECT * FROM ${table} WHERE project_id = ?`).all(projectId) as Array<
          Record<string, unknown>
        >;
        for (const row of rows) copyRow(layer.db, table, row);
      }
      copyProjectTags(layer.db, sourceDb, projectId);
    });
    return { project: layer.projects.get(projectId), imported: true, reason: 'imported' };
  } catch (error) {
    if (copiedAssets) removeCreatedProjectDir(layer.dataRoot, projectId);
    throw error;
  } finally {
    sourceDb.close();
  }
}

function copyProjectAssets(
  sourceRoot: string,
  projectId: string,
  targetProjectDir: string,
  extraAssetRoots: string[],
): void {
  const sourceDirs = [
    join(sourceRoot, 'projects', projectId),
    ...extraAssetRoots.map((root) => join(resolve(root), projectId)),
  ];
  const uniqueDirs = [...new Set(sourceDirs.map((path) => resolve(path)))];
  for (const sourceDir of uniqueDirs) {
    if (!existsSync(sourceDir) || resolve(sourceDir) === resolve(targetProjectDir)) continue;
    mkdirSync(dirname(targetProjectDir), { recursive: true });
    cpSync(sourceDir, targetProjectDir, { recursive: true, force: false, errorOnExist: false });
  }
}

function copyProjectTags(
  targetDb: Database.Database,
  sourceDb: Database.Database,
  projectId: string,
): void {
  const sourceTags = sourceDb
    .prepare(
      `SELECT DISTINCT t.*
       FROM tags t
       JOIN shot_tags st ON st.tag_id = t.id
       JOIN shots s ON s.id = st.shot_id
       WHERE s.project_id = ?`,
    )
    .all(projectId) as Array<Record<string, unknown>>;
  const tagMap = new Map<string, string>();
  for (const tag of sourceTags) {
    const sourceId = String(tag.id);
    const byId = targetDb.prepare('SELECT id FROM tags WHERE id = ?').get(sourceId) as { id: string } | undefined;
    if (byId) {
      tagMap.set(sourceId, byId.id);
      continue;
    }
    const byName = targetDb
      .prepare('SELECT id FROM tags WHERE category = ? AND name = ?')
      .get(String(tag.category), String(tag.name)) as { id: string } | undefined;
    if (byName) {
      tagMap.set(sourceId, byName.id);
      continue;
    }
    copyRow(targetDb, 'tags', tag);
    tagMap.set(sourceId, sourceId);
  }

  const links = sourceDb
    .prepare(
      `SELECT st.shot_id, st.tag_id
       FROM shot_tags st
       JOIN shots s ON s.id = st.shot_id
       WHERE s.project_id = ?`,
    )
    .all(projectId) as Array<{ shot_id: string; tag_id: string }>;
  const insert = targetDb.prepare('INSERT OR IGNORE INTO shot_tags (shot_id, tag_id) VALUES (?, ?)');
  for (const link of links) {
    const tagId = tagMap.get(link.tag_id);
    if (tagId) insert.run(link.shot_id, tagId);
  }
}

function copyRow(targetDb: Database.Database, table: string, row: Record<string, unknown>): void {
  const available = new Set(
    (targetDb.pragma(`table_info(${table})`) as Array<{ name: string }>).map((column) => column.name),
  );
  const columns = Object.keys(row).filter((column) => available.has(column));
  if (columns.length === 0) return;
  const sql = `INSERT OR IGNORE INTO ${table} (${columns.join(', ')}) VALUES (${columns
    .map(() => '?')
    .join(', ')})`;
  targetDb.prepare(sql).run(...columns.map((column) => row[column]));
}

function removeCreatedProjectDir(dataRoot: string, projectId: string): void {
  const projectDir = resolve(dataRoot, 'projects', projectId);
  const projectsRoot = resolve(dataRoot, 'projects') + sep;
  if (!projectDir.startsWith(projectsRoot)) return;
  try {
    rmSync(projectDir, { recursive: true, force: true });
  } catch {
    // Import failure must retain the original domain error.
  }
}
