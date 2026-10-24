-- S07：镜头检测结果字段与场景分组表。

ALTER TABLE shots ADD COLUMN origin TEXT NOT NULL DEFAULT 'manual'
  CHECK (origin IN ('manual', 'auto'));
ALTER TABLE shots ADD COLUMN locked INTEGER NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS scenes (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  scene_index INTEGER NOT NULL DEFAULT 0,
  label TEXT,
  start_ms INTEGER NOT NULL,
  end_ms INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (start_ms >= 0),
  CHECK (end_ms >= start_ms)
);
CREATE INDEX IF NOT EXISTS idx_scenes_project_start ON scenes(project_id, start_ms);
