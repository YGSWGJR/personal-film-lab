import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { app } from 'electron';
import koffi from 'koffi';

/**
 * libmpv 动态库加载与 FFI 声明（Windows）。
 *
 * DLL 实际文件名是 libmpv-2.dll（官方 dev 包命名，S01 §5.1 旧文写的 mpv-2.dll 已更正），
 * 该 dev 包为静态链接单文件，无需额外运行时库。
 */

export const MPV_FORMAT = {
  NONE: 0,
  STRING: 1,
  FLAG: 3,
  INT64: 4,
  DOUBLE: 5,
} as const;

export const MPV_EVENT = {
  NONE: 0,
  SHUTDOWN: 1,
  LOG_MESSAGE: 2,
  START_FILE: 6,
  END_FILE: 7,
  FILE_LOADED: 8,
  VIDEO_RECONFIG: 17,
  PLAYBACK_RESTART: 21,
  PROPERTY_CHANGE: 22,
} as const;

export const MPV_END_FILE_REASON = {
  EOF: 0,
  STOP: 2,
  QUIT: 3,
  ERROR: 4,
} as const;

export interface MpvErrorLike {
  code: string;
  message: string;
}

/** 播放器领域错误：code 会原样透传给渲染层 */
export class PlayerError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'PlayerError';
  }
}

const MPV_ERROR_CODES: Record<number, { code: string; message: string }> = {
  [-1]: { code: 'MPV_EVENT_QUEUE_FULL', message: 'mpv 事件队列已满' },
  [-2]: { code: 'MPV_OUT_OF_MEMORY', message: '内存分配失败' },
  [-3]: { code: 'MPV_UNINITIALIZED', message: 'mpv 尚未初始化' },
  [-4]: { code: 'MPV_INVALID_PARAMETER', message: '参数无效' },
  [-5]: { code: 'MPV_OPTION_NOT_FOUND', message: 'mpv 选项不存在' },
  [-7]: { code: 'MPV_OPTION_ERROR', message: 'mpv 选项值解析失败' },
  [-8]: { code: 'MPV_PROPERTY_NOT_FOUND', message: 'mpv 属性不存在' },
  [-9]: { code: 'MPV_PROPERTY_FORMAT', message: 'mpv 属性格式不匹配' },
  [-10]: { code: 'MPV_PROPERTY_UNAVAILABLE', message: 'mpv 属性当前不可用' },
  [-12]: { code: 'MPV_COMMAND_FAILED', message: 'mpv 命令执行失败' },
  [-13]: { code: 'FILE_LOAD_FAILED', message: '文件加载失败（可能是文件损坏或编码不受支持）' },
  [-14]: { code: 'AUDIO_OUTPUT_FAILED', message: '音频输出初始化失败' },
  [-15]: { code: 'VIDEO_OUTPUT_FAILED', message: '视频输出初始化失败（D3D11 渲染不可用）' },
  [-16]: { code: 'UNSUPPORTED_FORMAT', message: '没有可播放的音视频轨道（格式不支持）' },
  [-17]: { code: 'UNSUPPORTED_FORMAT', message: '无法识别的媒体格式' },
  [-18]: { code: 'UNSUPPORTED_FORMAT', message: '不支持的媒体特性' },
  [-19]: { code: 'MPV_NOT_IMPLEMENTED', message: 'mpv 未实现该操作' },
  [-20]: { code: 'MPV_ERROR', message: 'mpv 内部错误' },
};

export function toPlayerError(rc: number, fallbackMessage = 'libmpv 调用失败'): PlayerError {
  const known = MPV_ERROR_CODES[rc];
  return new PlayerError(known?.code ?? 'MPV_ERROR', known?.message ?? `${fallbackMessage}（错误码 ${rc}）`);
}

/** 解析 libmpv-2.dll 路径：开发期取仓库 resources/mpv，打包后取 resources/mpv（extraResources） */
export function resolveMpvDllPath(): string {
  const candidates = app.isPackaged
    ? [join(process.resourcesPath, 'mpv', 'libmpv-2.dll')]
    : [
        join(app.getAppPath(), 'resources', 'mpv', 'libmpv-2.dll'),
        join(process.cwd(), 'resources', 'mpv', 'libmpv-2.dll'),
      ];

  const found = candidates.find((candidate) => existsSync(candidate));
  if (!found) {
    throw new PlayerError(
      'MPV_DLL_NOT_FOUND',
      `未找到 libmpv-2.dll，已查找：${candidates.join(' | ')}`,
    );
  }
  return found;
}

interface MpvBindings {
  create(): unknown;
  initialize(ctx: unknown): number;
  terminateDestroy(ctx: unknown): void;
  setOptionString(ctx: unknown, name: string, value: string): number;
  setPropertyString(ctx: unknown, name: string, value: string): number;
  getProperty(ctx: unknown, name: string, format: number, data: Buffer): number;
  getPropertyString(ctx: unknown, name: string): unknown;
  observeProperty(ctx: unknown, id: bigint, name: string, format: number): number;
  commandString(ctx: unknown, args: string): number;
  requestLogMessages(ctx: unknown, minLevel: string): number;
  waitEvent(ctx: unknown, timeoutSeconds: number): unknown;
  errorString(code: number): unknown;
  free(pointer: unknown): void;
  clientApiVersion(): number;
}

export interface MpvStructs {
  event: any;
  eventProperty: any;
  eventEndFile: any;
  eventLogMessage: any;
}

export interface MpvLibrary {
  readonly dllPath: string;
  readonly fns: MpvBindings;
  readonly structs: MpvStructs;
  readonly koffi: typeof koffi;
}

let cached: MpvLibrary | null = null;

export function getMpvLibrary(): MpvLibrary {
  if (cached) return cached;

  const dllPath = resolveMpvDllPath();
  const lib = koffi.load(dllPath);

  const fns: MpvBindings = {
    create: lib.func('void *mpv_create()'),
    initialize: lib.func('int mpv_initialize(void *ctx)'),
    terminateDestroy: lib.func('void mpv_terminate_destroy(void *ctx)'),
    setOptionString: lib.func('int mpv_set_option_string(void *ctx, const char *name, const char *value)'),
    setPropertyString: lib.func('int mpv_set_property_string(void *ctx, const char *name, const char *value)'),
    getProperty: lib.func('int mpv_get_property(void *ctx, const char *name, int format, void *data)'),
    getPropertyString: lib.func('void *mpv_get_property_string(void *ctx, const char *name)'),
    observeProperty: lib.func('int mpv_observe_property(void *ctx, uint64_t reply_userdata, const char *name, int format)'),
    commandString: lib.func('int mpv_command_string(void *ctx, const char *args)'),
    requestLogMessages: lib.func('int mpv_request_log_messages(void *ctx, const char *min_level)'),
    waitEvent: lib.func('void *mpv_wait_event(void *ctx, double timeout)'),
    errorString: lib.func('const char *mpv_error_string(int error)'),
    free: lib.func('void mpv_free(void *data)'),
    clientApiVersion: lib.func('unsigned long mpv_client_api_version()'),
  };

  const structs: MpvStructs = {
    event: koffi.struct('MpvEvent', {
      event_id: 'int',
      error: 'int',
      reply_userdata: 'uint64',
      data: 'void *',
    }),
    eventProperty: koffi.struct('MpvEventProperty', {
      name: 'str',
      format: 'int',
      data: 'void *',
    }),
    eventEndFile: koffi.struct('MpvEventEndFile', {
      reason: 'int',
      error: 'int',
      playlist_entry_id: 'int64',
      playlist_insert_id: 'int64',
      playlist_insert_num_entries: 'int',
    }),
    eventLogMessage: koffi.struct('MpvEventLogMessage', {
      prefix: 'str',
      level: 'str',
      text: 'str',
      log_level: 'int',
    }),
  };

  cached = { dllPath, fns, structs, koffi };
  return cached;
}