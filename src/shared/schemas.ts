import { z } from 'zod';

/**
 * preload 边界的载荷校验（docs/S01 §6.1）。
 * 阶段 0 仅有 app:info（无入参），先固定「不接受任何参数」的形状。
 */
export const emptyArgsSchema = z.tuple([]);

/** app:info 入参 schema */
export const appInfoArgsSchema = emptyArgsSchema;