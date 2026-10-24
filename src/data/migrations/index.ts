import initSql from './001_init.sql?raw';
import presetTagsSql from './002_preset_tags.sql?raw';

export interface Migration {
  version: number;
  sql: string;
}

/** 迁移按 version 递增执行；新增迁移时追加数组元素并补 src/data/migrations/00X_*.sql */
export const MIGRATIONS: Migration[] = [
  { version: 1, sql: initSql },
  { version: 2, sql: presetTagsSql },
];
