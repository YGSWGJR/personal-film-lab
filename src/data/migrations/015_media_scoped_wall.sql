-- Existing shot ownership takes precedence over the most recently active medium.
CREATE TABLE media_wall_migration_notices (
  project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
  cross_media_edges INTEGER NOT NULL,
  cross_media_groups INTEGER NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('backup', 'package'))
);

UPDATE shots
SET media_id = (SELECT active_media_id FROM projects WHERE id = shots.project_id)
WHERE media_id IS NULL AND EXISTS (
  SELECT 1 FROM projects WHERE id = shots.project_id AND active_media_id IS NOT NULL
);

CREATE TEMP VIEW s45_wall_shots AS
SELECT s.id, s.project_id, COALESCE(s.media_id, p.active_media_id) AS media_id
FROM shots s JOIN projects p ON p.id = s.project_id;

CREATE TEMP VIEW s45_cross_edges AS
SELECT e.project_id, e.from_shot, e.to_shot
FROM shot_edges e
JOIN s45_wall_shots a ON a.id = e.from_shot
JOIN s45_wall_shots b ON b.id = e.to_shot
WHERE a.media_id IS NOT b.media_id OR a.project_id <> e.project_id OR b.project_id <> e.project_id;

CREATE TEMP VIEW s45_cross_groups AS
SELECT g.id, g.project_id
FROM shot_groups g
JOIN shot_group_members m ON m.group_id = g.id
JOIN s45_wall_shots s ON s.id = m.shot_id
GROUP BY g.id
HAVING COUNT(DISTINCT COALESCE(s.media_id, '')) > 1
   OR MAX(s.project_id <> g.project_id OR m.project_id <> g.project_id) = 1;

-- The original edges and group membership remain in the pre-migration database backup.
INSERT INTO media_wall_migration_notices
SELECT p.id,
       (SELECT COUNT(*) FROM s45_cross_edges e WHERE e.project_id = p.id),
       (SELECT COUNT(*) FROM s45_cross_groups g WHERE g.project_id = p.id),
       'backup'
FROM projects p
WHERE EXISTS (SELECT 1 FROM s45_cross_edges e WHERE e.project_id = p.id)
   OR EXISTS (SELECT 1 FROM s45_cross_groups g WHERE g.project_id = p.id);

DELETE FROM shot_edges
WHERE (project_id, from_shot, to_shot) IN (SELECT project_id, from_shot, to_shot FROM s45_cross_edges);
DELETE FROM shot_groups WHERE id IN (SELECT id FROM s45_cross_groups);
DROP VIEW s45_cross_groups;
DROP VIEW s45_cross_edges;

CREATE TABLE shot_layout_v15 (
  project_id TEXT NOT NULL,
  shot_id TEXT NOT NULL REFERENCES shots(id) ON DELETE CASCADE,
  x REAL NOT NULL,
  y REAL NOT NULL,
  updated_at INTEGER NOT NULL,
  media_id TEXT REFERENCES project_media(id) ON DELETE CASCADE,
  PRIMARY KEY (project_id, media_id, shot_id)
);
INSERT INTO shot_layout_v15 (project_id, shot_id, x, y, updated_at, media_id)
SELECT l.project_id, l.shot_id, l.x, l.y, l.updated_at, s.media_id
FROM shot_layout l LEFT JOIN s45_wall_shots s ON s.id = l.shot_id;
DROP TABLE shot_layout;
ALTER TABLE shot_layout_v15 RENAME TO shot_layout;
CREATE INDEX idx_shot_layout_media ON shot_layout(project_id, media_id);
CREATE UNIQUE INDEX idx_shot_layout_without_media ON shot_layout(project_id, shot_id) WHERE media_id IS NULL;

ALTER TABLE shot_edges ADD COLUMN media_id TEXT REFERENCES project_media(id) ON DELETE CASCADE;
UPDATE shot_edges SET media_id = (SELECT s.media_id FROM s45_wall_shots s WHERE s.id = from_shot);
CREATE INDEX idx_shot_edges_media ON shot_edges(project_id, media_id);

ALTER TABLE shot_annotations ADD COLUMN media_id TEXT REFERENCES project_media(id) ON DELETE CASCADE;
UPDATE shot_annotations SET media_id = (SELECT s.media_id FROM s45_wall_shots s WHERE s.id = shot_id);
CREATE INDEX idx_shot_annotations_media ON shot_annotations(project_id, media_id);

ALTER TABLE shot_groups ADD COLUMN media_id TEXT REFERENCES project_media(id) ON DELETE CASCADE;
UPDATE shot_groups SET media_id = COALESCE(
  (SELECT s.media_id FROM shot_group_members m JOIN s45_wall_shots s ON s.id = m.shot_id
   WHERE m.group_id = shot_groups.id LIMIT 1),
  (SELECT active_media_id FROM projects WHERE id = shot_groups.project_id)
);
CREATE INDEX idx_shot_groups_media ON shot_groups(project_id, media_id);
DROP VIEW s45_wall_shots;
