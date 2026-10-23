import { z } from 'zod';

/**
 * preload 边界的载荷校验（docs/S01 §6.1）。
 * 非法载荷在 preload 侧直接拒绝，不进入主进程。
 */

export const emptyArgsSchema = z.tuple([]);

/** app:info 入参 schema */
export const appInfoArgsSchema = emptyArgsSchema;

/** player:open：mediaPath 与 projectId 至少给一个（项目能力阶段 2 之后再接） */
export const playerOpenArgsSchema = z
  .object({
    mediaPath: z.string().min(1).optional(),
    projectId: z.string().min(1).optional(),
  })
  .refine((value) => Boolean(value.mediaPath ?? value.projectId), {
    message: 'mediaPath 与 projectId 至少提供一个',
  });

/** player:seek */
export const playerSeekArgsSchema = z.object({
  timeMs: z.number().finite().min(0),
  exact: z.boolean().optional(),
});

/** player:frameStep */
export const playerFrameStepArgsSchema = z.object({
  dir: z.union([z.literal(1), z.literal(-1)]),
});

/** player:setVolume（0..1） */
export const playerSetVolumeArgsSchema = z.object({
  volume: z.number().min(0).max(1),
});

/** player:setBounds（CSS 像素，相对可视区域） */
export const playerSetBoundsArgsSchema = z.object({
  x: z.number().finite(),
  y: z.number().finite(),
  width: z.number().finite().min(0),
  height: z.number().finite().min(0),
});