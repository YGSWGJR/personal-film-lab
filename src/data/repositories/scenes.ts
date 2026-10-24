import { randomUUID } from 'node:crypto';
import type { Scene } from '../../shared/types';
import type { DataLayer } from '../db';
import { DataError } from '../errors';
import { nowIso } from './projects';

interface SceneRow {
  id: string;
  project_id: string;
  scene_index: number;
  label: string | null;
  start_ms: number;
  end_ms: number;
  created_at: string;
  updated_at: string;
}

export class SceneRepository {
  constructor(private readonly layer: DataLayer) {}

  private get db() {
    return this.layer.db;
  }

  list(projectId: string): Scene[] {
    this.assertProject(projectId);
    const rows = this.db
      .prepare('SELECT * FROM scenes WHERE project_id = ? ORDER BY start_ms ASC, scene_index ASC')
      .all(projectId) as SceneRow[];
    return rows.map(mapScene);
  }

  replace(projectId: string, scenes: Scene[]): number {
    this.assertProject(projectId);
    const now = nowIso();
    this.layer.transaction(() => {
      this.db.prepare('DELETE FROM scenes WHERE project_id = ?').run(projectId);
      const insert = this.db.prepare(
        `INSERT INTO scenes (
          id, project_id, scene_index, label, start_ms, end_ms, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const scene of scenes) {
        insert.run(
          randomUUID(),
          projectId,
          scene.index,
          scene.label,
          scene.startMs,
          scene.endMs,
          scene.createdAt || now,
          now,
        );
      }
      this.layer.projects.touch(projectId);
    });
    return scenes.length;
  }

  private assertProject(projectId: string): void {
    if (!this.layer.projects.exists(projectId)) {
      throw new DataError('PROJECT_NOT_FOUND', `项目不存在：${projectId}`, { projectId });
    }
  }
}

function mapScene(row: SceneRow): Scene {
  return {
    id: row.id,
    projectId: row.project_id,
    index: row.scene_index,
    label: row.label,
    startMs: row.start_ms,
    endMs: row.end_ms,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
