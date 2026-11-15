-- S42 C01：项目媒体成为独立实体，旧 projects 单媒体列保留为兼容投影。

CREATE TABLE project_media (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  media_index INTEGER NOT NULL DEFAULT 1,
  source_type TEXT NOT NULL DEFAULT 'local' CHECK (source_type IN ('local', 'url')),
  source_path TEXT,
  source_url TEXT,
  source_platform TEXT,
  media_filename TEXT,
  media_container TEXT,
  media_duration_ms INTEGER NOT NULL DEFAULT 0,
  media_width INTEGER,
  media_height INTEGER,
  media_fps REAL,
  media_video_codec TEXT,
  media_audio_codec TEXT,
  media_size_bytes INTEGER,
  proxy_path TEXT,
  detect_options_json TEXT NOT NULL DEFAULT '{}',
  detect_state_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (project_id, media_index)
);
CREATE INDEX idx_project_media_project ON project_media(project_id, media_index);

ALTER TABLE projects ADD COLUMN active_media_id TEXT;

INSERT INTO project_media (
  id, project_id, media_index, source_type, source_path, source_url, source_platform,
  media_filename, media_container, media_duration_ms, media_width, media_height, media_fps,
  media_video_codec, media_audio_codec, media_size_bytes, proxy_path, detect_options_json,
  detect_state_json, created_at, updated_at
)
SELECT
  'legacy-media-' || id,
  id,
  1,
  source_type,
  source_path,
  source_url,
  source_platform,
  media_filename,
  media_container,
  COALESCE(media_duration_ms, 0),
  media_width,
  media_height,
  media_fps,
  media_video_codec,
  media_audio_codec,
  media_size_bytes,
  proxy_path,
  COALESCE(detect_options_json, '{}'),
  '{}',
  created_at,
  updated_at
FROM projects;

UPDATE projects
SET active_media_id = 'legacy-media-' || id
WHERE active_media_id IS NULL;

ALTER TABLE shots ADD COLUMN media_id TEXT REFERENCES project_media(id);
ALTER TABLE scenes ADD COLUMN media_id TEXT REFERENCES project_media(id);
ALTER TABLE stills ADD COLUMN media_id TEXT REFERENCES project_media(id);

UPDATE shots
SET media_id = (SELECT active_media_id FROM projects WHERE projects.id = shots.project_id)
WHERE media_id IS NULL;

UPDATE scenes
SET media_id = (SELECT active_media_id FROM projects WHERE projects.id = scenes.project_id)
WHERE media_id IS NULL;

UPDATE stills
SET media_id = (SELECT active_media_id FROM projects WHERE projects.id = stills.project_id)
WHERE media_id IS NULL;

CREATE INDEX idx_shots_media_start ON shots(project_id, media_id, start_ms);
CREATE INDEX idx_scenes_media_start ON scenes(project_id, media_id, start_ms);
CREATE INDEX idx_stills_media_time ON stills(project_id, media_id, time_ms);
