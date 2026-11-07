import initSql from './001_init.sql?raw';
import presetTagsSql from './002_preset_tags.sql?raw';
import detectSql from './003_detect.sql?raw';
import shotThumbnailSql from './004_shot_thumbnail.sql?raw';
import manualFieldsSql from './005_manual_fields.sql?raw';
import shotLayoutSql from './006_shot_layout.sql?raw';
import shotEdgesSql from './007_shot_edges.sql?raw';
import shotGroupsSql from './008_shot_groups.sql?raw';
import shotAnnotationsSql from './009_shot_annotations.sql?raw';
import wallBoardsSql from './010_wall_boards.sql?raw';

export interface Migration {
  version: number;
  sql: string;
}

/** 迁移按 version 递增执行；新增迁移时追加数组元素并补 src/data/migrations/00X_*.sql */
export const MIGRATIONS: Migration[] = [
  { version: 1, sql: initSql },
  { version: 2, sql: presetTagsSql },
  { version: 3, sql: detectSql },
  { version: 4, sql: shotThumbnailSql },
  { version: 5, sql: manualFieldsSql },
  { version: 6, sql: shotLayoutSql },
  { version: 7, sql: shotEdgesSql },
  { version: 8, sql: shotGroupsSql },
  { version: 9, sql: shotAnnotationsSql },
  { version: 10, sql: wallBoardsSql },
];
