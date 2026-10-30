import { z } from 'zod';

/**
 * preload 边界的载荷校验（docs/S01 §6.1）。
 * 非法载荷在 preload 侧直接拒绝，不进入主进程。
 */

export const emptyArgsSchema = z.tuple([]);

/** app:info 入参 schema */
export const appInfoArgsSchema = emptyArgsSchema;

const settingsDirectorySchema = z.string().trim().min(1).max(2000);

export const settingsSchema = z.object({
  dataRoot: settingsDirectorySchema,
  cacheDir: settingsDirectorySchema,
  exportDir: settingsDirectorySchema,
  stillDir: settingsDirectorySchema,
  proxyCacheDir: settingsDirectorySchema.optional(),
  frameCacheDir: settingsDirectorySchema.optional(),
  waveformCacheDir: settingsDirectorySchema.optional(),
  thumbCacheDir: settingsDirectorySchema.optional(),
  exportSubDir: settingsDirectorySchema.optional(),
  stillSubDir: settingsDirectorySchema.optional(),
  proxyTier: z.enum(['360p', '540p', '720p']).optional(),
});

export const settingsSetArgsSchema = settingsSchema;

export const settingsChooseDirectoryArgsSchema = z.object({
  title: z.string().trim().min(1).max(100).optional(),
  defaultPath: z.string().trim().min(1).max(2000).optional(),
});

const aiTaskIdSchema = z.enum([
  'continuity',
  'notes',
  'export-summary',
  'terminology',
  'visual-description',
]);

export const aiCopyPromptArgsSchema = z.object({
  projectId: z.string().min(1),
  tasks: z.array(aiTaskIdSchema).max(5),
});

export const aiProjectArgsSchema = z.object({
  projectId: z.string().min(1),
});

export const aiMcpSetEnabledArgsSchema = z.object({
  enabled: z.boolean(),
});

export const aiMcpAuthResponseSchema = z.object({
  requestId: z.string().min(1),
  allowed: z.boolean(),
  remember: z.boolean(),
});

export const settingsMigrationConfirmArgsSchema = z.object({
  projectIds: z.array(z.string().trim().min(1).max(200)).min(1).max(1000),
});

export const dataScanCandidatesArgsSchema = z.object({});

export const dataImportProjectArgsSchema = z.object({
  root: z.string().min(1).max(4000),
  projectId: z.string().min(1).max(200),
});

export const workspaceStateSchema = z.object({
  projectId: z.string().min(1).nullable(),
  timeMs: z.number().finite().min(0),
  selectedShotId: z.string().min(1).nullable(),
  leftCollapsed: z.boolean(),
  rightCollapsed: z.boolean(),
  volume: z.number().finite().min(0).max(1),
  shotScrollTop: z.number().finite().min(0).optional(),
});

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

/** player:setLayer */
export const playerSetLayerArgsSchema = z.object({
  level: z.enum(['normal', 'bottom', 'hidden']),
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
  hwaccel: z.enum(['auto', 'cuda', 'd3d11va', 'none']).optional(),
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
  encoder: z.string().min(1).max(32).optional(),
  proxyMode: z.enum(['fast', 'balanced', 'quality']).optional(),
  proxyResolution: z.enum(['auto', 'p240', 'p360', 'p540', 'p720', 'p1080']).optional(),
  tier: z.enum(['360p', '540p', '720p']).optional(),
  timeoutMs: z.number().int().positive().max(6 * 3_600_000).optional(),
});

export const mediaSetConcurrencyArgsSchema = z.object({
  concurrency: z.union([z.literal(1), z.literal(2)]),
});

/** media:cancelJob */
export const mediaCancelJobArgsSchema = z.object({
  jobId: z.string().min(1),
});

export const scopeExtractAudioWaveformArgsSchema = z.object({
  path: z.string().min(1),
  proxyPath: z.string().min(1).optional(),
  bucketMs: z.number().int().min(20).max(5000).optional(),
});

const detectWeightsSchema = z.object({
  s: z.number().min(0).max(1),
  c: z.number().min(0).max(1),
  h: z.number().min(0).max(1),
});

export const detectOptionsSchema = z
  .object({
    sensitivity: z.number().min(0).max(1),
    minShotSeconds: z.number().positive().max(600),
    filterTransitions: z.boolean(),
    weights: detectWeightsSchema,
    frameInterval: z.number().int().min(1).max(10_000).optional(),
    intervalMs: z.number().int().min(50).max(3_600_000).optional(),
  })
  .refine((value) => value.weights.s + value.weights.c + value.weights.h > 0, {
    message: 'weights 之和必须大于 0',
    path: ['weights'],
  });

export const detectRunArgsSchema = z.object({
  projectId: z.string().min(1),
  options: detectOptionsSchema,
  dryRun: z.boolean().optional(),
});

export const detectCheckEnvArgsSchema = z.object({});

export const detectCancelArgsSchema = z.object({
  jobId: z.string().min(1),
});

export const detectGetJobArgsSchema = z.object({
  jobId: z.string().min(1),
});

export const detectApplyArgsSchema = z.object({
  projectId: z.string().min(1),
  shotIds: z.array(z.string().min(1)).min(1).max(100_000),
  sceneIds: z.array(z.string().min(1)).max(10_000).optional(),
});

/* ---------- data 域（S01 §7） ---------- */

const nullableText = (max = 20000) => z.string().max(max).nullable().optional();

export const projectCreateArgsSchema = z.object({
  name: z.string().min(1).max(200),
  source: z
    .object({
      type: z.enum(['local', 'url']).optional(),
      path: z.string().nullable().optional(),
      url: z.string().nullable().optional(),
      platform: z.string().nullable().optional(),
    })
    .optional(),
  media: z
    .object({
      filename: z.string().nullable().optional(),
      container: z.string().nullable().optional(),
      durationMs: z.number().finite().min(0).optional(),
      width: z.number().int().min(0).nullable().optional(),
      height: z.number().int().min(0).nullable().optional(),
      fps: z.number().finite().min(0).nullable().optional(),
      videoCodec: z.string().nullable().optional(),
      audioCodec: z.string().nullable().optional(),
      sizeBytes: z.number().int().min(0).nullable().optional(),
      proxyPath: z.string().nullable().optional(),
    })
    .optional(),
  detectOptions: z
    .object({
      sensitivity: z.number().min(0).max(1).optional(),
      minShotSeconds: z.number().min(0).optional(),
      filterTransitions: z.boolean().optional(),
      weights: z.object({ s: z.number(), c: z.number(), h: z.number() }).optional(),
      frameInterval: z.number().int().min(1).optional(),
    })
    .optional(),
});

export const idArgsSchema = z.object({ id: z.string().min(1) });

export const projectUpdateArgsSchema = z.object({
  id: z.string().min(1),
  patch: z.object({
    name: z.string().min(1).max(200).optional(),
    source: z
      .object({
        type: z.enum(['local', 'url']).optional(),
        path: z.string().nullable().optional(),
        url: z.string().nullable().optional(),
        platform: z.string().nullable().optional(),
      })
      .optional(),
    media: z
      .object({
        filename: z.string().nullable().optional(),
        container: z.string().nullable().optional(),
        durationMs: z.number().finite().min(0).optional(),
        width: z.number().int().min(0).nullable().optional(),
        height: z.number().int().min(0).nullable().optional(),
        fps: z.number().finite().min(0).nullable().optional(),
        videoCodec: z.string().nullable().optional(),
        audioCodec: z.string().nullable().optional(),
        sizeBytes: z.number().int().min(0).nullable().optional(),
        proxyPath: z.string().nullable().optional(),
      })
      .optional(),
    detectOptions: z
      .object({
        sensitivity: z.number().min(0).max(1).optional(),
        minShotSeconds: z.number().min(0).optional(),
        filterTransitions: z.boolean().optional(),
        weights: z.object({ s: z.number(), c: z.number(), h: z.number() }).optional(),
        frameInterval: z.number().int().min(1).optional(),
      })
      .optional(),
  }),
});

export const projectSaveArgsSchema = z.object({
  id: z.string().min(1),
  targetPath: z.string().min(1).optional(),
  includeAssets: z.boolean().optional(),
  includeMedia: z.boolean().optional(),
});

export const projectSaveAsArgsSchema = z.object({
  id: z.string().min(1),
  targetPath: z.string().min(1),
});

export const projectOpenArgsSchema = z.object({ path: z.string().min(1) });

export const shotCreateArgsSchema = z.object({
  projectId: z.string().min(1),
  startMs: z.number().int().min(0),
  endMs: z.number().int().min(0),
  index: z.number().int().min(0).optional(),
  shotSize: nullableText(200),
  cameraMethod: nullableText(200),
  dialogue: nullableText(20000),
  remark: nullableText(20000),
});

export const shotUpdateArgsSchema = z.object({
  id: z.string().min(1),
  patch: z.object({
    index: z.number().int().min(0).optional(),
    startMs: z.number().int().min(0).optional(),
    endMs: z.number().int().min(0).optional(),
    shotSize: nullableText(200),
    cameraMethod: nullableText(200),
    dialogue: nullableText(20000),
    remark: nullableText(20000),
  }),
});

export const stillCreateArgsSchema = z.object({
  projectId: z.string().min(1),
  shotId: z.string().min(1).nullable().optional(),
  timeMs: z.number().int().min(0),
  filePath: z.string().min(1),
  thumbPath: z.string().min(1).nullable().optional(),
  width: z.number().int().min(0).nullable().optional(),
  height: z.number().int().min(0).nullable().optional(),
  caption: nullableText(2000),
  role: z.enum(['main', 'auto-thumb']).optional(),
  annotations: z.array(z.record(z.string(), z.unknown())).max(500).optional(),
});

export const stillCaptureArgsSchema = z.object({
  projectId: z.string().min(1),
  timeMs: z.number().int().min(0),
  shotId: z.string().min(1).nullable().optional(),
  caption: nullableText(2000),
});

export const stillCaptureAtArgsSchema = z.object({
  shotId: z.string().min(1),
  caption: nullableText(2000),
});

export const stillSetAnnotationArgsSchema = z.object({
  id: z.string().min(1),
  annotations: z.array(z.record(z.string(), z.unknown())).max(500),
});

export const stillUpdateArgsSchema = z.object({
  id: z.string().min(1),
  patch: z.object({
    shotId: z.string().min(1).nullable().optional(),
    timeMs: z.number().int().min(0).optional(),
    filePath: z.string().min(1).optional(),
    thumbPath: z.string().min(1).nullable().optional(),
    width: z.number().int().min(0).nullable().optional(),
    height: z.number().int().min(0).nullable().optional(),
    caption: nullableText(2000),
    role: z.enum(['main', 'auto-thumb']).optional(),
    annotations: z.array(z.record(z.string(), z.unknown())).max(500).optional(),
  }),
});

export const stillListArgsSchema = z
  .object({
    projectId: z.string().min(1).optional(),
    shotId: z.string().min(1).optional(),
  })
  .refine((value) => Boolean(value.projectId || value.shotId), {
    message: 'projectId 和 shotId 至少提供一个',
  });

export const tagListArgsSchema = z.object({ category: z.string().min(1).optional() });

export const tagCreateArgsSchema = z.object({
  category: z.string().min(1).max(50),
  name: z.string().min(1).max(100),
  color: z.string().max(32).nullable().optional(),
  builtin: z.boolean().optional(),
  sortOrder: z.number().int().optional(),
});

export const tagUpdateArgsSchema = z.object({
  id: z.string().min(1),
  patch: z.object({
    category: z.string().min(1).max(50).optional(),
    name: z.string().min(1).max(100).optional(),
    color: z.string().max(32).nullable().optional(),
    sortOrder: z.number().int().optional(),
  }),
});

export const tagAssignArgsSchema = z.object({
  shotId: z.string().min(1),
  tagIds: z.array(z.string().min(1)).max(200),
});

export const noteListArgsSchema = z
  .object({
    projectId: z.string().min(1).optional(),
    shotId: z.string().min(1).optional(),
  })
  .refine((value) => Boolean(value.projectId || value.shotId), {
    message: 'projectId 和 shotId 至少提供一个',
  });

export const noteUpsertArgsSchema = z.object({
  id: z.string().min(1).optional(),
  projectId: z.string().min(1),
  shotId: z.string().min(1),
  text: z.string().max(20000),
});

export const termListArgsSchema = z.object({ category: z.string().min(1).optional() });

export const termCreateArgsSchema = z.object({
  category: z.string().max(50).optional(),
  term: z.string().min(1).max(200),
  definition: z.string().max(20000),
  builtin: z.boolean().optional(),
  sortOrder: z.number().int().optional(),
});

export const termUpdateArgsSchema = z.object({
  id: z.string().min(1),
  patch: z.object({
    category: z.string().max(50).optional(),
    term: z.string().min(1).max(200).optional(),
    definition: z.string().max(20000).optional(),
    sortOrder: z.number().int().optional(),
  }),
});

const storyboardColumnKeySchema = z.enum([
  'index',
  'duration',
  'thumbnail',
  'shotSize',
  'cameraMethod',
  'image',
  'dialogue',
  'remark',
]);

export const storyboardExportArgsSchema = z.object({
  projectId: z.string().min(1),
  format: z.enum(['pdf', 'docx']),
  range: z
    .object({
      shotIds: z.array(z.string().min(1)).max(100_000).optional(),
    })
    .optional(),
  headers: z
    .array(
      z.object({
        key: storyboardColumnKeySchema,
        label: z.string().min(1).max(80),
      }),
    )
    .max(8)
    .optional(),
  imageStrategy: z.enum(['both', 'thumbnail', 'full']).optional(),
  includeTags: z.boolean().optional(),
});

export const statsProjectArgsSchema = z.object({
  projectId: z.string().min(1),
});

export const emptyObjectSchema = z.object({}).optional();
