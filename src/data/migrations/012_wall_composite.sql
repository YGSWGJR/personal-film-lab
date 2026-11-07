-- 批次9：复合节点（组即节点）。
-- wall_nodes.source 的 CHECK 无法 ALTER，需重建表：新增 'composite' 类型与 parent_id 自引用列。
-- 子表（edges/tags/annotations）引用 wall_nodes，先备份数据→随父表一起重建→回填。

CREATE TABLE wall_nodes_new (
  id         TEXT PRIMARY KEY,
  board_id   TEXT NOT NULL,
  source     TEXT NOT NULL CHECK (source IN ('image','text','composite')),
  asset_path TEXT,
  parent_id  TEXT,
  title      TEXT NOT NULL DEFAULT '',
  text_content TEXT NOT NULL DEFAULT '',
  bg_color   TEXT NOT NULL DEFAULT 'black',
  duration_ms INTEGER NOT NULL DEFAULT 3000,
  note       TEXT NOT NULL DEFAULT '',
  shot_size  TEXT,
  camera_method TEXT,
  x          REAL NOT NULL DEFAULT 0,
  y          REAL NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (board_id) REFERENCES wall_boards(id) ON DELETE CASCADE,
  FOREIGN KEY (parent_id) REFERENCES wall_nodes_new(id) ON DELETE CASCADE
);
INSERT INTO wall_nodes_new (
  id, board_id, source, asset_path, title, text_content, bg_color,
  duration_ms, note, shot_size, camera_method, x, y, created_at, updated_at
)
SELECT
  id, board_id, source, asset_path, title, text_content, bg_color,
  duration_ms, note, shot_size, camera_method, x, y, created_at, updated_at
FROM wall_nodes;

CREATE TABLE wall_node_edges_bak AS SELECT board_id, from_node, to_node, kind, created_at FROM wall_node_edges;
CREATE TABLE wall_node_tags_bak AS SELECT board_id, node_id, category, name FROM wall_node_tags;
CREATE TABLE wall_node_annotations_bak AS SELECT id, board_id, node_id, type, color, data_json, created_at FROM wall_node_annotations;

DROP TABLE wall_node_annotations;
DROP TABLE wall_node_tags;
DROP TABLE wall_node_edges;
DROP TABLE wall_nodes;
ALTER TABLE wall_nodes_new RENAME TO wall_nodes;
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
INSERT INTO wall_node_edges (board_id, from_node, to_node, kind, created_at)
SELECT board_id, from_node, to_node, kind, created_at FROM wall_node_edges_bak;
DROP TABLE wall_node_edges_bak;

CREATE TABLE wall_node_tags (
  board_id  TEXT NOT NULL,
  node_id   TEXT NOT NULL,
  category  TEXT NOT NULL,
  name      TEXT NOT NULL,
  PRIMARY KEY (board_id, node_id, category, name),
  FOREIGN KEY (node_id) REFERENCES wall_nodes(id) ON DELETE CASCADE
);
CREATE INDEX idx_wall_node_tags_node ON wall_node_tags(node_id);
INSERT INTO wall_node_tags (board_id, node_id, category, name)
SELECT board_id, node_id, category, name FROM wall_node_tags_bak;
DROP TABLE wall_node_tags_bak;

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
INSERT INTO wall_node_annotations (id, board_id, node_id, type, color, data_json, created_at)
SELECT id, board_id, node_id, type, color, data_json, created_at FROM wall_node_annotations_bak;
DROP TABLE wall_node_annotations_bak;
