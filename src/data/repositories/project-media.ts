import { randomUUID } from 'node:crypto';
import type {
  DetectOptions,
  ProjectMedia,
  ProjectMediaAddArgs,
  ProjectMediaItem,
  ProjectMediaUpdateArgs,
  ProjectSource,
} from '../../shared/types';
import type { DataLayer } from '../db';
import { DataError } from '../errors';
import {
  DEFAULT_MEDIA,
  DEFAULT_SOURCE,
  defaultDetectOptions,
  nowIso,
  parseDetectOptions,
} from './projects';

export interface ProjectMediaRow {
  id: string;
  project_id: string;
  media_index: number;
  source_type: string;
  source_path: string | null;
  source_url: string | null;
  source_platform: string | null;
  media_filename: string | null;
  media_container: string | null;
  media_duration_ms: number;
  media_width: number | null;
  media_height: number | null;
  media_fps: number | null;
  media_video_codec: string | null;
  media_audio_codec: string | null;
  media_size_bytes: number | null;
  proxy_path: string | null;
  detect_options_json: string;
  detect_state_json: string;
  created_at: string;
  updated_at: string;
}

export class ProjectMediaRepository {
  constructor(private readonly layer: DataLayer) {}

  private get db() {
    return this.layer.db;
  }

  list(projectId: string): ProjectMediaItem[] {
    this.assertProject(projectId);
    const rows = this.db
      .prepare('SELECT * FROM project_media WHERE project_id = ? ORDER BY media_index ASC')
      .all(projectId) as ProjectMediaRow[];
    return rows.map(mapProjectMedia);
  }

  get(projectId: string, mediaId: string): ProjectMediaItem {
    const row = this.db
      .prepare('SELECT * FROM project_media WHERE project_id = ? AND id = ?')
      .get(projectId, mediaId) as ProjectMediaRow | undefined;
    if (!row) {
      throw new DataError('PROJECT_MEDIA_NOT_FOUND', `项目媒体不存在：${mediaId}`, {
        projectId,
        mediaId,
      });
    }
    return mapProjectMedia(row);
  }

  active(projectId: string): ProjectMediaItem | null {
    const row = this.db
      .prepare(
        `SELECT pm.*
         FROM projects p
         JOIN project_media pm ON pm.id = p.active_media_id
         WHERE p.id = ?`,
      )
      .get(projectId) as ProjectMediaRow | undefined;
    if (row) return mapProjectMedia(row);
    const first = this.db
      .prepare('SELECT * FROM project_media WHERE project_id = ? ORDER BY media_index ASC LIMIT 1')
      .get(projectId) as ProjectMediaRow | undefined;
    return first ? mapProjectMedia(first) : null;
  }

  add(args: ProjectMediaAddArgs): ProjectMediaItem {
    this.assertProject(args.projectId);
    const id = randomUUID();
    const now = nowIso();
    const source: ProjectSource = { ...DEFAULT_SOURCE, ...(args.source ?? {}) };
    const media: ProjectMedia = { ...DEFAULT_MEDIA, ...(args.media ?? {}) };
    const detectOptions = {
      ...defaultDetectOptions(),
      ...(args.detectOptions ?? {}),
    };

    this.layer.transaction(() => {
      const next = this.db
        .prepare(
          'SELECT COALESCE(MAX(media_index), 0) + 1 AS next FROM project_media WHERE project_id = ?',
        )
        .get(args.projectId) as { next: number };
      this.db
        .prepare(
          `INSERT INTO project_media (
            id, project_id, media_index, source_type, source_path, source_url, source_platform,
            media_filename, media_container, media_duration_ms, media_width, media_height, media_fps,
            media_video_codec, media_audio_codec, media_size_bytes, proxy_path, detect_options_json,
            detect_state_json, created_at, updated_at
          ) VALUES (
            @id, @projectId, @mediaIndex, @sourceType, @sourcePath, @sourceUrl, @sourcePlatform,
            @mediaFilename, @mediaContainer, @mediaDurationMs, @mediaWidth, @mediaHeight, @mediaFps,
            @mediaVideoCodec, @mediaAudioCodec, @mediaSizeBytes, @proxyPath, @detectOptionsJson,
            '{}', @createdAt, @updatedAt
          )`,
        )
        .run({
          id,
          projectId: args.projectId,
          mediaIndex: next.next,
          sourceType: source.type,
          sourcePath: source.path,
          sourceUrl: source.url,
          sourcePlatform: source.platform,
          mediaFilename: media.filename,
          mediaContainer: media.container,
          mediaDurationMs: Math.max(0, Math.round(media.durationMs ?? 0)),
          mediaWidth: media.width,
          mediaHeight: media.height,
          mediaFps: media.fps,
          mediaVideoCodec: media.videoCodec,
          mediaAudioCodec: media.audioCodec,
          mediaSizeBytes: media.sizeBytes,
          proxyPath: media.proxyPath,
          detectOptionsJson: JSON.stringify(detectOptions),
          createdAt: now,
          updatedAt: now,
        });

      if (args.activate !== false || !this.activeId(args.projectId)) {
        this.activateInTransaction(args.projectId, id);
      }
      this.layer.projects.touch(args.projectId);
    });

    return this.get(args.projectId, id);
  }

  update(args: ProjectMediaUpdateArgs): ProjectMediaItem {
    const current = this.get(args.projectId, args.mediaId);
    const source: ProjectSource = { ...current.source, ...(args.patch.source ?? {}) };
    const media: ProjectMedia = { ...current, ...(args.patch.media ?? {}) };
    const detectOptions: DetectOptions = {
      ...current.detectOptions,
      ...(args.patch.detectOptions ?? {}),
      weights: {
        ...current.detectOptions.weights,
        ...(args.patch.detectOptions?.weights ?? {}),
      },
    };

    this.layer.transaction(() => {
      this.db
        .prepare(
          `UPDATE project_media SET
            source_type = @sourceType, source_path = @sourcePath, source_url = @sourceUrl,
            source_platform = @sourcePlatform, media_filename = @mediaFilename,
            media_container = @mediaContainer, media_duration_ms = @mediaDurationMs,
            media_width = @mediaWidth, media_height = @mediaHeight, media_fps = @mediaFps,
            media_video_codec = @mediaVideoCodec, media_audio_codec = @mediaAudioCodec,
            media_size_bytes = @mediaSizeBytes, proxy_path = @proxyPath,
            detect_options_json = @detectOptionsJson, updated_at = @updatedAt
          WHERE project_id = @projectId AND id = @mediaId`,
        )
        .run({
          projectId: args.projectId,
          mediaId: args.mediaId,
          sourceType: source.type,
          sourcePath: source.path,
          sourceUrl: source.url,
          sourcePlatform: source.platform,
          mediaFilename: media.filename,
          mediaContainer: media.container,
          mediaDurationMs: Math.max(0, Math.round(media.durationMs ?? 0)),
          mediaWidth: media.width,
          mediaHeight: media.height,
          mediaFps: media.fps,
          mediaVideoCodec: media.videoCodec,
          mediaAudioCodec: media.audioCodec,
          mediaSizeBytes: media.sizeBytes,
          proxyPath: media.proxyPath,
          detectOptionsJson: JSON.stringify(detectOptions),
          updatedAt: nowIso(),
        });
      if (this.activeId(args.projectId) === args.mediaId) {
        this.syncLegacyProject(args.projectId, args.mediaId);
      }
      this.layer.projects.touch(args.projectId);
    });

    return this.get(args.projectId, args.mediaId);
  }

  activate(projectId: string, mediaId: string): ProjectMediaItem {
    this.get(projectId, mediaId);
    this.layer.transaction(() => {
      this.activateInTransaction(projectId, mediaId);
      this.layer.projects.touch(projectId);
    });
    return this.get(projectId, mediaId);
  }

  remove(projectId: string, mediaId: string): void {
    this.get(projectId, mediaId);
    const detached = this.layer.transaction(() => {
      const stillWall = this.layer.wallBoards.detachMediaStills(projectId, mediaId);
      this.db.prepare('DELETE FROM stills WHERE project_id = ? AND media_id = ?').run(projectId, mediaId);
      this.db.prepare('DELETE FROM scenes WHERE project_id = ? AND media_id = ?').run(projectId, mediaId);
      this.db.prepare('DELETE FROM shots WHERE project_id = ? AND media_id = ?').run(projectId, mediaId);
      this.db.prepare('DELETE FROM project_media WHERE project_id = ? AND id = ?').run(projectId, mediaId);
      if (this.activeId(projectId) === mediaId) {
        const next = this.active(projectId);
        if (next) {
          this.activateInTransaction(projectId, next.id);
        } else {
          this.db.prepare(
            `UPDATE projects SET active_media_id = NULL, source_type = 'local', source_path = NULL,
              source_url = NULL, source_platform = NULL, media_filename = NULL, media_container = NULL,
              media_duration_ms = 0, media_width = NULL, media_height = NULL, media_fps = NULL,
              media_video_codec = NULL, media_audio_codec = NULL, media_size_bytes = NULL,
              proxy_path = NULL, detect_options_json = ? WHERE id = ?`,
          ).run(JSON.stringify(defaultDetectOptions()), projectId);
        }
      }
      this.layer.projects.touch(projectId);
      return stillWall;
    });
    if (detached) this.layer.wallBoards.cleanDetachedMediaAssets(detached.boardId, detached.assets);
  }

  activeId(projectId: string): string | null {
    const row = this.db
      .prepare('SELECT active_media_id FROM projects WHERE id = ?')
      .get(projectId) as { active_media_id: string | null } | undefined;
    return row?.active_media_id ?? null;
  }

  private activateInTransaction(projectId: string, mediaId: string): void {
    this.db
      .prepare('UPDATE projects SET active_media_id = ?, updated_at = ? WHERE id = ?')
      .run(mediaId, nowIso(), projectId);
    this.syncLegacyProject(projectId, mediaId);
  }

  private syncLegacyProject(projectId: string, mediaId: string): void {
    const row = this.get(projectId, mediaId);
    this.db
      .prepare(
        `UPDATE projects SET
          source_type = @sourceType, source_path = @sourcePath, source_url = @sourceUrl,
          source_platform = @sourcePlatform, media_filename = @mediaFilename,
          media_container = @mediaContainer, media_duration_ms = @mediaDurationMs,
          media_width = @mediaWidth, media_height = @mediaHeight, media_fps = @mediaFps,
          media_video_codec = @mediaVideoCodec, media_audio_codec = @mediaAudioCodec,
          media_size_bytes = @mediaSizeBytes, proxy_path = @proxyPath,
          detect_options_json = @detectOptionsJson
        WHERE id = @projectId`,
      )
      .run({
        projectId,
        sourceType: row.source.type,
        sourcePath: row.source.path,
        sourceUrl: row.source.url,
        sourcePlatform: row.source.platform,
        mediaFilename: row.filename,
        mediaContainer: row.container,
        mediaDurationMs: row.durationMs,
        mediaWidth: row.width,
        mediaHeight: row.height,
        mediaFps: row.fps,
        mediaVideoCodec: row.videoCodec,
        mediaAudioCodec: row.audioCodec,
        mediaSizeBytes: row.sizeBytes,
        proxyPath: row.proxyPath,
        detectOptionsJson: JSON.stringify(row.detectOptions),
      });
  }

  private assertProject(projectId: string): void {
    if (!this.layer.projects.exists(projectId)) {
      throw new DataError('PROJECT_NOT_FOUND', `项目不存在：${projectId}`, { projectId });
    }
  }
}

export function mapProjectMedia(row: ProjectMediaRow): ProjectMediaItem {
  return {
    id: row.id,
    projectId: row.project_id,
    index: row.media_index,
    source: {
      type: row.source_type === 'url' ? 'url' : 'local',
      path: row.source_path,
      url: row.source_url,
      platform: row.source_platform,
    },
    filename: row.media_filename,
    container: row.media_container,
    durationMs: row.media_duration_ms,
    width: row.media_width,
    height: row.media_height,
    fps: row.media_fps,
    videoCodec: row.media_video_codec,
    audioCodec: row.media_audio_codec,
    sizeBytes: row.media_size_bytes,
    proxyPath: row.proxy_path,
    detectOptions: parseDetectOptions(row.detect_options_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
