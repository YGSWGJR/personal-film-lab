/**
 * IPC 通道名唯一来源（docs/S01 §6.2）。
 * 新增通道：先改本文件 + S01 §6，再在 src/main/ipc 注册、src/preload 暴露。
 */
export const IPC = {
  /** app 域：返回版本 / 平台 / 用户数据目录（I 方向） */
  APP_INFO: 'app:info',

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
} as const;

export type IpcChannel = (typeof IPC)[keyof typeof IPC];