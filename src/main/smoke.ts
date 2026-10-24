import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
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
  let dataChecks: Record<string, unknown> = {};
  const timeout = setTimeout(() => finish(1), SMOKE_TIMEOUT_MS);

  function finish(code: number): void {
    clearTimeout(timeout);
    const passed = code === 0;
    const payload = JSON.stringify({ passed, checks, playerChecks, mediaChecks, dataChecks, state }, null, 2);
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
    checks.whitelistOnly =
      state?.apiKeys === 'app,detect,export,media,note,player,project,shot,still,tag,term';
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

    const dataPkg = process.env['SMOKE_DATA_PKG'];
    if (process.env['DSH_DATA_ROOT'] && dataPkg) {
      rmSync(dataPkg, { force: true });
      mkdirSync(dirname(dataPkg), { recursive: true });
      dataChecks = await runDataChecks(win, dataPkg);
      if (dataChecks.openOk === true && typeof dataChecks.openedProjectId === 'string') {
        Object.assign(
          dataChecks,
          await runAssetPackageCheck(win, process.env['DSH_DATA_ROOT'] as string, dataChecks.openedProjectId, dataPkg + '.assets.lapian'),
        );
      }
      Object.assign(checks, dataChecksAssertions(dataChecks));
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
      const payload = JSON.stringify({ passed: allPassed, checks, playerChecks, mediaChecks, dataChecks, state }, null, 2);
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

function dataChecksAssertions(result: Record<string, any>): Record<string, boolean> {
  return {
    dataCreate: result.createOk === true,
    dataList: result.listOk === true,
    dataUpdate: result.updateOk === true,
    dataShotCreate: result.shotCreateOk === true,
    dataShotUpdate: result.shotUpdateOk === true,
    dataShotList: result.shotListOk === true,
    dataTagCreate: result.tagCreateOk === true,
    dataTagAssign: result.tagAssignOk === true,
    dataTagList: result.tagListOk === true,
    dataNoteSave: result.noteSaveOk === true,
    dataNoteUpdate: result.noteUpdateOk === true,
    dataNoteList: result.noteListOk === true,
    dataStillCreate: result.stillCreateOk === true,
    dataStillList: result.stillListOk === true,
    dataTermCreate: result.termCreateOk === true,
    dataTermList: result.termListOk === true,
    dataTxGuard: result.txGuardOk === true,
    dataForeignKey: result.fkOk === true,
    dataSave: result.saveOk === true,
    dataOpen: result.openOk === true,
    dataOpenShots: result.openShotsOk === true,
    dataOpenNotes: result.openNotesOk === true,
    dataOpenTags: result.openTagsOk === true,
    dataDelete: result.deleteOk === true,
    dataCascade: result.cascadeOk === true,
    dataAssetPackage: result.assetOk === true,
    dataAssetRestored: result.assetRestoredOk === true,
  };
}

async function runDataChecks(win: BrowserWindow, packagePath: string): Promise<Record<string, any>> {
  const pkg = packagePath.replace(/\\/g, '/');
  const script = `
    (async () => {
      const out = {};
      const api = {
        project: window.api.project,
        shot: window.api.shot,
        still: window.api.still,
        tag: window.api.tag,
        note: window.api.note,
        term: window.api.term,
      };
      try {
        const created = await api.project.create({
          name: '冒烟项目',
          source: { path: 'D:/media/demo.mkv' },
          media: { filename: 'demo.mkv', durationMs: 8000, width: 640, height: 360, fps: 25, videoCodec: 'h264', sizeBytes: 123 },
        });
        out.createOk = created.ok === true;
        if (!created.ok) { out.createError = created.error; return out; }
        const project = created.data;

        const list = await api.project.list();
        out.listOk = list.ok === true && list.data.some((item) => item.id === project.id);

        const updatedProject = await api.project.update({ id: project.id, patch: { name: '冒烟项目改' } });
        out.updateOk = updatedProject.ok === true && updatedProject.data.name === '冒烟项目改';

        const shot1 = await api.shot.create({
          projectId: project.id, startMs: 0, endMs: 1000,
          shotSize: '全景', cameraMethod: '固定', dialogue: '台词1', remark: '备注1',
        });
        const shot2 = await api.shot.create({ projectId: project.id, startMs: 1000, endMs: 2000 });
        out.shotCreateOk = shot1.ok === true && shot2.ok === true && shot1.data.durationMs === 1000;

        const shotUpdate = await api.shot.update({ id: shot1.data.id, patch: { endMs: 1500, remark: '改过' } });
        out.shotUpdateOk = shotUpdate.ok === true && shotUpdate.data.durationMs === 1500 && shotUpdate.data.remark === '改过';

        const shotList = await api.shot.list({ projectId: project.id });
        out.shotListOk = shotList.ok === true && shotList.data.length === 2 && shotList.data[0].id === shot1.data.id;

        const tag = await api.tag.create({ category: '景别', name: '特写', color: '#e11d48' });
        out.tagCreateOk = tag.ok === true;
        const assigned = await api.tag.assign({ shotId: shot1.data.id, tagIds: [tag.data.id] });
        out.tagAssignOk = assigned.ok === true && assigned.data.tagIds.includes(tag.data.id);
        const tagList = await api.tag.list({ category: '景别' });
        out.tagListOk = tagList.ok === true && tagList.data.some((item) => item.id === tag.data.id);

        const note = await api.note.upsert({ projectId: project.id, shotId: shot1.data.id, text: '笔记内容' });
        out.noteSaveOk = note.ok === true;
        const noteUpdate = await api.note.upsert({ id: note.data.id, projectId: project.id, shotId: shot1.data.id, text: '笔记2' });
        out.noteUpdateOk = noteUpdate.ok === true && noteUpdate.data.text === '笔记2';
        const noteList = await api.note.list({ shotId: shot1.data.id });
        out.noteListOk = noteList.ok === true && noteList.data.length === 1;

        const still = await api.still.create({
          projectId: project.id, shotId: shot1.data.id, timeMs: 500,
          filePath: 'D:/__dsh_still__/frame.jpg', width: 640, height: 360, caption: 'caption',
          annotations: [{ type: 'box', x: 0.1, y: 0.1, w: 0.2, h: 0.2 }],
        });
        out.stillCreateOk = still.ok === true && still.data.annotations.length === 1;
        const stillList = await api.still.list({ shotId: shot1.data.id });
        out.stillListOk = stillList.ok === true && stillList.data.length === 1;

        const term = await api.term.create({ term: '景别', definition: '画面的取景范围' });
        out.termCreateOk = term.ok === true;
        const termList = await api.term.list({});
        out.termListOk = termList.ok === true && termList.data.some((item) => item.id === term.data.id);

        const badShot = await api.shot.create({ projectId: project.id, startMs: 2000, endMs: 1000 });
        const afterBad = await api.shot.list({ projectId: project.id });
        out.txGuardOk = badShot.ok === false && badShot.error.code === 'INVALID_ARGUMENT'
          && afterBad.ok === true && afterBad.data.length === 2;

        const missingProject = await api.shot.create({ projectId: 'no-such-project', startMs: 0, endMs: 100 });
        out.fkOk = missingProject.ok === false
          && ['PROJECT_NOT_FOUND', 'SHOT_CREATE_FAILED'].includes(missingProject.error.code);

        const saved = await api.project.save({ id: project.id, targetPath: ${JSON.stringify(pkg)} });
        out.saveOk = saved.ok === true && saved.data.sizeBytes > 0;
        out.savedPath = saved.ok ? saved.data.path : null;
        out.saveError = saved.ok ? null : saved.error;

        const opened = await api.project.open({ path: ${JSON.stringify(pkg)} });
        out.openOk = opened.ok === true && opened.data.renamed === true && opened.data.project.id !== project.id;
        if (opened.ok) {
          out.openedProjectId = opened.data.project.id;
          const openedShots = await api.shot.list({ projectId: opened.data.project.id });
          out.openShotsOk = openedShots.ok === true && openedShots.data.length === 2;
          const openedNotes = await api.note.list({ projectId: opened.data.project.id });
          out.openNotesOk = openedNotes.ok === true && openedNotes.data.length === 1;
          const openedTags = await api.tag.list({ category: '景别' });
          out.openTagsOk = openedTags.ok === true && openedTags.data.length === 1;
        } else {
          out.openError = opened.error;
        }

        const deleted = await api.project.delete({ id: project.id });
        out.deleteOk = deleted.ok === true;
        const afterDelete = await api.shot.list({ projectId: project.id });
        out.cascadeOk = afterDelete.ok === false || afterDelete.data.length === 0;

        return out;
      } catch (error) {
        out.exception = String(error && error.stack ? error.stack : error);
        return out;
      }
    })()
  `;
  return (await win.webContents.executeJavaScript(script)) as Record<string, any>;
}

async function runAssetPackageCheck(
  win: BrowserWindow,
  dataRoot: string,
  openedProjectId: string,
  packagePath: string,
): Promise<Record<string, any>> {
  const clearPackage = packagePath;
  rmSync(clearPackage, { force: true });
  mkdirSync(dirname(clearPackage), { recursive: true });
  const relativeStill = 'stills/asset-test.jpg';
  const sourceFile = join(dataRoot, 'projects', openedProjectId, relativeStill);
  mkdirSync(dirname(sourceFile), { recursive: true });
  writeFileSync(sourceFile, 'smoke-image-bytes', 'utf8');

  const result = (await win.webContents.executeJavaScript(`
    (async () => {
      const out = {};
      try {
        const still = await window.api.still.create({
          projectId: ${JSON.stringify(openedProjectId)},
          timeMs: 100,
          filePath: ${JSON.stringify(relativeStill)},
          caption: 'asset-test',
        });
        out.stillOk = still.ok === true;
        const saved = await window.api.project.save({
          id: ${JSON.stringify(openedProjectId)},
          targetPath: ${JSON.stringify(clearPackage.replace(/\\/g, '/'))},
        });
        out.savedOk = saved.ok === true;
        const reopened = await window.api.project.open({ path: ${JSON.stringify(clearPackage.replace(/\\/g, '/'))} });
        out.reopenedOk = reopened.ok === true;
        if (reopened.ok) {
          out.reopenedProjectId = reopened.data.project.id;
          const stills = await window.api.still.list({ projectId: reopened.data.project.id });
          out.stillsCount = stills.ok ? stills.data.length : -1;
          out.assetRestoredOk = stills.ok === true && stills.data.some((item) => item.filePath === ${JSON.stringify(relativeStill)});
        }
      } catch (error) {
        out.exception = String(error && error.stack ? error.stack : error);
      }
      return out;
    })()
  `)) as Record<string, any>;

  result.assetOk = result.stillOk === true && result.savedOk === true && result.reopenedOk === true;
  if (result.reopenedOk === true && typeof result.reopenedProjectId === 'string') {
    const restoredFile = join(dataRoot, 'projects', result.reopenedProjectId, relativeStill);
    result.assetRestoredOk = result.assetRestoredOk === true && existsSync(restoredFile);
  } else {
    result.assetRestoredOk = false;
  }
  return result;
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
