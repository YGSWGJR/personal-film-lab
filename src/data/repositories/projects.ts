import type {
  DetectOptions,
  Project,
  ProjectCreateArgs,
  ProjectMedia,
  ProjectMediaActivateArgs,
  ProjectMediaAddArgs,
  ProjectMediaItem,
  ProjectMediaUpdateArgs,
  ProjectSource,
  ProjectUpdateArgs,
} from '../../shared/types';
import type { DataLayer } from '../db';
import { DataError } from '../errors';
import { ensureProjectDirs, removeProjectDir } from '../paths';

export const DEFAULT_DETECT_OPTIONS: DetectOptions = {
  sensitivity: 0.62,
  minShotSeconds: 0.5,
  filterTransitions: true,
  weights: { s: 0.3, c: 0.3, h: 0.4 },
};

export const DEFAULT_SOURCE: ProjectSource = {
  type: 'local',
  path: null,
  url: null,
  platform: null,
};

export const DEFAULT_MEDIA: ProjectMedia = {
  filename: null,
  container: null,
  durationMs: 0,
  width: null,
  height: null,
  fps: null,
  videoCodec: null,
  audioCodec: null,
  sizeBytes: null,
  proxyPath: null,
};

interface ProjectRow {
  id: string;
  name: string;
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
  active_media_id: string | null;
  created_at: string;
  updated_at: string;
}

export function defaultDetectOptions(): DetectOptions {
  return {
    ...DEFAULT_DETECT_OPTIONS,
    weights: { ...DEFAULT_DETECT_OPTIONS.weights },
  };
}

export function nowIso(): string {
  return new Date().toISOString();
}

export class ProjectRepository {
  constructor(private readonly layer: DataLayer) {}

  private get db() {
    return this.layer.db;
  }

  list(): Project[] {
    const rows = this.db.prepare('SELECT * FROM projects ORDER BY updated_at DESC').all() as ProjectRow[];
    return rows.map((row) => this.mapProject(row));
  }

  get(id: string): Project {
    const row = this.db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as ProjectRow | undefined;
    if (!row) throw new DataError('PROJECT_NOT_FOUND', `项目不存在：${id}`, { id });
    return this.mapProject(row);
  }

  exists(id: string): boolean {
    return Boolean(this.db.prepare('SELECT 1 FROM projects WHERE id = ?').get(id));
  }

  create(args: ProjectCreateArgs): Project {
    const name = args.name?.trim();
    if (!name) throw new DataError('INVALID_ARGUMENT', '项目名不能为空');
    const source: ProjectSource = { ...DEFAULT_SOURCE, ...(args.source ?? {}) };
    const media: ProjectMedia = { ...DEFAULT_MEDIA, ...(args.media ?? {}) };
    const detectOptions: DetectOptions = {
      ...DEFAULT_DETECT_OPTIONS,
      ...(args.detectOptions ?? {}),
      weights: { ...DEFAULT_DETECT_OPTIONS.weights, ...(args.detectOptions?.weights ?? {}) },
    };
    const id = randomUuid();
    const now = nowIso();
    const hasMedia = Boolean(
      source.path ||
        source.url ||
        media.filename ||
        media.proxyPath ||
        (args.media?.durationMs ?? 0) > 0,
    );

    ensureProjectDirs(this.layer.dataRoot, id);

    try {
      this.layer.transaction(() => {
        this.db
          .prepare(
            `INSERT INTO projects (
              id, name, source_type, source_path, source_url, source_platform,
              media_filename, media_container, media_duration_ms, media_width, media_height, media_fps,
              media_video_codec, media_audio_codec, media_size_bytes, proxy_path,
              detect_options_json, active_media_id, created_at, updated_at
            ) VALUES (
              @id, @name, @sourceType, @sourcePath, @sourceUrl, @sourcePlatform,
              @mediaFilename, @mediaContainer, @mediaDurationMs, @mediaWidth, @mediaHeight, @mediaFps,
              @mediaVideoCodec, @mediaAudioCodec, @mediaSizeBytes, @proxyPath,
              @detectOptionsJson, NULL, @createdAt, @updatedAt
            )`,
          )
          .run({
            id,
            name,
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
        if (hasMedia) {
          this.layer.projectMedia.add({
            projectId: id,
            source,
            media,
            detectOptions,
            activate: true,
          });
        }
      });
    } catch (error) {
      removeProjectDir(this.layer.dataRoot, id);
      throw error;
    }

    return this.get(id);
  }

  update(args: ProjectUpdateArgs): Project {
    const current = this.get(args.id);
    const patch = args.patch ?? {};
    const name = patch.name?.trim() ?? current.name;
    if (!name) throw new DataError('INVALID_ARGUMENT', '项目名不能为空');
    const now = nowIso();

    this.layer.transaction(() => {
      this.db
        .prepare('UPDATE projects SET name = ?, updated_at = ? WHERE id = ?')
        .run(name, now, current.id);

      const hasMediaPatch = Boolean(patch.source || patch.media || patch.detectOptions);
      if (hasMediaPatch && current.activeMediaId) {
        this.layer.projectMedia.update({
          projectId: current.id,
          mediaId: current.activeMediaId,
          patch: {
            source: patch.source,
            media: patch.media,
            detectOptions: patch.detectOptions,
          },
        });
      } else if (hasMediaPatch && current.mediaItems.length === 0) {
        this.layer.projectMedia.add({
          projectId: current.id,
          source: patch.source,
          media: patch.media,
          detectOptions: patch.detectOptions,
          activate: true,
        });
      }
    });

    return this.get(current.id);
  }

  listMedia(projectId: string): ProjectMediaItem[] {
    return this.layer.projectMedia.list(projectId);
  }

  addMedia(args: ProjectMediaAddArgs): ProjectMediaItem {
    return this.layer.projectMedia.add(args);
  }

  updateMedia(args: ProjectMediaUpdateArgs): ProjectMediaItem {
    return this.layer.projectMedia.update(args);
  }

  activateMedia(args: ProjectMediaActivateArgs): Project {
    this.layer.projectMedia.activate(args.projectId, args.mediaId);
    return this.get(args.projectId);
  }

  private mapProject(row: ProjectRow): Project {
    const mediaItems = this.layer.projectMedia.list(row.id);
    const active =
      mediaItems.find((item) => item.id === row.active_media_id) ?? mediaItems[0] ?? null;
    const notice = this.layer.wall.migrationNotice(row.id);
    const noticeField = notice ? { wallMigrationNotice: notice } : {};
    if (!active) return { ...mapLegacyProject(row, mediaItems), ...noticeField };
    return {
      id: row.id,
      name: row.name,
      source: { ...active.source },
      media: {
        filename: active.filename,
        container: active.container,
        durationMs: active.durationMs,
        width: active.width,
        height: active.height,
        fps: active.fps,
        videoCodec: active.videoCodec,
        audioCodec: active.audioCodec,
        sizeBytes: active.sizeBytes,
        proxyPath: active.proxyPath,
      },
      activeMediaId: active.id,
      mediaItems,
      ...noticeField,
      detectOptions: active.detectOptions,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  delete(id: string): void {
    this.get(id);
    this.layer.transaction(() => {
      this.db.prepare('DELETE FROM projects WHERE id = ?').run(id);
    });
    removeProjectDir(this.layer.dataRoot, id);
  }

  /** 子实体写入后统一刷新项目 updated_at（在同一事务内调用） */
  touch(id: string): void {
    this.db.prepare('UPDATE projects SET updated_at = ? WHERE id = ?').run(nowIso(), id);
  }
}

function randomUuid(): string {
  return crypto.randomUUID();
}

function mapLegacyProject(row: ProjectRow, mediaItems: ProjectMediaItem[] = []): Project {
  return {
    id: row.id,
    name: row.name,
    source: {
      type: row.source_type === 'url' ? 'url' : 'local',
      path: row.source_path,
      url: row.source_url,
      platform: row.source_platform,
    },
    media: {
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
    },
    activeMediaId: null,
    mediaItems,
    detectOptions: parseDetectOptions(row.detect_options_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function parseDetectOptions(json: string): DetectOptions {
  try {
    const parsed = JSON.parse(json) as Partial<DetectOptions>;
    return {
      ...DEFAULT_DETECT_OPTIONS,
      ...parsed,
      weights: { ...DEFAULT_DETECT_OPTIONS.weights, ...(parsed.weights ?? {}) },
    };
  } catch {
    return { ...DEFAULT_DETECT_OPTIONS, weights: { ...DEFAULT_DETECT_OPTIONS.weights } };
  }
}
