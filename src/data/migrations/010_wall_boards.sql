-- S44 独立分镜本：与拉片项目解耦的画布（无素材也可创作）。
-- 项目内分镜本继续使用 shot_layout/shot_edges/shot_annotations（project 维度，零迁移）；
-- 独立分镜本的节点/连线/标注存本组表。图片资产复制到 projects/boards/<boardId>/（lapian-asset 协议白名单内）。

CREATE TABLE wall_boards (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE wall_nodes (
  id         TEXT PRIMARY KEY,
  board_id   TEXT NOT NULL,
  source     TEXT NOT NULL CHECK (source IN ('image','text')),
  asset_path TEXT,
  title      TEXT NOT NULL DEFAULT '',
  duration_ms INTEGER NOT NULL DEFAULT 3000,
  note       TEXT NOT NULL DEFAULT '',
  shot_size  TEXT,
  camera_method TEXT,
  x          REAL NOT NULL DEFAULT 0,
  y          REAL NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (board_id) REFERENCES wall_boards(id) ON DELETE CASCADE
);
CREATE INDEX idx_wall_nodes_board ON wall_nodes(board_id);

CREATE TABLE wall_node_edges (
  board_id  TEXT NOT NULL,
  from_node TEXT NOT NULL,
  to_node   TEXT NOT NULL,
  kind      TEXT NOT NULL DEFAULT 'solid' CHECK (kind IN ('solid','dash')),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (board_id, from_node, to_node),
  FOREIGN KEY (from_node) REFERENCES wall_nodes(id) ON DELETE CASCADE,
  FOREIGN KEY (to_node) REFERENCES wall_nodes(id) ON DELETE CASCADE
);
CREATE INDEX idx_wall_node_edges_board ON wall_node_edges(board_id);

CREATE TABLE wall_node_annotations (
  id         TEXT PRIMARY KEY,
  board_id   TEXT NOT NULL,
  node_id    TEXT NOT NULL,
  type       TEXT NOT NULL,
  color      TEXT NOT NULL,
  data_json  TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (node_id) REFERENCES wall_nodes(id) ON DELETE CASCADE
);
CREATE INDEX idx_wall_node_annotations_board ON wall_node_annotations(board_id);
