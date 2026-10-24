import type { DataLayer } from '../../data/db';
import { DataError } from '../../data/errors';
import type {
  StatsProgress,
  StatsRhythmPoint,
  StatsTagDistributionItem,
} from '../../shared/types';

interface TagDistributionRow {
  category: StatsTagDistributionItem['category'];
  name: string;
  count: number;
}

interface RhythmRow {
  id: string;
  shot_index: number;
  start_ms: number;
  end_ms: number;
}

interface ProgressRow {
  total: number;
  annotated: number;
}

export class StatsError extends Error {
  readonly code: string;
  readonly details?: Record<string, unknown>;

  constructor(code: string, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = 'StatsError';
    this.code = code;
    this.details = details;
  }
}

export class StatsService {
  constructor(private readonly data: DataLayer) {}

  tagDistribution(projectId: string): StatsTagDistributionItem[] {
    this.assertProject(projectId);
    const rows = this.data.db
      .prepare(
        `SELECT t.category, t.name, COUNT(DISTINCT s.id) AS count
         FROM tags t
         LEFT JOIN shot_tags st ON st.tag_id = t.id
         LEFT JOIN shots s ON s.id = st.shot_id AND s.project_id = ?
         WHERE t.category IN ('景别', '机位', '运镜')
         GROUP BY t.id, t.category, t.name, t.sort_order
         ORDER BY CASE t.category
           WHEN '景别' THEN 1
           WHEN '机位' THEN 2
           WHEN '运镜' THEN 3
           ELSE 4
         END, t.sort_order ASC, t.name ASC`,
      )
      .all(projectId) as TagDistributionRow[];
    return rows.map((row) => ({
      category: row.category,
      name: row.name,
      count: Number(row.count),
    }));
  }

  rhythm(projectId: string): StatsRhythmPoint[] {
    this.assertProject(projectId);
    const rows = this.data.db
      .prepare(
        `SELECT id, shot_index, start_ms, end_ms
         FROM shots
         WHERE project_id = ?
         ORDER BY start_ms ASC, shot_index ASC`,
      )
      .all(projectId) as RhythmRow[];
    return rows.map((row) => {
      const durationMs = Math.max(0, row.end_ms - row.start_ms);
      return {
        shotId: row.id,
        index: row.shot_index,
        startMs: row.start_ms,
        durationMs,
        durationSeconds: Math.round((durationMs / 1000) * 100) / 100,
      };
    });
  }

  progress(projectId: string): StatsProgress {
    this.assertProject(projectId);
    const row = this.data.db
      .prepare(
        `SELECT
           COUNT(*) AS total,
           COALESCE(SUM(
             CASE WHEN
               EXISTS (SELECT 1 FROM shot_tags st WHERE st.shot_id = s.id)
               OR EXISTS (SELECT 1 FROM notes n WHERE n.shot_id = s.id AND trim(n.text) <> '')
               OR EXISTS (SELECT 1 FROM stills st2 WHERE st2.shot_id = s.id AND st2.role = 'main')
             THEN 1 ELSE 0 END
           ), 0) AS annotated
         FROM shots s
         WHERE s.project_id = ?`,
      )
      .get(projectId) as ProgressRow;
    const totalShots = Number(row?.total ?? 0);
    const annotatedShots = Number(row?.annotated ?? 0);
    return {
      annotatedShots,
      totalShots,
      percent: totalShots > 0 ? Math.round((annotatedShots / totalShots) * 1000) / 10 : 0,
    };
  }

  private assertProject(projectId: string): void {
    if (!this.data.projects.exists(projectId)) {
      throw new DataError('PROJECT_NOT_FOUND', `项目不存在：${projectId}`, { projectId });
    }
  }
}
