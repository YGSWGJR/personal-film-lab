-- S43 分镜墙二期：分组（独立板子）。成组时跨组连线由仓储自动删除。
CREATE TABLE shot_groups (
  id         TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  name       TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_shot_groups_project ON shot_groups(project_id);

CREATE TABLE shot_group_members (
  project_id TEXT NOT NULL,
  group_id   TEXT NOT NULL,
  shot_id    TEXT NOT NULL,
  PRIMARY KEY (project_id, shot_id),
  FOREIGN KEY (group_id) REFERENCES shot_groups(id) ON DELETE CASCADE,
  FOREIGN KEY (shot_id) REFERENCES shots(id) ON DELETE CASCADE
);
CREATE INDEX idx_shot_group_members_group ON shot_group_members(group_id);
