-- v0.4.0 批次2：文本节点正文与底色预留 + 节点标签表。
-- text_content：画面上写的字（区别于 title 名称，title 只作镜号/名称展示）；
-- bg_color：底色预留（本期恒 'black'，白底入口已删，保留字段防反复迁移）；
-- wall_node_tags：节点标注（景别/机位/运镜等类别），与镜头标签体系同构但不混表。
ALTER TABLE wall_nodes ADD COLUMN text_content TEXT NOT NULL DEFAULT '';
ALTER TABLE wall_nodes ADD COLUMN bg_color TEXT NOT NULL DEFAULT 'black';

CREATE TABLE wall_node_tags (
  board_id  TEXT NOT NULL,
  node_id   TEXT NOT NULL,
  category  TEXT NOT NULL,
  name      TEXT NOT NULL,
  PRIMARY KEY (board_id, node_id, category, name),
  FOREIGN KEY (node_id) REFERENCES wall_nodes(id) ON DELETE CASCADE
);
CREATE INDEX idx_wall_node_tags_node ON wall_node_tags(node_id);
