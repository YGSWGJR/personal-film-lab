import type { DetectOptions, Project, ProjectCreateArgs, ProjectMedia, ProjectSource, ProjectUpdateArgs } from '../../shared/types';
import type { DataLayer } from '../db';
import { DataError } from '../errors';
import { ensureProjectDirs, removeProjectDir } from '../paths';

const DEFAULT_DETECT_OPTIONS: DetectOptions = {
  sensitivity: 0.62,
  minShotSeconds: 0.5,
  filterTransitions: true,
  weights: { s: 0.3, c: 0.3, h: 0.4 },
};

const DEFAULT_SOURCE: ProjectSource = {
  type: 'local',
  path: null,
  url: null,
  platform: null,
};

const DEFAULT_MEDIA: ProjectMedia = {
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
  created_at: string;
  updated_at: string;
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
    return rows.map(mapProject);
  }

  get(id: string): Project {
    const row = this.db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as ProjectRow | undefined;
    if (!row) throw new DataError('PROJECT_NOT_FOUND', `项目不存在：${id}`, { id });
    return mapProject(row);
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

    ensureProjectDirs(this.layer.dataRoot, id);

    try {
      this.layer.transaction(() => {
        this.db
          .prepare(
            `INSERT INTO projects (
              id, name, source_type, source_path, source_url, source_platform,
              media_filename, media_container, media_duration_ms, media_width, media_height, media_fps,
              media_video_codec, media_audio_codec, media_size_bytes, proxy_path,
              detect_options_json, created_at, updated_at
            ) VALUES (
              @id, @name, @sourceType, @sourcePath, @sourceUrl, @sourcePlatform,
              @mediaFilename, @mediaContainer, @mediaDurationMs, @mediaWidth, @mediaHeight, @mediaFps,
              @mediaVideoCodec, @mediaAudioCodec, @mediaSizeBytes, @proxyPath,
              @detectOptionsJson, @createdAt, @updatedAt
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

    const source: ProjectSource = { ...current.source, ...(patch.source ?? {}) };
    const media: ProjectMedia = { ...current.media, ...(patch.media ?? {}) };
    const detectOptions: DetectOptions = {
      ...current.detectOptions,
      ...(patch.detectOptions ?? {}),
      weights: { ...current.detectOptions.weights, ...(patch.detectOptions?.weights ?? {}) },
    };
    const now = nowIso();

    this.layer.transaction(() => {
      this.db
        .prepare(
          `UPDATE projects SET
            name = @name, source_type = @sourceType, source_path = @sourcePath, source_url = @sourceUrl,
            source_platform = @sourcePlatform, media_filename = @mediaFilename, media_container = @mediaContainer,
            media_duration_ms = @mediaDurationMs, media_width = @mediaWidth, media_height = @mediaHeight,
            media_fps = @mediaFps, media_video_codec = @mediaVideoCodec, media_audio_codec = @mediaAudioCodec,
            media_size_bytes = @mediaSizeBytes, proxy_path = @proxyPath, detect_options_json = @detectOptionsJson,
            updated_at = @updatedAt
          WHERE id = @id`,
        )
        .run({
          id: current.id,
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
          updatedAt: now,
        });
    });

    return this.get(current.id);
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

function mapProject(row: ProjectRow): Project {
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
    detectOptions: parseDetectOptions(row.detect_options_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function parseDetectOptions(json: string): DetectOptions {
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