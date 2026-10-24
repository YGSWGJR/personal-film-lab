import { screen, type BrowserWindow } from 'electron';
import koffi from 'koffi';
import { PlayerError } from './mpv-lib';
import type { OverlayLayer, RenderBounds } from '../../shared/types';

/**
 * 原生子窗口（Win32 child HWND）：
 * libmpv 通过 wid 把 D3D11 画面渲染到这个子窗口，从而只覆盖渲染层指定的区域。
 *
 * 注意：Chromium 的 DirectComposition 内容会盖住原生子窗口，
 * 因此主进程启动时必须关闭 DirectComposition（见 src/main/index.ts）。
 */

const user32 = koffi.load('user32.dll');

const CreateWindowExA = user32.func(
  'uint64 CreateWindowExA(uint32 exStyle, const char *className, const char *windowName, uint32 style, int x, int y, int w, int h, uint64 parent, uint64 menu, uint64 instance, void *param)',
);
const DestroyWindow = user32.func('int DestroyWindow(uint64 hwnd)');
const ShowWindow = user32.func('int ShowWindow(uint64 hwnd, int cmd)');
const GetWindowRect = user32.func('int GetWindowRect(uint64 hwnd, void *rect)');
const SetWindowPos = user32.func(
  'int SetWindowPos(uint64 hwnd, uint64 insertAfter, int x, int y, int cx, int cy, uint32 flags)',
);

const WS_CHILD = 0x40000000;
const WS_VISIBLE = 0x10000000;
const WS_CLIPCHILDREN = 0x02000000;
const WS_CLIPSIBLINGS = 0x04000000;
const WS_EX_NOACTIVATE = 0x08000000;

const SW_SHOW = 5;
const SW_HIDE = 0;
const HWND_TOP = 0n;
const HWND_BOTTOM = 1n;
const SWP_NOSIZE = 0x0001;
const SWP_NOMOVE = 0x0002;
const SWP_NOZORDER = 0x0004;
const SWP_NOACTIVATE = 0x0010;

export interface PhysicalRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** 读取 BrowserWindow 顶层 HWND */
export function windowHandleOf(win: BrowserWindow): bigint {
  const handle = win.getNativeWindowHandle();
  return handle.length === 8 ? handle.readBigUInt64LE(0) : BigInt(handle.readUInt32LE(0));
}

/** 计算渲染层 CSS 矩形对应的物理像素矩形（相对客户区，子窗口坐标系） */
export function toPhysicalRect(win: BrowserWindow, bounds: RenderBounds): PhysicalRect {
  const scaleFactor = screen.getDisplayMatching(win.getBounds()).scaleFactor || 1;
  return {
    x: Math.round(bounds.x * scaleFactor),
    y: Math.round(bounds.y * scaleFactor),
    width: Math.max(1, Math.round(bounds.width * scaleFactor)),
    height: Math.max(1, Math.round(bounds.height * scaleFactor)),
  };
}

export class NativeOverlay {
  private hwnd: bigint;
  private visible = false;
  private zLevel: OverlayLayer = 'normal';

  private constructor(hwnd: bigint) {
    this.hwnd = hwnd;
  }

  static create(parentHwnd: bigint, rect: PhysicalRect): NativeOverlay {
    // 使用系统预置 "STATIC" 窗口类：不抢焦点（WS_EX_NOACTIVATE），由 mpv 负责绘制
    const hwnd = CreateWindowExA(
      WS_EX_NOACTIVATE,
      'STATIC',
      '',
      WS_CHILD | WS_VISIBLE | WS_CLIPCHILDREN | WS_CLIPSIBLINGS,
      rect.x,
      rect.y,
      rect.width,
      rect.height,
      parentHwnd,
      0n,
      0n,
      null,
    );
    if (!hwnd || hwnd === 0n) {
      throw new PlayerError('OVERLAY_CREATE_FAILED', '创建视频渲染子窗口失败（Win32 CreateWindowEx 返回 0）');
    }
    const overlay = new NativeOverlay(hwnd);
    overlay.visible = true;
    ShowWindow(hwnd, SW_SHOW);
    return overlay;
  }

  get handle(): bigint {
    return this.hwnd;
  }

  get wid(): string {
    return this.hwnd.toString();
  }

  setBounds(rect: PhysicalRect): void {
    SetWindowPos(this.hwnd, 0n, rect.x, rect.y, rect.width, rect.height, SWP_NOZORDER | SWP_NOACTIVATE);
  }

  setZ(level: OverlayLayer): void {
    this.zLevel = level;
    if (level === 'hidden') {
      this.hide();
      return;
    }
    this.show();
    const insertAfter = level === 'bottom' ? HWND_BOTTOM : HWND_TOP;
    if (
      SetWindowPos(
        this.hwnd,
        insertAfter,
        0,
        0,
        0,
        0,
        SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE,
      ) === 0
    ) {
      throw new PlayerError('OVERLAY_LAYER_FAILED', `设置视频画面层级失败：${level}`);
    }
  }

  /** 读取子窗口当前物理矩形（调试用） */
  getRect(): PhysicalRect | null {
    if (!this.hwnd || this.hwnd === 0n) return null;
    const buffer = Buffer.alloc(16);
    if (GetWindowRect(this.hwnd, buffer) === 0) return null;
    return {
      x: buffer.readInt32LE(0),
      y: buffer.readInt32LE(4),
      width: buffer.readInt32LE(8) - buffer.readInt32LE(0),
      height: buffer.readInt32LE(12) - buffer.readInt32LE(4),
    };
  }

  show(): void {
    if (this.zLevel === 'hidden') return;
    if (this.visible) return;
    ShowWindow(this.hwnd, SW_SHOW);
    this.visible = true;
  }

  hide(): void {
    if (!this.visible) return;
    ShowWindow(this.hwnd, SW_HIDE);
    this.visible = false;
  }

  destroy(): void {
    if (!this.hwnd || this.hwnd === 0n) return;
    DestroyWindow(this.hwnd);
    this.hwnd = 0n;
    this.visible = false;
  }
}
