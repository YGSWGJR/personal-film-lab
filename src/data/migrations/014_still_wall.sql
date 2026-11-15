-- S42 v0.5.1：静帧墙——每个项目一面自动同步的专用分镜本，
-- 全部截取静帧（stills.role='main'）以图片节点上墙，功能与分镜墙一致。
-- board 由 WallBoardsRepository.openStillWall 按需创建并全量对账同步。

CREATE TABLE still_wall_boards (
  project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
  board_id   TEXT NOT NULL UNIQUE REFERENCES wall_boards(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL
);

CREATE TABLE still_wall_nodes (
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  still_id   TEXT NOT NULL REFERENCES stills(id) ON DELETE CASCADE,
  node_id    TEXT NOT NULL UNIQUE REFERENCES wall_nodes(id) ON DELETE CASCADE,
  PRIMARY KEY (project_id, still_id)
);
