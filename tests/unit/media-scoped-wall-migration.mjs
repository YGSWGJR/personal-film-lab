import assert from 'node:assert/strict';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { strToU8, zipSync } from 'fflate';

const migrationDir = new URL('../../src/data/migrations/', import.meta.url);
const files = readdirSync(migrationDir).filter((file) => /^\d{3}_.*\.sql$/u.test(file)).sort();
const database = new Database(':memory:');
const migrateTo = (target) => {
  for (const file of files) {
    const version = Number(file.slice(0, 3));
    if (version > target || version <= database.pragma('user_version', { simple: true })) continue;
    database.transaction(() => {
      database.exec(readFileSync(new URL(file, migrationDir), 'utf8'));
      database.pragma(`user_version = ${version}`);
    })();
  }
};
const tables = ['shot_layout', 'shot_edges', 'shot_annotations', 'shot_groups', 'shot_group_members', 'stills'];
const counts = () => Object.fromEntries(tables.map((table) => [
  table, database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count,
]));

try {
  database.pragma('foreign_keys = ON');
  migrateTo(14);
  database.exec(`
    INSERT INTO projects (id, name, active_media_id, created_at, updated_at)
    VALUES ('p', 'Legacy', 'b', '2026-11-16', '2026-11-16');
    INSERT INTO project_media (id, project_id, media_index, created_at, updated_at)
    VALUES ('a', 'p', 1, '2026-11-16', '2026-11-16'), ('b', 'p', 2, '2026-11-16', '2026-11-16');
    INSERT INTO shots (id, project_id, media_id, shot_index, start_ms, end_ms, duration_ms, created_at, updated_at)
    VALUES
    ('a1', 'p', 'a', 1, 0, 1000, 1000, '2026-11-16', '2026-11-16'),
    ('a2', 'p', 'a', 2, 1000, 2000, 1000, '2026-11-16', '2026-11-16'),
    ('a3', 'p', 'a', 3, 2000, 3000, 1000, '2026-11-16', '2026-11-16'),
    ('b1', 'p', 'b', 1, 0, 1000, 1000, '2026-11-16', '2026-11-16'),
    ('fallback', 'p', NULL, 2, 1000, 2000, 1000, '2026-11-16', '2026-11-16');
    INSERT INTO shot_layout VALUES ('p', 'a1', 12.25, 88, 100), ('p', 'fallback', 5, 9, 101);
    INSERT INTO shot_edges VALUES ('p', 'a1', 'a2', 'dash', 100), ('p', 'a3', 'b1', 'solid', 101);
    INSERT INTO shot_annotations VALUES ('annotation-a', 'p', 'a1', 'text', '#fff', '{"text":"原标注"}', 100);
    INSERT INTO shot_groups VALUES ('group-a', 'p', 'Same medium', 100), ('group-ab', 'p', 'Across media', 101);
    INSERT INTO shot_group_members VALUES ('p', 'group-a', 'a1'), ('p', 'group-a', 'a2'),
      ('p', 'group-ab', 'a3'), ('p', 'group-ab', 'b1');
    INSERT INTO stills (id, project_id, media_id, shot_id, time_ms, file_path, created_at, updated_at)
    VALUES ('p-still', 'p', 'a', 'a1', 300, 'stills/frame.png', '2026-11-16', '2026-11-16');
  `);
  const before = counts();
  const fixtureDirectory = process.argv[2];
  if (fixtureDirectory) {
    const snapshot = database.serialize();
    writeFileSync(join(fixtureDirectory, 'wall-v14.db'), snapshot);
    writeFileSync(join(fixtureDirectory, 'wall-v14.lapian'), zipSync({
      'manifest.json': strToU8(JSON.stringify({
        format: 'lapian-project', version: 2, projectId: 'p', schemaVersion: 14,
      })),
      'project.db': new Uint8Array(snapshot),
    }));
  }
  migrateTo(15);
  assert.equal(database.pragma('user_version', { simple: true }), 15);
  const after = counts();
  assert.deepEqual(after, { shot_layout: 2, shot_edges: 1, shot_annotations: 1, shot_groups: 1, shot_group_members: 2, stills: 1 });
  assert.deepEqual(database.prepare(
    'SELECT shot_id, media_id, x, y, updated_at FROM shot_layout ORDER BY shot_id',
  ).all(), [
    { shot_id: 'a1', media_id: 'a', x: 12.25, y: 88, updated_at: 100 },
    { shot_id: 'fallback', media_id: 'b', x: 5, y: 9, updated_at: 101 },
  ]);
  assert.deepEqual(database.prepare('SELECT from_shot, to_shot, media_id, kind FROM shot_edges').all(), [
    { from_shot: 'a1', to_shot: 'a2', media_id: 'a', kind: 'dash' },
  ]);
  assert.equal(database.prepare('SELECT data_json FROM shot_annotations WHERE id = ? AND media_id = ?')
    .get('annotation-a', 'a').data_json, '{"text":"原标注"}');
  assert.deepEqual(database.prepare("SELECT * FROM media_wall_migration_notices WHERE project_id = 'p'").get(), {
    project_id: 'p', cross_media_edges: 1, cross_media_groups: 1, source: 'backup',
  });
  const key = database.pragma('table_info(shot_layout)').filter((column) => column.pk)
    .sort((a, b) => a.pk - b.pk).map((column) => column.name);
  assert.deepEqual(key, ['project_id', 'media_id', 'shot_id']);
  assert.deepEqual(database.pragma('foreign_key_check'), []);
  assert.equal(database.pragma('integrity_check', { simple: true }), 'ok');
  migrateTo(15);
  assert.deepEqual(counts(), after);
  console.log(JSON.stringify({ passed: true, before, after, key, crossMediaEdges: 1, crossMediaGroups: 1, foreignKeyErrors: 0 }, null, 2));
} finally {
  database.close();
}
