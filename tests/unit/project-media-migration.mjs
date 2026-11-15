import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';

const migrationDir = new URL('../../src/data/migrations/', import.meta.url);
const migrationFiles = readdirSync(migrationDir)
  .filter((name) => /^\d{3}_.*\.sql$/u.test(name))
  .sort();

function applyMigrations(db, maxVersion) {
  const currentVersion = Number(db.pragma('user_version', { simple: true }));
  for (const file of migrationFiles) {
    const version = Number(file.slice(0, 3));
    if (version > maxVersion || version <= currentVersion) continue;
    db.exec(readFileSync(new URL(file, migrationDir), 'utf8'));
    db.pragma(`user_version = ${version}`);
  }
}

function count(db, table, projectId) {
  return Number(
    db.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE project_id = ?`).get(projectId)
      .count,
  );
}

const workDir = mkdtempSync(join(tmpdir(), 'pfl-project-media-test-'));
const databasePath = join(workDir, 'lapian.db');
const projectId = 'legacy-project';
let db;

try {
  db = new Database(databasePath);
  db.pragma('foreign_keys = ON');
  applyMigrations(db, 12);

  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO projects (
      id, name, source_type, source_path, media_filename, media_duration_ms,
      detect_options_json, created_at, updated_at
    ) VALUES (?, ?, 'local', ?, ?, ?, '{}', ?, ?)`,
  ).run(projectId, 'Legacy', 'C:\\media\\legacy.mp4', 'legacy.mp4', 120000, now, now);
  db.prepare(
    `INSERT INTO shots (
      id, project_id, shot_index, start_ms, end_ms, duration_ms, origin, locked, created_at, updated_at
    ) VALUES ('shot-1', ?, 1, 0, 5000, 5000, 'manual', 0, ?, ?)`,
  ).run(projectId, now, now);
  db.prepare(
    `INSERT INTO scenes (
      id, project_id, scene_index, label, start_ms, end_ms, created_at, updated_at
    ) VALUES ('scene-1', ?, 1, 'Scene', 0, 5000, ?, ?)`,
  ).run(projectId, now, now);
  db.prepare(
    `INSERT INTO stills (
      id, project_id, shot_id, time_ms, file_path, role, annotations_json, created_at, updated_at
    ) VALUES ('still-1', ?, 'shot-1', 2500, 'stills/frame.png', 'main', '[]', ?, ?)`,
  ).run(projectId, now, now);

  assert.equal(count(db, 'shots', projectId), 1);
  assert.equal(count(db, 'scenes', projectId), 1);
  assert.equal(count(db, 'stills', projectId), 1);

  applyMigrations(db, 13);
  assert.equal(Number(db.pragma('user_version', { simple: true })), 13);
  assert.equal(count(db, 'shots', projectId), 1);
  assert.equal(count(db, 'scenes', projectId), 1);
  assert.equal(count(db, 'stills', projectId), 1);
  assert.equal(count(db, 'project_media', projectId), 1);

  const active = db
    .prepare('SELECT active_media_id FROM projects WHERE id = ?')
    .get(projectId).active_media_id;
  assert.equal(active, `legacy-media-${projectId}`);
  for (const table of ['shots', 'scenes', 'stills']) {
    const rows = db
      .prepare(`SELECT media_id FROM ${table} WHERE project_id = ?`)
      .all(projectId);
    assert.ok(rows.every((row) => row.media_id === active), `${table} media backfill`);
  }

  db.prepare(
    `INSERT INTO project_media (
      id, project_id, media_index, source_type, source_path, media_filename,
      media_duration_ms, detect_options_json, detect_state_json, created_at, updated_at
    ) VALUES ('media-2', ?, 2, 'local', 'C:\\media\\second.mp4', 'second.mp4',
      90000, '{}', '{}', ?, ?)`,
  ).run(projectId, now, now);
  db.prepare(
    `INSERT INTO shots (
      id, project_id, media_id, shot_index, start_ms, end_ms, duration_ms,
      origin, locked, created_at, updated_at
    ) VALUES ('shot-2', ?, 'media-2', 1, 0, 3000, 3000, 'manual', 0, ?, ?)`,
  ).run(projectId, now, now);

  assert.equal(
    db.prepare("SELECT COUNT(*) AS count FROM shots WHERE media_id = ?").get(active).count,
    1,
  );
  assert.equal(
    db.prepare("SELECT COUNT(*) AS count FROM shots WHERE media_id = 'media-2'").get().count,
    1,
  );

  console.log(
    JSON.stringify({
      passed: true,
      schemaVersion: 13,
      legacyCounts: { shots: 1, scenes: 1, stills: 1 },
      mediaIsolation: { media1Shots: 1, media2Shots: 1 },
    }),
  );
} finally {
  db?.close();
  rmSync(workDir, { recursive: true, force: true });
}
