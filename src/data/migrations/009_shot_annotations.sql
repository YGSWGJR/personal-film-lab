-- S43 分镜PPT：镜头卡标注（宿主=镜头，非静帧）。归一化坐标（x,y ∈ 0~100 / 0~56.25，16:9）。
-- type: brush/smear/line/arrow/rect/ellipse/text/mosaic；data_json 为类型相关数据（点列/文本等）。
-- 整卡覆盖式保存：saveAnnotations 按 shot 删旧插新（单事务）。
-- 马赛克置底为渲染层 z-order 约束，不在存储层表达。

CREATE TABLE shot_annotations (
  id         TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  shot_id    TEXT NOT NULL,
  type       TEXT NOT NULL,
  color      TEXT NOT NULL,
  data_json  TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (shot_id) REFERENCES shots(id) ON DELETE CASCADE
);
CREATE INDEX idx_shot_annotations_project ON shot_annotations(project_id);
CREATE INDEX idx_shot_annotations_shot ON shot_annotations(shot_id);
