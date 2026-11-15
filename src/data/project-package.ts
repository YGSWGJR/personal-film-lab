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
  appVersion: string;
  schemaVersion: number;
  exportedAt: string;
  includesAssets: boolean;
  includesMedia: boolean;
  media: Array<{
    id: string;
    index: number;
    filename: string | null;
    proxyIncluded: boolean;
  }>;
  assets: string[];
}

const PACKAGE_FORMAT = 'lapian-project';
const PACKAGE_VERSION = 2;
const SUPPORTED_PACKAGE_VERSIONS = new Set([1, PACKAGE_VERSION]);
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
      const assetPaths: string[] = [];
      const mediaItems = this.layer.projectMedia.list(project.id);
      const manifest: PackageManifest = {
        format: PACKAGE_FORMAT,
        version: PACKAGE_VERSION,
        projectId: project.id,
        name: project.name,
        appVersion: process.env['npm_package_version'] ?? '0.4.0',
        schemaVersion: Number(this.layer.db.pragma('user_version', { simple: true })),
        exportedAt: new Date().toISOString(),
        includesAssets: includeAssets,
        includesMedia: includeMedia,
        media: mediaItems.map((media) => ({
          id: media.id,
          index: media.index,
          filename: media.filename,
          proxyIncluded: includeMedia && Boolean(media.proxyPath),
        })),
        assets: assetPaths,
      };
      zipEntries['project.db'] = new Uint8Array(readFileSync(snapshotPath));

      if (includeAssets) {
        const projectDir = projectDirOf(this.layer.dataRoot, project.id);
        const dirs = includeMedia ? [...ASSET_DIRS, ...MEDIA_DIRS] : ASSET_DIRS;
        for (const sub of dirs) {
          const absDir = join(projectDir, sub);
          if (!existsSync(absDir)) continue;
          this.walkFiles(absDir, (filePath, relPath) => {
            const entryPath = `assets/${sub}/${relPath.split(sep).join('/')}`;
            zipEntries[entryPath] = new Uint8Array(readFileSync(filePath));
            assetPaths.push(entryPath);
          });
        }
      }
      zipEntries['manifest.json'] = strToU8(JSON.stringify(manifest, null, 2));

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
    if (manifest.format !== PACKAGE_FORMAT || !SUPPORTED_PACKAGE_VERSIONS.has(manifest.version)) {
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

        const hasProjectMedia = tableExists(snapshot, 'project_media');
        const mediaRows = hasProjectMedia
          ? (snapshot
              .prepare('SELECT * FROM project_media WHERE project_id = ? ORDER BY media_index ASC')
              .all(manifest.projectId) as Array<Record<string, unknown>>)
          : [
              {
                id: String(projectRow.active_media_id ?? `legacy-media-${manifest.projectId}`),
                media_index: 1,
                source_type: String(projectRow.source_type ?? 'local'),
                source_path: projectRow.source_path as string | null,
                source_url: projectRow.source_url as string | null,
                source_platform: projectRow.source_platform as string | null,
                media_filename: projectRow.media_filename as string | null,
                media_container: projectRow.media_container as string | null,
                media_duration_ms: Number(projectRow.media_duration_ms) || 0,
                media_width: projectRow.media_width as number | null,
                media_height: projectRow.media_height as number | null,
                media_fps: projectRow.media_fps as number | null,
                media_video_codec: projectRow.media_video_codec as string | null,
                media_audio_codec: projectRow.media_audio_codec as string | null,
                media_size_bytes: projectRow.media_size_bytes as number | null,
                proxy_path: projectRow.proxy_path as string | null,
                detect_options_json: String(projectRow.detect_options_json ?? '{}'),
                detect_state_json: '{}',
                created_at: String(projectRow.created_at ?? new Date().toISOString()),
                updated_at: String(projectRow.updated_at ?? new Date().toISOString()),
              },
            ];
        const shotRows = snapshot
          .prepare('SELECT * FROM shots WHERE project_id = ?')
          .all(manifest.projectId) as Array<Record<string, unknown>>;
        const stillRows = snapshot
          .prepare('SELECT * FROM stills WHERE project_id = ?')
          .all(manifest.projectId) as Array<Record<string, unknown>>;
        const noteRows = snapshot
          .prepare('SELECT * FROM notes WHERE project_id = ?')
          .all(manifest.projectId) as Array<Record<string, unknown>>;
        const sceneRows = snapshot
          .prepare('SELECT * FROM scenes WHERE project_id = ?')
          .all(manifest.projectId) as Array<Record<string, unknown>>;
        const layoutRows = tableExists(snapshot, 'shot_layout')
          ? (snapshot
              .prepare('SELECT * FROM shot_layout WHERE project_id = ?')
              .all(manifest.projectId) as Array<Record<string, unknown>>)
          : [];
        const edgeRows = tableExists(snapshot, 'shot_edges')
          ? (snapshot
              .prepare('SELECT * FROM shot_edges WHERE project_id = ?')
              .all(manifest.projectId) as Array<Record<string, unknown>>)
          : [];
        const groupRows = tableExists(snapshot, 'shot_groups')
          ? (snapshot
              .prepare('SELECT * FROM shot_groups WHERE project_id = ?')
              .all(manifest.projectId) as Array<Record<string, unknown>>)
          : [];
        const groupMemberRows = tableExists(snapshot, 'shot_group_members')
          ? (snapshot
              .prepare('SELECT * FROM shot_group_members WHERE project_id = ?')
              .all(manifest.projectId) as Array<Record<string, unknown>>)
          : [];
        const annotationRows = tableExists(snapshot, 'shot_annotations')
          ? (snapshot
              .prepare('SELECT * FROM shot_annotations WHERE project_id = ?')
              .all(manifest.projectId) as Array<Record<string, unknown>>)
          : [];
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
        const mediaIdMap = new Map<string, string>();
        for (const row of mediaRows) mediaIdMap.set(String(row.id), randomUUID());
        const groupIdMap = new Map<string, string>();
        for (const row of groupRows) groupIdMap.set(String(row.id), randomUUID());
        const activeMediaSourceId = String(
          projectRow.active_media_id ?? mediaRows[0]?.id ?? '',
        );
        const fallbackMediaId = mediaIdMap.values().next().value;
        const activeMediaId =
          mediaIdMap.get(activeMediaSourceId) ?? fallbackMediaId ?? null;
        const tagIdMap = new Map<string, string>();
        for (const row of tagRows) tagIdMap.set(String(row.id), this.resolveImportedTagId(row));

        this.layer.transaction(() => {
          this.insertProject(projectRow, projectId, renamed, activeMediaId);
          for (const row of mediaRows) {
            this.insertProjectMedia(
              row,
              projectId,
              mediaIdMap.get(String(row.id))!,
            );
          }
          for (const row of shotRows) {
            const mediaId = mediaIdMap.get(String(row.media_id)) ?? activeMediaId;
            if (!mediaId) {
              throw new DataError('PACKAGE_INVALID', '镜头缺少所属媒体');
            }
            this.insertShot(
              row,
              projectId,
              mediaId,
              shotIdMap.get(String(row.id))!,
            );
          }
          for (const row of stillRows) {
            const shotId = row.shot_id ? shotIdMap.get(String(row.shot_id)) ?? null : null;
            const mediaId = mediaIdMap.get(String(row.media_id)) ?? activeMediaId;
            if (!mediaId) {
              throw new DataError('PACKAGE_INVALID', '静帧缺少所属媒体');
            }
            this.insertStill(
              row,
              projectId,
              mediaId,
              randomUUID(),
              shotId,
            );
          }
          for (const row of noteRows) {
            const shotId = shotIdMap.get(String(row.shot_id));
            if (shotId) this.insertNote(row, projectId, randomUUID(), shotId);
          }
          for (const row of sceneRows) {
            const mediaId = mediaIdMap.get(String(row.media_id)) ?? activeMediaId;
            if (!mediaId) {
              throw new DataError('PACKAGE_INVALID', '场景缺少所属媒体');
            }
            this.insertScene(
              row,
              projectId,
              mediaId,
            );
          }
          for (const row of groupRows) {
            this.insertGroup(row, projectId, groupIdMap.get(String(row.id))!);
          }
          for (const row of layoutRows) {
            const mappedShot = shotIdMap.get(String(row.shot_id));
            if (!mappedShot) continue;
            this.layer.db
              .prepare(
                'INSERT INTO shot_layout (project_id, shot_id, x, y, updated_at) VALUES (?, ?, ?, ?, ?)',
              )
              .run(
                projectId,
                mappedShot,
                Number(row.x) || 0,
                Number(row.y) || 0,
                Number(row.updated_at) || Date.now(),
              );
          }
          for (const row of edgeRows) {
            const from = shotIdMap.get(String(row.from_shot));
            const to = shotIdMap.get(String(row.to_shot));
            if (!from || !to) continue;
            this.layer.db
              .prepare(
                'INSERT INTO shot_edges (project_id, from_shot, to_shot, kind, created_at) VALUES (?, ?, ?, ?, ?)',
              )
              .run(
                projectId,
                from,
                to,
                String(row.kind ?? 'solid'),
                Number(row.created_at) || Date.now(),
              );
          }
          for (const row of groupMemberRows) {
            const groupId = groupIdMap.get(String(row.group_id));
            const shotId = shotIdMap.get(String(row.shot_id));
            if (!groupId || !shotId) continue;
            this.layer.db
              .prepare(
                'INSERT INTO shot_group_members (project_id, group_id, shot_id) VALUES (?, ?, ?)',
              )
              .run(projectId, groupId, shotId);
          }
          for (const row of annotationRows) {
            const shotId = shotIdMap.get(String(row.shot_id));
            if (!shotId) continue;
            this.layer.db
              .prepare(
                `INSERT INTO shot_annotations
                  (id, project_id, shot_id, type, color, data_json, created_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?)`,
              )
              .run(
                randomUUID(),
                projectId,
                shotId,
                String(row.type),
                String(row.color),
                String(row.data_json),
                Number(row.created_at) || Date.now(),
              );
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
        copy('INSERT INTO project_media SELECT * FROM src.project_media WHERE project_id = ?', [projectId]);
        copy(
          `INSERT OR IGNORE INTO tags (id, category, name, color, builtin, sort_order, created_at)
           SELECT id, category, name, color, builtin, sort_order, created_at FROM src.tags
           WHERE id IN (SELECT tag_id FROM src.shot_tags
                        WHERE shot_id IN (SELECT id FROM src.shots WHERE project_id = ?))`,
          [projectId],
        );
        copy('INSERT INTO shots SELECT * FROM src.shots WHERE project_id = ?', [projectId]);
        copy('INSERT INTO stills SELECT * FROM src.stills WHERE project_id = ?', [projectId]);
        copy('INSERT INTO notes SELECT * FROM src.notes WHERE project_id = ?', [projectId]);
        copy('INSERT INTO scenes SELECT * FROM src.scenes WHERE project_id = ?', [projectId]);
        copy('INSERT INTO shot_layout SELECT * FROM src.shot_layout WHERE project_id = ?', [projectId]);
        copy('INSERT INTO shot_edges SELECT * FROM src.shot_edges WHERE project_id = ?', [projectId]);
        copy('INSERT INTO shot_groups SELECT * FROM src.shot_groups WHERE project_id = ?', [projectId]);
        copy(
          'INSERT INTO shot_group_members SELECT * FROM src.shot_group_members WHERE project_id = ?',
          [projectId],
        );
        copy(
          'INSERT INTO shot_annotations SELECT * FROM src.shot_annotations WHERE project_id = ?',
          [projectId],
        );
        copy(
          `INSERT OR IGNORE INTO shot_tags (shot_id, tag_id)
           SELECT link.shot_id, target_tag.id
           FROM src.shot_tags link
           JOIN src.shots source_shot ON source_shot.id = link.shot_id
           JOIN src.tags source_tag ON source_tag.id = link.tag_id
           JOIN tags target_tag
             ON target_tag.category = source_tag.category
            AND target_tag.name = source_tag.name
           WHERE source_shot.project_id = ?`,
          [projectId],
        );
        snapshot
          .prepare(
            `UPDATE projects
             SET source_path = NULL, proxy_path = NULL
             WHERE id = ?`,
          )
          .run(projectId);
        snapshot
          .prepare(
            `UPDATE project_media
             SET source_path = NULL, proxy_path = NULL
             WHERE project_id = ?`,
          )
          .run(projectId);
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

  private insertProject(
    row: Record<string, unknown>,
    id: string,
    renamed: boolean,
    activeMediaId: string | null,
  ): void {
    this.layer.db
      .prepare(
        `INSERT INTO projects (
          id, name, source_type, source_path, source_url, source_platform,
          media_filename, media_container, media_duration_ms, media_width, media_height, media_fps,
          media_video_codec, media_audio_codec, media_size_bytes, proxy_path,
          detect_options_json, active_media_id, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
        activeMediaId,
        String(row.created_at ?? new Date().toISOString()),
        new Date().toISOString(),
      );
  }

  private insertProjectMedia(
    row: Record<string, unknown>,
    projectId: string,
    id: string,
  ): void {
    this.layer.db
      .prepare(
        `INSERT INTO project_media (
          id, project_id, media_index, source_type, source_path, source_url, source_platform,
          media_filename, media_container, media_duration_ms, media_width, media_height, media_fps,
          media_video_codec, media_audio_codec, media_size_bytes, proxy_path, detect_options_json,
          detect_state_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        projectId,
        Number(row.media_index) || 1,
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
        String(row.detect_state_json ?? '{}'),
        String(row.created_at ?? new Date().toISOString()),
        String(row.updated_at ?? new Date().toISOString()),
      );
  }

  private insertShot(
    row: Record<string, unknown>,
    projectId: string,
    mediaId: string,
    id: string,
  ): void {
    this.layer.db
      .prepare(
        `INSERT INTO shots (
          id, project_id, media_id, shot_index, start_ms, end_ms, duration_ms,
          shot_size, camera_method, dialogue, remark, origin, locked, manual_fields_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        projectId,
        mediaId,
        Number(row.shot_index) || 0,
        Number(row.start_ms) || 0,
        Number(row.end_ms) || 0,
        Number(row.duration_ms) || 0,
        (row.shot_size as string | null) ?? null,
        (row.camera_method as string | null) ?? null,
        (row.dialogue as string | null) ?? null,
        (row.remark as string | null) ?? null,
        String(row.origin ?? 'manual'),
        Number(row.locked) ? 1 : 0,
        typeof row.manual_fields_json === 'string' ? row.manual_fields_json : '[]',
        String(row.created_at ?? new Date().toISOString()),
        String(row.updated_at ?? new Date().toISOString()),
      );
  }

  private insertScene(
    row: Record<string, unknown>,
    projectId: string,
    mediaId: string,
  ): void {
    this.layer.db
      .prepare(
        `INSERT INTO scenes (
          id, project_id, media_id, scene_index, label, start_ms, end_ms, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        randomUUID(),
        projectId,
        mediaId,
        Number(row.scene_index) || 0,
        (row.label as string | null) ?? null,
        Number(row.start_ms) || 0,
        Number(row.end_ms) || 0,
        String(row.created_at ?? new Date().toISOString()),
        String(row.updated_at ?? new Date().toISOString()),
      );
  }

  private insertStill(
    row: Record<string, unknown>,
    projectId: string,
    mediaId: string,
    id: string,
    shotId: string | null,
  ): void {
    this.layer.db
      .prepare(
        `INSERT INTO stills (
          id, project_id, media_id, shot_id, time_ms, file_path, thumb_path, width, height,
          caption, role, annotations_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        projectId,
        mediaId,
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

  private insertGroup(
    row: Record<string, unknown>,
    projectId: string,
    id: string,
  ): void {
    this.layer.db
      .prepare(
        'INSERT INTO shot_groups (id, project_id, name, created_at) VALUES (?, ?, ?, ?)',
      )
      .run(
        id,
        projectId,
        String(row.name ?? '场景'),
        Number(row.created_at) || Date.now(),
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

function tableExists(db: Database.Database, table: string): boolean {
  return Boolean(
    db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table),
  );
}
