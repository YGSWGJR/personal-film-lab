-- 001_init.sql：项目 / 镜头 / 静帧 / 标签 / 笔记 / 术语（S01 §7.4）
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
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
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS shots (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  shot_index INTEGER NOT NULL DEFAULT 0,
  start_ms INTEGER NOT NULL,
  end_ms INTEGER NOT NULL,
  duration_ms INTEGER NOT NULL,
  shot_size TEXT,
  camera_method TEXT,
  dialogue TEXT,
  remark TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (start_ms >= 0),
  CHECK (end_ms >= start_ms)
);
CREATE INDEX IF NOT EXISTS idx_shots_project_start ON shots(project_id, start_ms);

CREATE TABLE IF NOT EXISTS stills (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  shot_id TEXT REFERENCES shots(id) ON DELETE CASCADE,
  time_ms INTEGER NOT NULL,
  file_path TEXT NOT NULL,
  thumb_path TEXT,
  width INTEGER,
  height INTEGER,
  caption TEXT,
  role TEXT NOT NULL DEFAULT 'main' CHECK (role IN ('main', 'auto-thumb')),
  annotations_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_stills_project_shot ON stills(project_id, shot_id);

CREATE TABLE IF NOT EXISTS tags (
  id TEXT PRIMARY KEY,
  category TEXT NOT NULL,
  name TEXT NOT NULL,
  color TEXT,
  builtin INTEGER NOT NULL DEFAULT 0,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  UNIQUE (category, name)
);

CREATE TABLE IF NOT EXISTS shot_tags (
  shot_id TEXT NOT NULL REFERENCES shots(id) ON DELETE CASCADE,
  tag_id TEXT NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  PRIMARY KEY (shot_id, tag_id)
);
CREATE INDEX IF NOT EXISTS idx_shot_tags_tag ON shot_tags(tag_id);

CREATE TABLE IF NOT EXISTS notes (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  shot_id TEXT NOT NULL REFERENCES shots(id) ON DELETE CASCADE,
  text TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_notes_project_shot ON notes(project_id, shot_id);

CREATE TABLE IF NOT EXISTS terms (
  id TEXT PRIMARY KEY,
  category TEXT NOT NULL DEFAULT 'custom',
  term TEXT NOT NULL,
  definition TEXT NOT NULL,
  builtin INTEGER NOT NULL DEFAULT 0,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  UNIQUE (term)
);