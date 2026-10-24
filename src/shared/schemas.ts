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
/** media:probe */
export const mediaProbeArgsSchema = z.object({
  path: z.string().min(1),
  timeoutMs: z.number().int().positive().max(600_000).optional(),
});

/** media:extractFrame */
export const mediaExtractFrameArgsSchema = z.object({
  path: z.string().min(1),
  timeMs: z.number().finite().min(0),
  outputPath: z.string().min(1).optional(),
  format: z.enum(['jpg', 'jpeg', 'png']).optional(),
  quality: z.number().int().min(1).max(31).optional(),
  timeoutMs: z.number().int().positive().max(600_000).optional(),
});

/** media:extractFrames */
export const mediaExtractFramesArgsSchema = z.object({
  path: z.string().min(1),
  outputDir: z.string().min(1),
  intervalMs: z.number().int().min(50).max(3_600_000),
  startMs: z.number().finite().min(0).optional(),
  endMs: z.number().finite().min(0).optional(),
  format: z.enum(['jpg', 'jpeg', 'png']).optional(),
  prefix: z.string().min(1).max(80).optional(),
  quality: z.number().int().min(1).max(31).optional(),
  maxFrames: z.number().int().min(1).max(20_000).optional(),
  timeoutMs: z.number().int().positive().max(4 * 3_600_000).optional(),
});

/** media:transcodeProxy */
export const mediaTranscodeProxyArgsSchema = z.object({
  sourcePath: z.string().min(1),
  outputPath: z.string().min(1).optional(),
  maxHeight: z.number().int().min(120).max(4320).optional(),
  crf: z.number().int().min(1).max(51).optional(),
  preset: z.string().min(1).max(20).optional(),
  timeoutMs: z.number().int().positive().max(6 * 3_600_000).optional(),
});

/** media:cancelJob */
export const mediaCancelJobArgsSchema = z.object({
  jobId: z.string().min(1),
});