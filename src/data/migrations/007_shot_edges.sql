-- S43 分镜墙二期：连线系统。一条边 = 有方向的叙事顺序（从 from 卡到 to 卡）。
-- kind: 'solid' 主选镜头链 / 'dash' 备选镜头。
-- 同一对卡片只允许一条边（主/备共用唯一约束）；自连禁止；分组断连由仓储在分组变更时执行。

CREATE TABLE shot_edges (
  project_id TEXT NOT NULL,
  from_shot  TEXT NOT NULL,
  to_shot    TEXT NOT NULL,
  kind       TEXT NOT NULL DEFAULT 'solid' CHECK (kind IN ('solid','dash')),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (project_id, from_shot, to_shot),
  FOREIGN KEY (from_shot) REFERENCES shots(id) ON DELETE CASCADE,
  FOREIGN KEY (to_shot) REFERENCES shots(id) ON DELETE CASCADE
);
CREATE INDEX idx_shot_edges_project ON shot_edges(project_id);
