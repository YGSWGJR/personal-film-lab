import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { app, type BrowserWindow } from 'electron';
import type { PlayerService } from './player/player-service';

interface SmokeDeps {
  getPlayer(): PlayerService | null;
}

interface RendererState {
  ready: boolean;
  title: string;
  bridge: boolean;
  ipcOk: boolean;
  apiKeys: string;
  info: { version: string; platform: string; appDataPath: string } | null;
  error: string | null;
}

const SMOKE_TIMEOUT_MS = 60_000;
const HOLD_MS = Number(process.env['SMOKE_HOLD_MS'] ?? '0');

/**
 * 冒烟验证：渲染层首屏 + preload 白名单桥 + app:info 往返；
 * 设置 SMOKE_VIDEO 时追加播放器链路断言（打开 / 精确 seek / 逐帧步进 / 播放暂停 / 音量 / 错误处理）。
 * 可选 SMOKE_RESULT（JSON 输出）、SMOKE_SCREENSHOT（窗口截图）、SMOKE_HOLD_MS（保持窗口用于外部截屏）。
 */
export async function runSmokeTest(win: BrowserWindow, _deps: SmokeDeps): Promise<void> {
  const checks: Record<string, boolean> = {};
  let state: RendererState | null = null;
  let playerChecks: Record<string, unknown> = {};
  let mediaChecks: Record<string, unknown> = {};
  const timeout = setTimeout(() => finish(1), SMOKE_TIMEOUT_MS);

  function finish(code: number): void {
    clearTimeout(timeout);
    const passed = code === 0;
    const payload = JSON.stringify({ passed, checks, playerChecks, mediaChecks, state }, null, 2);
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
    checks.whitelistOnly = state?.apiKeys === 'app,media,player';
    checks.infoRendered = Boolean(
      state?.info?.version && state?.info?.platform && state?.info?.appDataPath,
    );

    const videoPath = process.env['SMOKE_VIDEO'];
    if (videoPath) {
      playerChecks = await runPlayerChecks(win, videoPath);
      Object.assign(checks, playerChecksAssertions(playerChecks));
    }

    const mediaVideo = process.env['SMOKE_MEDIA_VIDEO'] ?? videoPath;
    const mediaOut = process.env['SMOKE_MEDIA_OUT'];
    if (mediaVideo && mediaOut) {
      rmSync(mediaOut, { recursive: true, force: true });
      mkdirSync(mediaOut, { recursive: true });
      const transcodeSource = process.env['SMOKE_TRANSCODE_VIDEO'] ?? mediaVideo;
      mediaChecks = await runMediaChecks(win, mediaVideo, transcodeSource, mediaOut);
      Object.assign(checks, mediaChecksAssertions(mediaChecks));
    }

    const shotPath = process.env['SMOKE_SCREENSHOT'];
    if (shotPath) {
      await new Promise((resolve) => setTimeout(resolve, 800));
      const image = await win.webContents.capturePage();
      writeFileSync(shotPath, image.toPNG());
    }

    const allPassed = Object.values(checks).every(Boolean);
    if (HOLD_MS > 0) {
      // 先把画面停在一个有内容的帧，方便外部截屏做目检
      if (videoPath) {
        await win.webContents.executeJavaScript('window.api.player.seek({ timeMs: 2000 })');
      }
      const payload = JSON.stringify({ passed: allPassed, checks, playerChecks, mediaChecks, state }, null, 2);
      if (process.env['SMOKE_RESULT']) {
        writeFileSync(process.env['SMOKE_RESULT'], payload, 'utf8');
      }
      console.log(`SMOKE_RESULT ${payload}`);
      await new Promise((resolve) => setTimeout(resolve, HOLD_MS));
      app.exit(allPassed ? 0 : 1);
      return;
    }

    finish(allPassed ? 0 : 1);
  } catch (error) {
    console.error(error);
    finish(1);
  }
}

function mediaChecksAssertions(result: Record<string, any>): Record<string, boolean> {
  return {
    mediaProbe: result.probeOk === true,
    mediaProbeMissing: result.probeMissingOk === true,
    mediaProbeDiagnostics: result.probeMissingHasDiagnostics === true,
    mediaProbeFailureDiagnostics: result.badProbeDiagnosticsOk === true,
    mediaExtractFrame: result.frameOk === true,
    mediaExtractFrames: result.batchOk === true,
    mediaExtractFramesInvalid: result.batchInvalidOk === true,
    mediaTranscode: result.transcodeOk === true,
    mediaTranscodeMissing: result.transcodeMissingOk === true,
    mediaCancelUnknown: result.cancelUnknownOk === true,
    mediaCancel: result.cancelOk === true,
    mediaTimeout: result.timeoutOk === true,
    mediaProgress: result.progressOk === true,
  };
}

async function runMediaChecks(
  win: BrowserWindow,
  videoPath: string,
  transcodeSource: string,
  outputDir: string,
): Promise<Record<string, any>> {
  const outDir = outputDir.replace(/\\/g, '/');
  const badFile = process.env['SMOKE_BAD_FILE'] ?? '';
  const cancelVideo = process.env['SMOKE_CANCEL_VIDEO'] ?? '';

  const script = `
    (async () => {
      const out = {};
      const api = window.api.media;
      let progressCount = 0;
      const stages = [];
      const progressMax = {};
      const unsubscribe = api.onProgress((event) => {
        progressCount += 1;
        progressMax[event.stage] = Math.max(progressMax[event.stage] || 0, event.percent);
        if (!stages.includes(event.stage)) stages.push(event.stage);
      });
      try {
        const probe = await api.probe({ path: ${JSON.stringify(videoPath)} });
        out.probe = probe.ok ? probe.data : probe.error;
        out.probeOk = probe.ok === true
          && probe.data.hasVideo === true
          && probe.data.durationMs > 0
          && probe.data.width > 0
          && probe.data.height > 0
          && probe.data.fps > 0
          && Boolean(probe.data.videoCodec)
          && Boolean(probe.data.container);

        const missing = await api.probe({ path: 'D:/__dsh_media_missing__/nope.mp4' });
        out.probeMissingOk = missing.ok === false && missing.error.code === 'INPUT_NOT_FOUND';
        out.probeMissingHasDiagnostics = missing.ok === false
          && Boolean(missing.error.details && (missing.error.details.command || missing.error.details.path));

        if (${JSON.stringify(badFile)}) {
          const badProbe = await api.probe({ path: ${JSON.stringify(badFile)} });
          out.badProbe = badProbe.ok ? badProbe.data : badProbe.error;
          out.badProbeDiagnosticsOk = badProbe.ok === false
            && (badProbe.error.code === 'PROBE_FAILED' || badProbe.error.code === 'PROBE_PARSE_FAILED')
            && Boolean(badProbe.error.details && badProbe.error.details.command && badProbe.error.details.stderr);
        } else {
          out.badProbeDiagnosticsOk = true;
        }

        const frame = await api.extractFrame({
          path: ${JSON.stringify(videoPath)},
          timeMs: 2000,
          outputPath: ${JSON.stringify(outDir + '/frame-2000ms.jpg')},
        });
        out.frame = frame.ok ? frame.data : frame.error;
        out.frameOk = frame.ok === true
          && frame.data.sizeBytes > 0
          && frame.data.width > 0
          && frame.data.height > 0
          && frame.data.requestedTimeMs === 2000;

        const batch = await api.extractFrames({
          path: ${JSON.stringify(videoPath)},
          outputDir: ${JSON.stringify(outDir + '/frames')},
          intervalMs: 1000,
        });
        out.batch = batch.ok ? { count: batch.data.count, first: batch.data.frames[0], last: batch.data.frames[batch.data.frames.length - 1] } : batch.error;
        out.batchOk = batch.ok === true
          && batch.data.count >= 6
          && batch.data.frames.length === batch.data.count
          && batch.data.frames.every((item) => item.sizeBytes > 0 && item.timeMs >= 0);

        const invalidBatch = await api.extractFrames({
          path: ${JSON.stringify(videoPath)},
          outputDir: ${JSON.stringify(outDir + '/bad-frames')},
          intervalMs: 10,
        });
        out.batchInvalidOk = invalidBatch.ok === false;

        const transcode = await api.transcodeProxy({
          sourcePath: ${JSON.stringify(transcodeSource)},
          outputPath: ${JSON.stringify(outDir + '/proxy.mp4')},
          maxHeight: 360,
        });
        out.transcode = transcode.ok ? transcode.data : transcode.error;
        out.transcodeOk = transcode.ok === true
          && transcode.data.sizeBytes > 0
          && transcode.data.durationMs > 0
          && transcode.data.width > 0
          && transcode.data.height > 0
          && transcode.data.height <= 360
          && transcode.data.sourceSizeBytes > 0;

        const missingTranscode = await api.transcodeProxy({ sourcePath: 'D:/__dsh_media_missing__/nope.mp4' });
        out.transcodeMissingOk = missingTranscode.ok === false && missingTranscode.error.code === 'INPUT_NOT_FOUND';

        const cancelUnknown = await api.cancelJob({ jobId: 'no-such-job' });
        out.cancelUnknownOk = cancelUnknown.ok === true && cancelUnknown.data.cancelled === false;

        const timeoutProbe = await api.probe({ path: ${JSON.stringify(videoPath)}, timeoutMs: 1 });
        out.timeoutProbe = timeoutProbe.ok ? timeoutProbe.data : timeoutProbe.error;
        out.timeoutOk = timeoutProbe.ok === false
          && timeoutProbe.error.code === 'PROBE_TIMEOUT'
          && Boolean(timeoutProbe.error.details && timeoutProbe.error.details.timedOut === true);

        if (${JSON.stringify(cancelVideo)}) {
          let cancelJobId = null;
          const unsubCancel = api.onProgress((event) => {
            if (event.stage === 'transcode' && !cancelJobId) cancelJobId = event.jobId;
          });
          const pendingTranscode = api.transcodeProxy({
            sourcePath: ${JSON.stringify(cancelVideo)},
            outputPath: ${JSON.stringify(outDir + '/proxy-cancel.mp4')},
            maxHeight: 360,
          });
          const cancelDeadline = Date.now() + 20000;
          while (!cancelJobId && Date.now() < cancelDeadline) {
            await new Promise((resolve) => setTimeout(resolve, 20));
          }
          const cancelResult = cancelJobId ? await api.cancelJob({ jobId: cancelJobId }) : null;
          const cancelledTranscode = await pendingTranscode;
          unsubCancel();
          out.cancelJobId = cancelJobId;
          out.cancelOk = Boolean(
            cancelResult
              && cancelResult.ok === true
              && cancelResult.data.cancelled === true
              && cancelledTranscode.ok === false
              && cancelledTranscode.error.code === 'CANCELLED'
          );
        } else {
          out.cancelOk = true;
        }

        out.progressCount = progressCount;
        out.progressStages = stages;
        out.progressMax = progressMax;
        out.progressOk = progressCount > 0
          && progressMax.extractFrames === 100
          && progressMax.transcode === 100
          && stages.includes('extractFrames')
          && stages.includes('transcode');
        return out;
      } catch (error) {
        out.exception = String(error && error.stack ? error.stack : error);
        return out;
      } finally {
        unsubscribe();
      }
    })()
  `;
  return (await win.webContents.executeJavaScript(script)) as Record<string, any>;
}

function playerChecksAssertions(result: Record<string, any>): Record<string, boolean> {
  return {
    playerOpen: result.openOk === true,
    playerSeek: result.seekOk === true,
    playerFrameStep: result.stepOk === true,
    playerFrameBack: result.backOk === true,
    playerFrameDelta: result.frameOk === true,
    playerPlay: result.playOk === true,
    playerPause: result.pauseOk === true,
    playerVolume: result.volumeOk === true,
    playerBoundary: result.boundaryOk === true,
    playerFileNotFound: result.fileNotFoundOk === true,
    playerUnsupported: result.unsupportedOk === true,
  };
}

async function runPlayerChecks(win: BrowserWindow, videoPath: string): Promise<Record<string, any>> {
  const badFile = process.env['SMOKE_BAD_FILE'] ?? '';
  const script = `
    (async () => {
      const out = {};
      const api = window.api.player;
      try {
        const missing = await api.open({ mediaPath: 'D:/__dsh_not_exist__/nope.mp4' });
        out.fileNotFoundOk = missing.ok === false && missing.error.code === 'FILE_NOT_FOUND';

        if (${JSON.stringify(badFile)}) {
          const bad = await api.open({ mediaPath: ${JSON.stringify(badFile)} });
          out.unsupportedOk = bad.ok === false && ['UNSUPPORTED_FORMAT', 'FILE_LOAD_FAILED', 'FILE_LOAD_TIMEOUT', 'UNKNOWN_FORMAT', 'DECODE_FAILED'].includes(bad.error.code);
        } else {
          out.unsupportedOk = true;
        }

        const open = await api.open({ mediaPath: ${JSON.stringify(videoPath)} });
        out.openOk = open.ok === true;
        if (!open.ok) { out.openError = open.error; return out; }
        out.info = open.data;
        out.viewport = { width: window.innerWidth, height: window.innerHeight, dpr: window.devicePixelRatio };

        const atStart = await api.seek({ timeMs: 0 });
        const backAtStart = await api.frameStep({ dir: -1 });
        out.boundaryOk = atStart.ok === true && backAtStart.ok === true && backAtStart.data.frame === 0;

        const seek = await api.seek({ timeMs: 2000 });
        const state = await api.getState();
        out.seekOk = seek.ok === true && state.ok === true && Math.abs(state.data.timeMs - 2000) <= 40;

        const before = await api.getFrame();
        const step = await api.frameStep({ dir: 1 });
        const after = await api.getFrame();
        out.stepOk = before.ok === true && step.ok === true && after.ok === true && after.data.frame === before.data.frame + 1;
        out.frameDeltaMs = before.ok === true && after.ok === true ? after.data.timeMs - before.data.timeMs : null;
        out.frameOk = Boolean(out.stepOk && out.frameDeltaMs !== null && Math.abs(out.frameDeltaMs - 1000 / after.data.fps) <= 8);

        const back = await api.frameStep({ dir: -1 });
        out.backOk = after.ok === true && back.ok === true && back.data.frame === after.data.frame - 1;

        const played = await api.play();
        await new Promise((r) => setTimeout(r, 700));
        const playing = await api.getState();
        out.playOk = played.ok === true && playing.ok === true && playing.data.paused === false && playing.data.timeMs > after.data.timeMs;
        const paused = await api.pause();
        const pausedState = await api.getState();
        out.pauseOk = paused.ok === true && pausedState.ok === true && pausedState.data.paused === true;

        const vol = await api.setVolume({ volume: 0.3 });
        const volState = await api.getState();
        out.volumeOk = vol.ok === true && volState.ok === true && Math.abs(volState.data.volume - 0.3) <= 0.03;

        return out;
      } catch (error) {
        out.exception = String(error && error.stack ? error.stack : error);
        return out;
      }
    })()
  `;
  return (await win.webContents.executeJavaScript(script)) as Record<string, any>;
}