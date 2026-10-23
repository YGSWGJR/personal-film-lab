import { writeFileSync } from 'node:fs';
import { app, type BrowserWindow } from 'electron';

interface RendererInfo {
  version: string;
  platform: string;
  appDataPath: string;
}

interface RendererState {
  ready: boolean;
  title: string;
  bridge: boolean;
  ipcOk: boolean;
  apiKeys: string;
  info: RendererInfo | null;
  error: string | null;
}

const SMOKE_TIMEOUT_MS = 25_000;

/**
 * 冒烟验证：等待渲染层完成首屏与一次 app:info 往返，必要时截图后按结果设置退出码。
 * 用法：npm run smoke（可选 SMOKE_RESULT / SMOKE_SCREENSHOT 环境变量）。
 */
export async function runSmokeTest(win: BrowserWindow): Promise<void> {
  const checks: Record<string, boolean> = {};
  let state: RendererState | null = null;
  const timeout = setTimeout(() => finish(1), SMOKE_TIMEOUT_MS);

  function finish(code: number): void {
    clearTimeout(timeout);
    const passed = code === 0;
    const payload = JSON.stringify({ passed, checks, state }, null, 2);
    if (process.env['SMOKE_RESULT']) {
      writeFileSync(process.env['SMOKE_RESULT'], payload, 'utf8');
    }
    console.log(`SMOKE_RESULT ${payload}`);
    app.exit(code);
  }

  try {
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      state = await win.webContents.executeJavaScript('window.__SKELETON_STATE__ || null');
      if (state?.ready) break;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }

    checks.rendererReady = state?.ready === true;
    checks.titleMatched = state?.title === '个人拉片工作台';
    checks.bridgeExposed = state?.bridge === true;
    checks.ipcRoundTrip = state?.ipcOk === true;
    checks.whitelistOnly = state?.apiKeys === 'app';
    checks.infoRendered = Boolean(
      state?.info?.version && state?.info?.platform && state?.info?.appDataPath,
    );

    const shotPath = process.env['SMOKE_SCREENSHOT'];
    if (shotPath) {
      // 等一帧合成，避免虚拟显示环境截到旧帧
      await new Promise((resolve) => setTimeout(resolve, 800));
      const image = await win.webContents.capturePage();
      writeFileSync(shotPath, image.toPNG());
    }

    const allPassed = Object.values(checks).every(Boolean);
    finish(allPassed ? 0 : 1);
  } catch (error) {
    console.error(error);
    finish(1);
  }
}