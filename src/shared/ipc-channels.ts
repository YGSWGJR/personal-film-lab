/**
 * IPC 通道名唯一来源（docs/S01 §6.2）。
 * 新增通道：先改本文件 + S01 §6，再在 src/main/ipc 注册、src/preload 暴露。
 */
export const IPC = {
  /** app 域：返回版本 / 平台 / 用户数据目录（I 方向） */
  APP_INFO: 'app:info',

  /** settings 域 */
  SETTINGS_GET: 'settings:get',
  SETTINGS_SET: 'settings:set',
  SETTINGS_CHOOSE_DIRECTORY: 'settings:chooseDirectory',

  /** session 域：工作区会话恢复 */
  SESSION_GET: 'session:get',
  SESSION_SAVE: 'session:save',
  SESSION_CLEAR: 'session:clear',

  /** player 域（I 方向） */
  PLAYER_OPEN: 'player:open',
  PLAYER_OPEN_DIALOG: 'player:openDialog',
  PLAYER_CLOSE: 'player:close',
  PLAYER_PLAY: 'player:play',
  PLAYER_PAUSE: 'player:pause',
  PLAYER_TOGGLE: 'player:toggle',
  PLAYER_SEEK: 'player:seek',
  PLAYER_FRAME_STEP: 'player:frameStep',
  PLAYER_GET_STATE: 'player:getState',
  PLAYER_GET_FRAME: 'player:getFrame',
  PLAYER_SET_VOLUME: 'player:setVolume',
  PLAYER_SET_BOUNDS: 'player:setBounds',

  /** player 域（E 方向，主进程 → 渲染层） */
  PLAYER_EVENT_STATE: 'player:event:state',
  PLAYER_EVENT_TIME: 'player:event:time',
  PLAYER_EVENT_LOADED: 'player:event:loaded',
  PLAYER_EVENT_ERROR: 'player:event:error',

  /** media 域（I 方向，S01 §5.2） */
  MEDIA_PROBE: 'media:probe',
  MEDIA_EXTRACT_FRAME: 'media:extractFrame',
  MEDIA_EXTRACT_FRAMES: 'media:extractFrames',
  MEDIA_TRANSCODE_PROXY: 'media:transcodeProxy',
  MEDIA_CANCEL_JOB: 'media:cancelJob',

  /** media 域（E 方向） */
  MEDIA_EVENT_PROGRESS: 'media:event:progress',

  /** detect 域（S01 §5.4 / §8.2） */
  DETECT_RUN: 'detect:run',
  DETECT_CANCEL: 'detect:cancel',
  DETECT_GET_JOB: 'detect:getJob',
  DETECT_APPLY: 'detect:apply',
  DETECT_EVENT_PROGRESS: 'detect:event:progress',
  DETECT_EVENT_DONE: 'detect:event:done',

  /** scope 域（S21）：音频包络 */
  SCOPE_EXTRACT_AUDIO_WAVEFORM: 'scope:extractAudioWaveform',

  /** data 域：项目 / 镜头 / 静帧 / 标签 / 笔记 / 术语（I 方向，S01 §6.2） */
  PROJECT_CREATE: 'project:create',
  PROJECT_LIST: 'project:list',
  PROJECT_GET: 'project:get',
  PROJECT_UPDATE: 'project:update',
  PROJECT_DELETE: 'project:delete',
  PROJECT_OPEN: 'project:open',
  PROJECT_SAVE: 'project:save',
  PROJECT_SAVE_AS: 'project:saveAs',

  SHOT_LIST: 'shot:list',
  SHOT_GET: 'shot:get',
  SHOT_CREATE: 'shot:create',
  SHOT_UPDATE: 'shot:update',
  SHOT_DELETE: 'shot:delete',

  STILL_LIST: 'still:list',
  STILL_GET: 'still:get',
  STILL_CREATE: 'still:create',
  STILL_CAPTURE: 'still:capture',
  STILL_CAPTURE_AT: 'still:captureAt',
  STILL_UPDATE: 'still:update',
  STILL_SET_ANNOTATION: 'still:setAnnotation',
  STILL_DELETE: 'still:delete',
  STILL_EVENT_CREATED: 'still:event:created',

  TAG_LIST: 'tag:list',
  TAG_CREATE: 'tag:create',
  TAG_UPDATE: 'tag:update',
  TAG_DELETE: 'tag:delete',
  TAG_ASSIGN: 'tag:assign',
  TAG_UNASSIGN: 'tag:unassign',

  NOTE_LIST: 'note:list',
  NOTE_GET: 'note:get',
  NOTE_UPSERT: 'note:upsert',
  NOTE_DELETE: 'note:delete',

  TERM_LIST: 'term:list',
  TERM_CREATE: 'term:create',
  TERM_UPDATE: 'term:update',
  TERM_DELETE: 'term:delete',
  TERM_IMPORT_JSON: 'term:importJson',
  TERM_EXPORT_JSON: 'term:exportJson',

  EXPORT_STORYBOARD: 'export:storyboard',
  EXPORT_EVENT_PROGRESS: 'export:event:progress',
  EXPORT_EVENT_DONE: 'export:event:done',
} as const;

export type IpcChannel = (typeof IPC)[keyof typeof IPC];
