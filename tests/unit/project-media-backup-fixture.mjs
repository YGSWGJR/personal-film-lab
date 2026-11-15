import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import Database from 'better-sqlite3';

const target = resolve(process.argv[2] ?? join(process.cwd(), 'work', 's42-v12-fixture'));
if (!target.startsWith(resolve(process.cwd()) + '\\')) {
  throw new Error(`Refusing fixture path outside workspace: ${target}`);
}

rmSync(target, { recursive: true, force: true });
mkdirSync(target, { recursive: true });

const migrationDir = new URL('../../src/data/migrations/', import.meta.url);
const files = readdirSync(migrationDir)
  .filter((name) => /^\d{3}_.*\.sql$/u.test(name))
  .sort();
const db = new Database(join(target, 'lapian.db'));
db.pragma('foreign_keys = ON');

try {
  for (const file of files) {
    const version = Number(file.slice(0, 3));
    if (version > 12) break;
    db.exec(readFileSync(new URL(file, migrationDir), 'utf8'));
    db.pragma(`user_version = ${version}`);
  }

  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO projects (
      id, name, source_type, source_path, media_filename, media_duration_ms,
      detect_options_json, created_at, updated_at
    ) VALUES ('v12-project', 'v0.4 migration fixture', 'local',
      'C:\\fixture\\legacy.mp4', 'legacy.mp4', 60000, '{}', ?, ?)`,
  ).run(now, now);
  db.prepare(
    `INSERT INTO shots (
      id, project_id, shot_index, start_ms, end_ms, duration_ms,
      origin, locked, created_at, updated_at
    ) VALUES ('v12-shot', 'v12-project', 1, 0, 5000, 5000,
      'manual', 0, ?, ?)`,
  ).run(now, now);
  db.prepare(
    `INSERT INTO scenes (
      id, project_id, scene_index, label, start_ms, end_ms, created_at, updated_at
    ) VALUES ('v12-scene', 'v12-project', 1, 'Fixture', 0, 5000, ?, ?)`,
  ).run(now, now);
  db.prepare(
    `INSERT INTO stills (
      id, project_id, shot_id, time_ms, file_path, role, annotations_json,
      created_at, updated_at
    ) VALUES ('v12-still', 'v12-project', 'v12-shot', 2500,
      'stills/fixture.png', 'main', '[]', ?, ?)`,
  ).run(now, now);
  assert.equal(Number(db.pragma('user_version', { simple: true })), 12);
  console.log(
    JSON.stringify({
      created: true,
      target,
      schemaVersion: 12,
      counts: { projects: 1, shots: 1, scenes: 1, stills: 1 },
    }),
  );
} finally {
  db.close();
}
