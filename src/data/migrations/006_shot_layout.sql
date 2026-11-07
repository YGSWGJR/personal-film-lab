-- 分镜墙画布一期（看板形态）：镜头卡片世界坐标布局。
-- 世界坐标 = scale=1 下的 CSS px；镜头删除时布局随 CASCADE 消失。
-- 一期不做 group_id、不做连线表。

CREATE TABLE shot_layout (
  project_id TEXT NOT NULL,
  shot_id    TEXT NOT NULL,
  x          REAL NOT NULL,
  y          REAL NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (project_id, shot_id),
  FOREIGN KEY (shot_id) REFERENCES shots(id) ON DELETE CASCADE
);
CREATE INDEX idx_shot_layout_project ON shot_layout(project_id);
