import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { app, type BrowserWindow } from 'electron';
import { unzipSync } from 'fflate';
import { resolveDetectFramesDir } from './paths';
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
  let scopeChecks: Record<string, unknown> = {};
  let settingsChecks: Record<string, unknown> = {};
  let sessionChecks: Record<string, unknown> = {};
  let dataChecks: Record<string, unknown> = {};
  let importChecks: Record<string, unknown> = {};
  let detectChecks: Record<string, unknown> = {};
  let sessionRecoveryChecks: Record<string, unknown> = {};
  let settingsMigrationChecks: Record<string, unknown> = {};
  let settingsVerifyChecks: Record<string, unknown> = {};
  let environmentLockChecks: Record<string, unknown> = {};
  let settingsDChecks: Record<string, unknown> = {};
  let stillTimeChecks: Record<string, unknown> = {};
  let stillUiChecks: Record<string, unknown> = {};
  let overlayLayerChecks: Record<string, unknown> = {};
  let detectionClickChecks: Record<string, unknown> = {};
  let deleteUiChecks: Record<string, unknown> = {};
  const timeout = setTimeout(() => finish(1), SMOKE_TIMEOUT_MS);

  function finish(code: number): void {
    clearTimeout(timeout);
    const passed = code === 0;
    const payload = JSON.stringify({ passed, checks, playerChecks, mediaChecks, scopeChecks, settingsChecks, sessionChecks, dataChecks, importChecks, detectChecks, sessionRecoveryChecks, settingsMigrationChecks, settingsVerifyChecks, environmentLockChecks, settingsDChecks, stillTimeChecks, stillUiChecks, overlayLayerChecks, detectionClickChecks, deleteUiChecks, state }, null, 2);
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
      state?.apiKeys === 'app,data,detect,export,media,note,player,project,scope,session,settings,shot,stats,still,tag,term';
    checks.infoRendered = Boolean(
      state?.info?.version && state?.info?.platform && state?.info?.appDataPath,
    );
    const settingsResult = (await win.webContents.executeJavaScript(
      'window.api.settings.get()',
    )) as { ok: boolean; data?: { dataRoot: string; environmentOverride: boolean }; error?: unknown };
    settingsChecks = settingsResult;
    checks.settingsGet = settingsResult.ok === true;
    const dataRootOverride = process.env['DSH_DATA_ROOT'];
    if (dataRootOverride) {
      checks.settingsEnvPriority =
        settingsResult.ok === true &&
        settingsResult.data?.environmentOverride === true &&
        resolve(settingsResult.data.dataRoot) === resolve(dataRootOverride);
    }
    const sessionResult = (await win.webContents.executeJavaScript(
      'window.api.session.get()',
    )) as { ok: boolean; data?: unknown; error?: unknown };
    sessionChecks = sessionResult;
    checks.sessionGet = sessionResult.ok === true;

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

    const scopeVideo = process.env['SMOKE_SCOPE_VIDEO'];
    if (scopeVideo) {
      scopeChecks = await runScopeAudioChecks(win, scopeVideo);
      Object.assign(checks, {
        scopeAudio: scopeChecks.audioOk === true,
      });
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

    if (process.env['SMOKE_IMPORT_DATA'] === '1') {
      importChecks = await runImportChecks(win);
      Object.assign(checks, importChecksAssertions(importChecks));
    }

    if (process.env['SMOKE_DETECT_CHECKS'] === '1') {
      detectChecks = await runDetectChecks(win, process.env['SMOKE_DETECT_SOURCE'] ?? '');
      if (detectChecks.noFramesOk !== undefined) {
        detectChecks.noFramesOk =
          detectChecks.noFramesOk === true
          && typeof detectChecks.missingSourceProjectId === 'string'
          && !existsSync(resolveDetectFramesDir(detectChecks.missingSourceProjectId));
      }
      Object.assign(checks, detectChecksAssertions(detectChecks));
    }

    const recoveryMode = process.env['SMOKE_SESSION_RECOVERY'];
    if (recoveryMode) {
      sessionRecoveryChecks = await runSessionRecoveryChecks(
        win,
        recoveryMode,
        process.env['SMOKE_SESSION_PROJECT_ID'] ?? '',
      );
      Object.assign(checks, sessionRecoveryChecksAssertions(sessionRecoveryChecks));
    }

    const migrationMode = process.env['SMOKE_SETTINGS_MIGRATION'];
    if (migrationMode) {
      const oldRoot = join(app.getPath('userData'), 'lapian');
      const targetRoot = process.env['SMOKE_SETTINGS_TARGET'] ?? '';
      const projectId = process.env['SMOKE_SETTINGS_PROJECT_ID'] ?? '';
      settingsMigrationChecks = await runSettingsMigrationChecks(
        win,
        migrationMode,
        oldRoot,
        targetRoot,
        projectId,
      );
      if (migrationMode === 'confirm' && projectId) {
        settingsMigrationChecks.assetCopied = existsSync(
          join(targetRoot, 'projects', projectId, 'stills', 'ipc.png'),
        );
        settingsMigrationChecks.oldAssetPreserved = existsSync(
          join(oldRoot, 'projects', projectId, 'stills', 'ipc.png'),
        );
      }
      Object.assign(checks, settingsMigrationChecksAssertions(settingsMigrationChecks));
    }

    if (process.env['SMOKE_SETTINGS_VERIFY'] === '1') {
      settingsVerifyChecks = await runSettingsVerifyChecks(
        win,
        process.env['SMOKE_SETTINGS_EXPORT_DIR'] ?? '',
      );
      Object.assign(checks, settingsVerifyChecksAssertions(settingsVerifyChecks));
    }

    if (process.env['SMOKE_ENV_LOCK_CHECK'] === '1') {
      environmentLockChecks = await runEnvironmentLockChecks(
        win,
        process.env['DSH_DATA_ROOT'] ?? '',
      );
      Object.assign(checks, environmentLockChecksAssertions(environmentLockChecks));
    }

    if (process.env['SMOKE_SETTINGS_D'] === '1') {
      settingsDChecks = await runSettingsDChecks(
        win,
        process.env['SMOKE_SETTINGS_D_ROOT'] ?? '',
      );
      Object.assign(checks, settingsDChecksAssertions(settingsDChecks));
    }

    if (process.env['SMOKE_STILL_TIME'] === '1') {
      stillTimeChecks = await runStillTimeChecks(
        win,
        process.env['SMOKE_STILL_VIDEO'] ?? '',
      );
      Object.assign(checks, stillTimeChecksAssertions(stillTimeChecks));
    }

    if (process.env['SMOKE_STILL_UI'] === '1') {
      stillUiChecks = await runStillTimeUiChecks(
        win,
        process.env['SMOKE_STILL_EXPECT_TIME'] ?? '00:00:01.234',
      );
      Object.assign(checks, {
        stillUiTime: stillUiChecks.uiTimeOk === true,
      });
    }

    if (process.env['SMOKE_OVERLAY_LAYER'] === '1') {
      overlayLayerChecks = await runOverlayLayerChecks(win);
      Object.assign(checks, overlayLayerChecksAssertions(overlayLayerChecks));
    }

    if (process.env['SMOKE_DETECTION_CLICK'] === '1') {
      detectionClickChecks = await runDetectionClickChecks(win);
      Object.assign(checks, {
        detectionButtonVisible: detectionClickChecks.buttonFound === true,
        detectionButtonResponds:
          detectionClickChecks.modalOpen === true || detectionClickChecks.toastText !== '',
      });
    }

    if (process.env['SMOKE_DELETE_UI'] === '1') {
      deleteUiChecks = await runDeleteUiChecks(
        win,
        process.env['SMOKE_DELETE_VIDEO'] ?? '',
      );
      Object.assign(checks, deleteUiChecksAssertions(deleteUiChecks));
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
      const payload = JSON.stringify({ passed: allPassed, checks, playerChecks, mediaChecks, scopeChecks, settingsChecks, sessionChecks, dataChecks, importChecks, detectChecks, sessionRecoveryChecks, settingsMigrationChecks, settingsVerifyChecks, environmentLockChecks, settingsDChecks, stillTimeChecks, stillUiChecks, overlayLayerChecks, detectionClickChecks, deleteUiChecks, state }, null, 2);
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

async function runScopeAudioChecks(win: BrowserWindow, videoPath: string): Promise<Record<string, any>> {
  return (await win.webContents.executeJavaScript(`
    (async () => {
      const out = {};
      try {
        const audio = await window.api.scope.extractAudioWaveform({
          path: ${JSON.stringify(videoPath)},
          bucketMs: 100
        });
        out.audio = audio.ok ? {
          buckets: audio.data.buckets.length,
          bucketMs: audio.data.bucketMs,
          totalMs: audio.data.totalMs,
          first: audio.data.buckets[0]
        } : audio.error;
        out.audioOk = audio.ok === true
          && audio.data.bucketMs === 100
          && audio.data.buckets.length > 0
          && audio.data.totalMs > 0;
      } catch (error) {
        out.exception = String(error && error.stack ? error.stack : error);
      }
      return out;
    })()
  `)) as Record<string, any>;
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
    statsTagDistribution: result.statsTagOk === true,
    statsRhythm: result.statsRhythmOk === true,
    statsProgress: result.statsProgressOk === true,
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

function importChecksAssertions(result: Record<string, any>): Record<string, boolean> {
  return {
    importScan: result.scanOk === true,
    importProject: result.importOk === true,
    importListed: result.listOk === true,
    importIdempotent: result.idempotentOk === true,
  };
}

function detectChecksAssertions(result: Record<string, any>): Record<string, boolean> {
  return {
    detectProjectNotFound: result.projectNotFoundOk === true,
    detectProjectMessage: result.projectMessageOk === true,
    detectSourceMissing: result.sourceMissingOk === true,
    detectSourceMessage: result.sourceMessageOk === true,
    detectSourceBeforeFrames: result.noFramesOk === true,
    detectUrlSkipsLocalCheck: result.urlOk === true,
    detectNormalPreflight: result.normalOk === true,
  };
}

function sessionRecoveryChecksAssertions(result: Record<string, any>): Record<string, boolean> {
  return {
    sessionRecoveryDialog: result.dialogOk === true,
    sessionRecoveryCopy: result.copyOk === true,
    sessionRecoveryPreserved: result.preservedOk === true,
    sessionRecoveryControls: result.controlsOk === true,
    sessionRecoveryAction: result.actionOk === true,
    sessionRecoveryFinalState: result.finalStateOk === true,
  };
}

function settingsMigrationChecksAssertions(result: Record<string, any>): Record<string, boolean> {
  return {
    settingsMigrationSet: result.setOk === true,
    settingsMigrationDialog: result.dialogOk === true,
    settingsMigrationSelection: result.selectionOk === true,
    settingsMigrationFinalState: result.finalOk === true,
    settingsMigrationAsset: result.assetCopied !== false,
    settingsMigrationSourcePreserved: result.oldAssetPreserved !== false,
    settingsMigrationIdempotent: result.idempotentOk !== false,
    settingsMigrationData: result.dataOk !== false,
  };
}

function stillTimeChecksAssertions(result: Record<string, any>): Record<string, boolean> {
  return {
    stillTimeDatabase: result.databaseOk === true,
    stillTimeFilename: result.filenameOk === true,
    stillTimeMetadata: result.metadataOk === true,
    stillTimePdf: result.pdfOk === true,
    stillTimeDocx: result.docxOk === true,
  };
}

function overlayLayerChecksAssertions(result: Record<string, any>): Record<string, boolean> {
  return {
    overlayInitialLayer: result.initialNormal === true,
    overlayHide: result.hiddenOnOpen === true,
    overlayStatsHide: result.statsHidden === true,
    overlayNested: result.nestedStillHidden === true,
    overlayExportHide: result.exportHidden === true,
    overlayExportNested: result.exportNestedStillHidden === true,
    overlayCloseRestore: result.restoredNormal === true,
    overlayManualBottom: result.manualBottom === true,
    overlayManualHidden: result.manualHidden === true,
    overlayChangedWhileOpen: result.changedWhileOpen === true,
    overlayNestedManual: result.nestedManual === true,
  };
}

function deleteUiChecksAssertions(result: Record<string, any>): Record<string, boolean> {
  return {
    deleteShotMenu: result.shotMenuOk === true,
    deleteShotRightClick: result.shotDeleted === true,
    deleteStillMenu: result.stillMenuOk === true,
    deleteStillRightClick: result.stillDeleted === true,
    deleteKeyGuard: result.inputGuardOk === true,
    deleteKeyShot: result.deleteKeyOk === true,
    deleteNoOrphans: result.noOrphansOk === true,
  };
}

async function runDeleteUiChecks(
  win: BrowserWindow,
  videoPath: string,
): Promise<Record<string, any>> {
  if (!videoPath || !existsSync(videoPath)) {
    return { exception: `missing test video: ${videoPath}` };
  }
  const fixtureProjectId = process.env['SMOKE_DELETE_PROJECT_ID'] ?? '';
  let setup: Record<string, any>;
  if (fixtureProjectId) {
    setup = { ok: true, projectId: fixtureProjectId };
  } else {
    setup = (await win.webContents.executeJavaScript(`
    (async () => {
      const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      try {
        await sleep(2500);
        const project = await window.api.project.create({
          name: '删除交互测试',
          source: { type: 'local', path: ${JSON.stringify(videoPath)} },
          media: { filename: 'delete-test.mp4', durationMs: 4000, width: 640, height: 360, fps: 25 },
        });
        if (!project.ok) return { project };
        const shot1 = await window.api.shot.create({
          projectId: project.data.id,
          startMs: 0,
          endMs: 2000,
          shotSize: '中景',
        });
        const shot2 = await window.api.shot.create({
          projectId: project.data.id,
          startMs: 2000,
          endMs: 4000,
          shotSize: '近景',
        });
        if (!shot1.ok || !shot2.ok) return { project, shot1, shot2 };
        const tag = await window.api.tag.create({ category: '删除测试', name: '右键删除' });
        if (tag.ok) await window.api.tag.assign({ shotId: shot1.data.id, tagIds: [tag.data.id] });
        await window.api.note.upsert({
          projectId: project.data.id,
          shotId: shot1.data.id,
          text: '随镜头一起删除',
        });
        const still1 = await window.api.still.capture({
          projectId: project.data.id,
          shotId: shot1.data.id,
          timeMs: 1000,
        });
        const still2 = await window.api.still.capture({
          projectId: project.data.id,
          shotId: shot2.data.id,
          timeMs: 3000,
        });
        if (!still1.ok || !still2.ok) return { project, still1, still2 };
        await window.api.session.save({
          projectId: project.data.id,
          timeMs: 0,
          selectedShotId: shot1.data.id,
          leftCollapsed: false,
          rightCollapsed: false,
          volume: 1,
          shotScrollTop: 0,
        });
        return { ok: true, projectId: project.data.id };
      } catch (error) {
        return { ok: false, exception: String(error && error.stack ? error.stack : error) };
      }
    })()
    `)) as Record<string, any>;
    if (!setup.ok) return setup;

    await new Promise<void>((resolve) => {
      win.webContents.once('did-finish-load', () => resolve());
      win.webContents.reload();
    });
  }

  const result = (await win.webContents.executeJavaScript(`
    (async () => {
      const out = {};
      const projectId = ${JSON.stringify(setup.projectId)};
      const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      const waitFor = async (check, timeoutMs = 20000) => {
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
          const value = await check();
          if (value) return value;
          await sleep(100);
        }
        return null;
      };
      const openMenu = async (selector) => {
        const target = document.querySelector(selector);
        if (!target) return null;
        target.dispatchEvent(new MouseEvent('contextmenu', {
          bubbles: true,
          cancelable: true,
          button: 2,
          clientX: 180,
          clientY: 180,
        }));
        return waitFor(() => document.querySelector('.context-menu'), 3000);
      };
      const originalConfirm = window.confirm;
      try {
        out.loaded = Boolean(await waitFor(() =>
          document.querySelectorAll('.shot-row').length === 2
        ));
        if (!out.loaded) return out;

        window.confirm = () => true;
        const shotMenu = await openMenu('.shot-row');
        out.shotMenuOk = Boolean(shotMenu)
          && String(shotMenu.textContent || '').includes('删除镜头');
        Array.from(shotMenu?.querySelectorAll('button') || [])
          .find((button) => String(button.textContent || '').includes('删除镜头'))
          ?.click();
        out.shotDeleted = Boolean(await waitFor(async () => {
          const shots = await window.api.shot.list({ projectId });
          return shots.ok
            && shots.data.length === 1
            && !document.querySelector('.context-menu');
        }));

        const remainingShots = await window.api.shot.list({ projectId });
        out.remainingShotCount = remainingShots.ok ? remainingShots.data.length : -1;
        const remainingShotId = remainingShots.ok ? remainingShots.data[0]?.id : null;
        const stillMenu = await openMenu('.still');
        out.stillMenuOk = Boolean(stillMenu)
          && String(stillMenu.textContent || '').includes('删除静帧');
        Array.from(stillMenu?.querySelectorAll('button') || [])
          .find((button) => String(button.textContent || '').includes('删除静帧'))
          ?.click();
        out.stillDeleted = Boolean(await waitFor(async () => {
          if (document.querySelector('.context-menu')) return false;
          const stills = await window.api.still.list({ shotId: remainingShotId });
          return stills.ok && stills.data.length === 0;
        }));

        const textarea = document.querySelector('.note-section textarea');
        textarea?.focus();
        textarea?.dispatchEvent(new KeyboardEvent('keydown', {
          key: 'Delete',
          bubbles: true,
          cancelable: true,
        }));
        await sleep(300);
        const guardedShots = await window.api.shot.list({ projectId });
        out.inputGuardOk = guardedShots.ok
          && guardedShots.data.length === 1
          && document.querySelectorAll('.shot-row').length === 1;

        textarea?.blur();
        window.dispatchEvent(new KeyboardEvent('keydown', {
          key: 'Delete',
          bubbles: true,
          cancelable: true,
        }));
        out.deleteKeyOk = Boolean(await waitFor(async () => {
          const shots = await window.api.shot.list({ projectId });
          return shots.ok && shots.data.length === 0;
        }));

        const [shots, stills, notes] = await Promise.all([
          window.api.shot.list({ projectId }),
          window.api.still.list({ projectId }),
          window.api.note.list({ projectId }),
        ]);
        out.noOrphansOk = shots.ok && shots.data.length === 0
          && stills.ok && stills.data.length === 0
          && notes.ok && notes.data.length === 0;
        return out;
      } catch (error) {
        out.exception = String(error && error.stack ? error.stack : error);
        return out;
      } finally {
        window.confirm = originalConfirm;
      }
    })()
  `)) as Record<string, any>;
  return result;
}

async function runOverlayLayerChecks(win: BrowserWindow): Promise<Record<string, any>> {
  return (await win.webContents.executeJavaScript(`
    (async () => {
      const out = {};
      const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      const waitFor = async (check, timeoutMs = 15000) => {
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
          const value = await check();
          if (value) return value;
          await sleep(100);
        }
        return null;
      };
      const layer = async () => {
        const state = await window.api.player.getState();
        return state.ok ? state.data.layer : null;
      };
      try {
        await sleep(2500);
        out.initialNormal = await waitFor(async () => (await layer()) === 'normal');
        document.querySelector('button[title="设置"]')?.click();
        await waitFor(() => document.querySelector('.settings-modal'));
        out.hiddenOnOpen = await waitFor(async () => (await layer()) === 'hidden');

        document.querySelector('button[title="学习统计"]')?.click();
        await waitFor(() => document.querySelector('.stats-modal'));
        out.statsHidden = (await layer()) === 'hidden';
        document.querySelector('.stats-head button[aria-label="关闭"]')?.click();
        await waitFor(() => !document.querySelector('.stats-modal'));
        await sleep(150);
        out.nestedStillHidden = (await layer()) === 'hidden';

        Array.from(document.querySelectorAll('.nav-item'))
          .find((button) => String(button.textContent || '').includes('导出分镜本'))
          ?.click();
        await waitFor(() => document.querySelector('.export-modal'));
        out.exportHidden = (await layer()) === 'hidden';
        document.querySelector('.export-modal button[aria-label="关闭"]')?.click();
        await waitFor(() => !document.querySelector('.export-modal'));
        await sleep(150);
        out.exportNestedStillHidden = (await layer()) === 'hidden';

        document.querySelector('.settings-modal .modal-head button[aria-label="关闭"]')?.click();
        await waitFor(() => !document.querySelector('.settings-modal'));
        out.restoredNormal = await waitFor(async () => (await layer()) === 'normal');

        const layerButton = document.querySelector('.layer-button');
        const clickLayer = () => layerButton?.click();
        clickLayer();
        await waitFor(async () => (await layer()) === 'bottom');
        document.querySelector('button[title="设置"]')?.click();
        await waitFor(() => document.querySelector('.settings-modal'));
        document.querySelector('.settings-modal .modal-head button[aria-label="关闭"]')?.click();
        await waitFor(() => !document.querySelector('.settings-modal'));
        out.manualBottom = await waitFor(async () => (await layer()) === 'bottom');

        clickLayer();
        await waitFor(async () => (await layer()) === 'hidden');
        document.querySelector('button[title="设置"]')?.click();
        await waitFor(() => document.querySelector('.settings-modal'));
        document.querySelector('.settings-modal .modal-head button[aria-label="关闭"]')?.click();
        await waitFor(() => !document.querySelector('.settings-modal'));
        out.manualHidden = await waitFor(async () => (await layer()) === 'hidden');

        clickLayer();
        await waitFor(async () => (await layer()) === 'normal');
        document.querySelector('button[title="设置"]')?.click();
        await waitFor(() => document.querySelector('.settings-modal'));
        await waitFor(async () => (await layer()) === 'hidden');
        clickLayer();
        await waitFor(async () => (await layer()) === 'normal');
        clickLayer();
        await waitFor(async () => (await layer()) === 'bottom');
        document.querySelector('.settings-modal .modal-head button[aria-label="关闭"]')?.click();
        await waitFor(() => !document.querySelector('.settings-modal'));
        out.changedWhileOpen = await waitFor(async () => (await layer()) === 'bottom');

        document.querySelector('button[title="设置"]')?.click();
        await waitFor(() => document.querySelector('.settings-modal'));
        document.querySelector('button[title="学习统计"]')?.click();
        await waitFor(() => document.querySelector('.stats-modal'));
        document.querySelector('.stats-head button[aria-label="关闭"]')?.click();
        await waitFor(() => !document.querySelector('.stats-modal'));
        await sleep(150);
        const nestedHidden = (await layer()) === 'hidden';
        document.querySelector('.settings-modal .modal-head button[aria-label="关闭"]')?.click();
        await waitFor(() => !document.querySelector('.settings-modal'));
        out.nestedManual = nestedHidden
          && Boolean(await waitFor(async () => (await layer()) === 'bottom'));
        return out;
      } catch (error) {
        out.exception = String(error && error.stack ? error.stack : error);
        return out;
      }
    })()
  `)) as Record<string, any>;
}

async function runDetectionClickChecks(win: BrowserWindow): Promise<Record<string, any>> {
  return (await win.webContents.executeJavaScript(`
    (async () => {
      const out = { startedAt: Date.now() };
      const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      const waitFor = async (check, timeoutMs = 15000) => {
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
          const value = await check();
          if (value) return value;
          await sleep(100);
        }
        return null;
      };
      try {
        const button = await waitFor(() =>
          Array.from(document.querySelectorAll('.nav-item'))
            .find((item) => String(item.textContent || '').includes('镜头检测'))
        );
        out.buttonFound = Boolean(button);
        out.buttonDisabled = Boolean(button?.disabled);
        if (!button) return out;
        button.click();
        const outcome = await waitFor(() => {
          const modal = document.querySelector('.detect-modal');
          if (modal) return { modal };
          const toast = document.querySelector('.toast');
          if (toast) return { toast };
          return null;
        }, 20000);
        out.elapsedMs = Date.now() - out.startedAt;
        out.modalOpen = Boolean(outcome?.modal);
        out.toastText = String(outcome?.toast?.textContent || '');
        if (outcome?.modal) {
          outcome.modal.querySelector('.modal-head button[aria-label="关闭"]')?.click();
          await sleep(300);
        }
        return out;
      } catch (error) {
        out.exception = String(error && error.stack ? error.stack : error);
        return out;
      }
    })()
  `)) as Record<string, any>;
}

async function runStillTimeChecks(
  win: BrowserWindow,
  videoPath: string,
): Promise<Record<string, any>> {
  if (!videoPath || !existsSync(videoPath)) {
    return { exception: `missing test video: ${videoPath}` };
  }
  const result = (await win.webContents.executeJavaScript(`
    (async () => {
      const out = {};
      try {
        const project = await window.api.project.create({
          name: '静帧时间测试',
          source: { type: 'local', path: ${JSON.stringify(videoPath)} },
          media: {
            filename: 'still-time-test.mp4',
            durationMs: 4000,
            width: 640,
            height: 360,
            fps: 25,
          },
        });
        if (!project.ok) return { project };
        const shot = await window.api.shot.create({
          projectId: project.data.id,
          startMs: 0,
          endMs: 4000,
          shotSize: '中景',
        });
        if (!shot.ok) return { project, shot };
        const still = await window.api.still.capture({
          projectId: project.data.id,
          shotId: shot.data.id,
          timeMs: 1234,
          caption: '时间一致性',
        });
        if (!still.ok) return { project, shot, still };
        const pdf = await window.api.export.storyboard({
          projectId: project.data.id,
          format: 'pdf',
          imageStrategy: 'both',
        });
        const docx = await window.api.export.storyboard({
          projectId: project.data.id,
          format: 'docx',
          imageStrategy: 'both',
        });
        await window.api.session.save({
          projectId: project.data.id,
          timeMs: 1234,
          selectedShotId: shot.data.id,
          leftCollapsed: false,
          rightCollapsed: false,
          volume: 1,
          shotScrollTop: 0,
        });
        return {
          project,
          shot,
          still,
          pdf,
          docx,
          projectId: project.data.id,
          shotId: shot.data.id,
        };
      } catch (error) {
        return { exception: String(error && error.stack ? error.stack : error) };
      }
    })()
  `)) as Record<string, any>;
  if (!result.still?.ok) return result;

  const still = result.still.data;
  const stillPath =
    /^[A-Za-z]:[\\/]/u.test(still.filePath) || still.filePath.startsWith('/')
      ? still.filePath
      : join(process.env['DSH_DATA_ROOT'] ?? '', 'projects', result.projectId, still.filePath);
  const metadata = readPngTextMetadata(stillPath);
  const filenameMatch = /still-(\d{8})-/u.exec(stillPath);
  result.databaseOk = still.timeMs === 1234;
  result.filenameOk = filenameMatch?.[1] === '00001234';
  result.metadataOk =
    metadata.Time === '00:00:01.234' && metadata.TimeMs === '1234';
  result.pdfOk =
    result.pdf?.ok === true &&
    existsSync(result.pdf.data.filePath) &&
    readFileSync(result.pdf.data.filePath).length > 0;
  if (result.docx?.ok === true && existsSync(result.docx.data.filePath)) {
    const zipped = unzipSync(new Uint8Array(readFileSync(result.docx.data.filePath)));
    const documentXml = Buffer.from(zipped['word/document.xml'] ?? []).toString('utf8');
    result.docxOk =
      documentXml.includes('00:00:01.234') &&
      documentXml.includes('00:00:02.000');
  } else {
    result.docxOk = false;
  }
  result.metadata = metadata;
  return result;
}

async function runStillTimeUiChecks(
  win: BrowserWindow,
  expectedTime: string,
): Promise<Record<string, any>> {
  return (await win.webContents.executeJavaScript(`
    (async () => {
      const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      const deadline = Date.now() + 15000;
      while (Date.now() < deadline) {
        const caption = document.querySelector('.still-caption');
        if (caption) {
          const text = String(caption.textContent || '').replace(/\\s+/g, ' ');
          return {
            text,
            uiTimeOk: text.includes(${JSON.stringify(expectedTime)}),
          };
        }
        await sleep(100);
      }
      return { text: '', uiTimeOk: false };
    })()
  `)) as Record<string, any>;
}

function readPngTextMetadata(filePath: string): Record<string, string> {
  const data = readFileSync(filePath);
  const values: Record<string, string> = {};
  let offset = 8;
  while (offset + 12 <= data.length) {
    const length = data.readUInt32BE(offset);
    const type = data.toString('ascii', offset + 4, offset + 8);
    const next = offset + 12 + length;
    if (next > data.length) break;
    if (type === 'tEXt') {
      const text = data.toString('latin1', offset + 8, offset + 8 + length);
      const separator = text.indexOf('\0');
      if (separator > 0) {
        values[text.slice(0, separator)] = text.slice(separator + 1);
      }
    }
    if (type === 'IEND') break;
    offset = next;
  }
  return values;
}

function settingsVerifyChecksAssertions(result: Record<string, any>): Record<string, boolean> {
  return {
    settingsVerifySave: result.saveOk === true,
    settingsVerifyRead: result.readBackOk === true,
    settingsVerifyToast: result.toastOk === true,
    settingsVerifyPath: result.pathOk === true,
  };
}

function environmentLockChecksAssertions(result: Record<string, any>): Record<string, boolean> {
  return {
    environmentLockShown: result.lockedShown === true,
    environmentLockRoot: result.rootShown === true,
    environmentLockGuidance: result.guidanceOk === true,
    environmentLockSaveDisabled: result.saveDisabled === true,
    environmentLockDetect: result.lockedDetectOk === true,
    environmentUnlockDetect: result.unlockedDetectOk === true,
    environmentUnlockEditable: result.unlockedEditableOk === true,
  };
}

function settingsDChecksAssertions(result: Record<string, any>): Record<string, boolean> {
  return {
    settingsDTenItems: result.tenItemsOk === true,
    settingsDInheritance: result.inheritanceOk === true,
    settingsDCustomSave: result.customSaveOk === true,
    settingsDReset: result.resetOk === true,
    settingsDResetSave: result.resetSaveOk === true,
  };
}

async function runSettingsDChecks(
  win: BrowserWindow,
  customRoot: string,
): Promise<Record<string, any>> {
  return (await win.webContents.executeJavaScript(`
    (async () => {
      const out = {};
      const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      const waitFor = async (check, timeoutMs = 15000) => {
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
          const value = await check();
          if (value) return value;
          await sleep(100);
        }
        return null;
      };
      const setInput = (input, value) => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')
          ?.set?.call(input, value);
        input.dispatchEvent(new Event('input', { bubbles: true }));
      };
      const fieldByTitle = (modal, title) =>
        Array.from(modal.querySelectorAll('.path-field')).find((field) =>
          String(field.querySelector('strong')?.textContent || '').includes(title)
        );
      const customRoot = ${JSON.stringify(customRoot.replace(/\\/g, '/'))};
      const custom = {
        proxyCacheDir: customRoot + '/proxy',
        frameCacheDir: customRoot + '/frames',
        waveformCacheDir: customRoot + '/waveforms',
        thumbCacheDir: customRoot + '/thumbs',
        exportSubDir: customRoot + '/export-sub',
        stillSubDir: customRoot + '/still-sub',
      };
      const titles = {
        proxyCacheDir: '代理缓存目录',
        frameCacheDir: '抽帧缓存目录',
        waveformCacheDir: '波形缓存目录',
        thumbCacheDir: '微缩图缓存目录',
        exportSubDir: '导出子目录',
        stillSubDir: '静帧子目录',
      };
      try {
        await sleep(2500);
        document.querySelector('button[title="设置"]')?.click();
        let modal = await waitFor(() => document.querySelector('.settings-modal'));
        if (!modal) return out;
        const fields = Array.from(modal.querySelectorAll('.path-field'));
        const optionalFields = fields.filter((field) =>
          field.querySelector('.inherit-hint')
        );
        out.tenItemsOk = fields.length === 10 && optionalFields.length === 6;
        out.inheritanceOk = optionalFields.length === 6
          && optionalFields.every((field) =>
            field.classList.contains('inherited')
            && String(field.querySelector('input')?.placeholder || '').includes('继承：')
          );

        for (const [key, title] of Object.entries(titles)) {
          const field = fieldByTitle(modal, title);
          const input = field?.querySelector('input');
          if (input) setInput(input, custom[key]);
        }
        await sleep(100);
        modal.querySelector('button[type="submit"]')?.click();
        await waitFor(() => !document.querySelector('.settings-modal'));
        const saved = await waitFor(async () => {
          const settings = await window.api.settings.get();
          return settings.ok
            && Object.entries(custom).every(([key, value]) =>
              String(settings.data[key] || '').replace(/\\\\/g, '/').toLowerCase() === value.toLowerCase()
            )
            ? settings
            : null;
        });
        out.customSaveOk = Boolean(saved);

        document.querySelector('button[title="设置"]')?.click();
        modal = await waitFor(() => document.querySelector('.settings-modal'));
        if (!modal) return out;
        Array.from(modal.querySelectorAll('footer button'))
          .find((button) => String(button.textContent || '').includes('还原默认'))
          ?.click();
        const reset = await waitFor(() => {
          const currentFields = Array.from(modal.querySelectorAll('.path-field'));
          const optional = currentFields.filter((field) =>
            String(field.querySelector('strong')?.textContent || '').match(
              /代理缓存|抽帧缓存|波形缓存|微缩图缓存|导出子目录|静帧子目录/
            )
          );
          return optional.length === 6
            && optional.every((field) => !String(field.querySelector('input')?.value || '').trim())
            ? currentFields
            : null;
        });
        out.resetOk = Boolean(reset);
        modal.querySelector('button[type="submit"]')?.click();
        await waitFor(() => !document.querySelector('.settings-modal'));
        const info = await window.api.app.getInfo();
        const defaultDataRoot = info.ok
          ? info.data.appDataPath.replace(/\\\\/g, '/') + '/lapian'
          : '';
        const resetSaved = await waitFor(async () => {
          const settings = await window.api.settings.get();
          return settings.ok
            && settings.data.dataRoot.replace(/\\\\/g, '/').toLowerCase()
              === defaultDataRoot.toLowerCase()
            && Object.keys(custom).every((key) => settings.data[key] === undefined)
            ? settings
            : null;
        });
        out.resetSaveOk = Boolean(resetSaved);
        return out;
      } catch (error) {
        out.exception = String(error && error.stack ? error.stack : error);
        return out;
      }
    })()
  `)) as Record<string, any>;
}

async function runEnvironmentLockChecks(
  win: BrowserWindow,
  environmentRoot: string,
): Promise<Record<string, any>> {
  const locked = (await win.webContents.executeJavaScript(`
    (async () => {
      const out = {};
      const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      const waitFor = async (check, timeoutMs = 10000) => {
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
          const value = check();
          if (value) return value;
          await sleep(100);
        }
        return null;
      };
      try {
        await sleep(2500);
        document.querySelector('button[title="设置"]')?.click();
        const modal = await waitFor(() => document.querySelector('.settings-modal'));
        out.modalOk = Boolean(modal);
        if (!modal) return out;
        const note = modal.querySelector('.environment-note');
        const noteText = String(note?.textContent || '');
        out.lockedShown = Boolean(note)
          && noteText.includes('DSH_DATA_ROOT')
          && noteText.includes('设置界面暂不可修改');
        out.rootShown = noteText.includes(${JSON.stringify(environmentRoot)});
        out.guidanceOk = noteText.includes('set DSH_DATA_ROOT=')
          && noteText.includes('export DSH_DATA_ROOT=')
          && noteText.includes('Remove-Item Env:DSH_DATA_ROOT')
          && noteText.includes('高级系统设置')
          && noteText.includes('.bat')
          && noteText.includes('.ps1');
        const inputs = Array.from(modal.querySelectorAll('.path-input input'));
        const submit = modal.querySelector('button[type="submit"]');
        out.inputsDisabled = inputs.length === 10 && inputs.every((input) => input.disabled);
        out.saveDisabled = Boolean(submit && submit.disabled);
        Array.from(note?.querySelectorAll('button') || [])
          .find((button) => String(button.textContent || '').includes('检测'))
          ?.click();
        const lockedMessage = await waitFor(() =>
          modal.querySelector('.environment-check.locked')
        );
        out.lockedDetectOk = String(lockedMessage?.textContent || '').includes('仍被 DSH_DATA_ROOT 锁定');
        return out;
      } catch (error) {
        out.exception = String(error && error.stack ? error.stack : error);
        return out;
      }
    })()
  `)) as Record<string, any>;

  const lockScreenshot = process.env['SMOKE_ENV_LOCK_SCREENSHOT'];
  if (lockScreenshot) {
    const image = await win.webContents.capturePage();
    writeFileSync(lockScreenshot, image.toPNG());
  }

  const previousRoot = process.env['DSH_DATA_ROOT'];
  delete process.env['DSH_DATA_ROOT'];
  try {
    const unlocked = (await win.webContents.executeJavaScript(`
      (async () => {
        const out = {};
        const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
        const waitFor = async (check, timeoutMs = 10000) => {
          const deadline = Date.now() + timeoutMs;
          while (Date.now() < deadline) {
            const value = check();
            if (value) return value;
            await sleep(100);
          }
          return null;
        };
        try {
          const modal = document.querySelector('.settings-modal');
          if (!modal) return out;
          const note = modal.querySelector('.environment-note');
          const detect = Array.from(modal.querySelectorAll('button'))
            .find((button) => String(button.textContent || '').includes('检测'));
          if (!detect && note) {
            out.noteStillPresent = true;
            return out;
          }
          note?.querySelector('button')?.click();
          const success = await waitFor(() =>
            modal.querySelector('.environment-check.success')
          );
          const inputs = Array.from(modal.querySelectorAll('.path-input input'));
          const submit = modal.querySelector('button[type="submit"]');
          out.successText = String(success?.textContent || '');
          out.unlockedDetectOk = out.successText.includes('已解除锁定');
          out.unlockedEditableOk = !modal.querySelector('.environment-note')
            && inputs.length === 10
            && inputs.every((input) => !input.disabled)
            && Boolean(submit && !submit.disabled);
          return out;
        } catch (error) {
          out.exception = String(error && error.stack ? error.stack : error);
          return out;
        }
      })()
    `)) as Record<string, any>;
    return { ...locked, ...unlocked };
  } finally {
    if (previousRoot === undefined) delete process.env['DSH_DATA_ROOT'];
    else process.env['DSH_DATA_ROOT'] = previousRoot;
  }
}

async function runSettingsVerifyChecks(
  win: BrowserWindow,
  exportDir: string,
): Promise<Record<string, any>> {
  return (await win.webContents.executeJavaScript(`
    (async () => {
      const out = {};
      const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      const waitFor = async (check, timeoutMs = 10000) => {
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
          const value = await check();
          if (value) return value;
          await sleep(100);
        }
        return null;
      };
      try {
        await sleep(2500);
        document.querySelector('button[title="设置"]')?.click();
        const modal = await waitFor(() => document.querySelector('.settings-modal'));
        out.modalOk = Boolean(modal);
        if (!modal) return out;
        const field = Array.from(modal.querySelectorAll('.path-field')).find((item) =>
          String(item.querySelector('strong')?.textContent || '').includes('导出目录')
        );
        const input = field?.querySelector('input');
        if (!input) return out;
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')
          ?.set?.call(input, ${JSON.stringify(exportDir)});
        input.dispatchEvent(new Event('input', { bubbles: true }));
        await sleep(50);
        const submit = modal.querySelector('button[type="submit"]');
        submit?.click();
        const closed = await waitFor(() => !document.querySelector('.settings-modal'));
        out.saveOk = Boolean(closed);
        const toast = await waitFor(() => document.querySelector('.toast'));
        await sleep(100);
        const toastText = String(toast?.textContent || '');
        const settings = await window.api.settings.get();
        out.readBackOk = settings.ok === true
          && settings.data.exportDir.replace(/\\\\/g, '/').toLowerCase()
            === ${JSON.stringify(exportDir.replace(/\\/g, '/'))}.toLowerCase();
        out.settingsPath = settings.ok ? settings.data.settingsPath : null;
        out.pathOk = settings.ok === true
          && Boolean(settings.data.settingsPath)
          && String(settings.data.settingsPath).endsWith('settings.json');
        out.toastOk = toastText.includes('设置已保存')
          && Boolean(out.settingsPath)
          && toastText.includes(String(out.settingsPath));
        out.toastText = toastText;
        return out;
      } catch (error) {
        out.exception = String(error && error.stack ? error.stack : error);
        return out;
      }
    })()
  `)) as Record<string, any>;
}

async function runSettingsMigrationChecks(
  win: BrowserWindow,
  mode: string,
  oldRoot: string,
  targetRoot: string,
  projectId: string,
): Promise<Record<string, any>> {
  return (await win.webContents.executeJavaScript(`
    (async () => {
      const out = { mode: ${JSON.stringify(mode)} };
      const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      const normalize = (value) => String(value || '').replace(/\\\\/g, '/').replace(/\\/+$/, '').toLowerCase();
      const targetRoot = ${JSON.stringify(targetRoot.replace(/\\/g, '/'))};
      const oldRoot = ${JSON.stringify(oldRoot.replace(/\\/g, '/'))};
      const projectId = ${JSON.stringify(projectId)};
      const waitFor = async (check, timeoutMs = 20000) => {
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
          const value = await check();
          if (value) return value;
          await sleep(100);
        }
        return null;
      };
      const buttonText = (button) => String(button && button.textContent || '').replace(/\\s+/g, '');
      try {
        await sleep(2500);
        const changed = await window.api.settings.set({
          dataRoot: targetRoot,
          cacheDir: targetRoot,
          exportDir: targetRoot + '/projects',
          stillDir: targetRoot + '/projects',
        });
        out.setOk = changed.ok === true;
        out.setResult = changed;
        if (!changed.ok) return out;

        if (${JSON.stringify(mode)} === 'no-candidates') {
          const settled = await waitFor(async () => {
            const settings = await window.api.settings.get();
            const projects = await window.api.project.list();
            return settings.ok
              && normalize(settings.data.dataRoot) === normalize(targetRoot)
              && projects.ok
              ? { settings, projects }
              : null;
          });
          await sleep(500);
          out.dialogOk = !document.querySelector('.import-wizard');
          out.selectionOk = true;
          out.finalOk = Boolean(settled)
            && settled.projects.data.length === 0;
          out.idempotentOk = true;
          return out;
        }

        const wizard = await waitFor(() => document.querySelector('.import-wizard'));
        out.dialogOk = Boolean(wizard);
        if (!wizard) return out;
        const title = String(wizard.querySelector('h2')?.textContent || '').replace(/\\s+/g, '');
        const labels = Array.from(wizard.querySelectorAll('.import-wizard-actions button'))
          .map(buttonText);
        const candidates = wizard.querySelectorAll('.import-candidate');
        out.title = title;
        out.labels = labels;
        out.candidateCount = candidates.length;

        if (${JSON.stringify(mode)} === 'visual') {
          out.selectionOk = title.includes('迁移旧项目')
            && candidates.length === 1
            && labels.includes('仅迁移选中');
          out.finalOk = true;
          out.idempotentOk = true;
          return out;
        }

        if (${JSON.stringify(mode)} === 'cancel') {
          out.selectionOk = title.includes('迁移旧项目') && candidates.length === 1;
          Array.from(wizard.querySelectorAll('.import-wizard-actions button'))
            .find((button) => buttonText(button) === '取消更改')?.click();
          await waitFor(() => !document.querySelector('.import-wizard'));
          const settled = await waitFor(async () => {
            const settings = await window.api.settings.get();
            const projects = await window.api.project.list();
            return settings.ok
              && normalize(settings.data.dataRoot) === normalize(oldRoot)
              && projects.ok
              && projects.data.some((project) => project.id === projectId)
              ? { settings, projects }
              : null;
          });
          out.finalOk = Boolean(settled);
          out.idempotentOk = true;
          return out;
        }

        if (${JSON.stringify(mode)} === 'skip') {
          out.selectionOk = title.includes('迁移旧项目')
            && candidates.length === 1
            && labels.includes('跳过（不迁移）');
          Array.from(wizard.querySelectorAll('.import-wizard-actions button'))
            .find((button) => buttonText(button) === '跳过（不迁移）')?.click();
          await waitFor(() => !document.querySelector('.import-wizard'));
          const settled = await waitFor(async () => {
            const settings = await window.api.settings.get();
            const projects = await window.api.project.list();
            return settings.ok
              && normalize(settings.data.dataRoot) === normalize(targetRoot)
              && projects.ok
              ? { settings, projects }
              : null;
          });
          out.finalOk = Boolean(settled) && settled.projects.data.length === 0;
          out.idempotentOk = true;
          return out;
        }

        out.selectionOk = title.includes('迁移旧项目')
          && candidates.length === 1
          && labels.includes('仅迁移选中');
        const checkbox = wizard.querySelector('.import-candidate input');
        if (checkbox && !checkbox.checked) checkbox.click();
        await sleep(50);
        Array.from(wizard.querySelectorAll('.import-wizard-actions button'))
          .find((button) => buttonText(button) === '仅迁移选中')?.click();
        await waitFor(() => !document.querySelector('.import-wizard'), 30000);
        const settled = await waitFor(async () => {
          const settings = await window.api.settings.get();
          const projects = await window.api.project.list();
          const workspace = window.__CAPTURE_WORKSPACE_STATE__?.() ?? null;
          return settings.ok
            && normalize(settings.data.dataRoot) === normalize(targetRoot)
            && projects.ok
            && projects.data.some((project) => project.id === projectId)
            && workspace?.projectId === projectId
            ? { settings, projects, workspace }
            : null;
        }, 30000);
        out.finalOk = Boolean(settled);
        if (settled) {
          const shots = await window.api.shot.list({ projectId });
          const stills = await window.api.still.list({ projectId });
          out.dataOk = shots.ok === true
            && shots.data.length === 1
            && stills.ok === true
            && stills.data.length === 1;
          const repeated = await window.api.data.importProject({
            root: oldRoot,
            projectId,
          });
          out.idempotentOk = repeated.ok === true
            && repeated.data.imported === false
            && repeated.data.reason === 'already-exists';
          out.repeated = repeated;
        }
        return out;
      } catch (error) {
        out.exception = String(error && error.stack ? error.stack : error);
        return out;
      }
    })()
  `)) as Record<string, any>;
}

async function runSessionRecoveryChecks(
  win: BrowserWindow,
  mode: string,
  expectedProjectId: string,
): Promise<Record<string, any>> {
  return (await win.webContents.executeJavaScript(`
    (async () => {
      const out = { mode: ${JSON.stringify(mode)} };
      const expectedProjectId = ${JSON.stringify(expectedProjectId)};
      const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      const waitFor = async (check, timeoutMs = 15000) => {
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
          const value = check();
          if (value) return value;
          await sleep(100);
        }
        return null;
      };
      const buttonText = (button) => String(button && button.textContent || '').replace(/\\s+/g, '');
      try {
        if (${JSON.stringify(mode)} === 'normal') {
          await sleep(800);
          const wizard = document.querySelector('.import-wizard');
          const session = await window.api.session.get();
          const projects = await window.api.project.list();
          const workspace = window.__CAPTURE_WORKSPACE_STATE__?.() ?? null;
          out.dialogOk = !wizard;
          out.copyOk = true;
          out.preservedOk = session.ok === true
            && session.data?.projectId === expectedProjectId;
          out.controlsOk = true;
          out.actionOk = true;
          out.finalStateOk = projects.ok === true
            && projects.data.some((project) => project.id === expectedProjectId)
            && workspace?.projectId === expectedProjectId;
          return out;
        }
        const wizard = await waitFor(() => document.querySelector('.import-wizard'));
        out.dialogOk = Boolean(wizard);
        if (!wizard) return out;
        const title = String(wizard.querySelector('h2')?.textContent || '').replace(/\\s+/g, '');
        out.title = title;
        out.copyOk = title.includes('上次打开的项目未找到');

        const before = await window.api.session.get();
        out.sessionBefore = before;
        out.preservedOk = before.ok === true
          && before.data?.projectId === expectedProjectId;

        const buttons = Array.from(wizard.querySelectorAll('.import-wizard-actions button'));
        const labels = buttons.map(buttonText);
        out.labels = labels;
        const hasEmpty = Boolean(wizard.querySelector('.import-empty-state'));
        const selected = wizard.querySelectorAll('.import-candidate input:checked').length;
        out.selectedCandidates = selected;

        if (${JSON.stringify(mode)} === 'no-candidates') {
          out.controlsOk = hasEmpty === true
            && labels.length === 1
            && labels[0] === '知道了';
          buttons[0]?.click();
          await waitFor(() => !document.querySelector('.import-wizard'));
          await sleep(400);
          const after = await window.api.session.get();
          const workspace = window.__CAPTURE_WORKSPACE_STATE__?.() ?? null;
          out.finalStateOk = after.ok === true
            && after.data === null
            && workspace?.projectId === null;
          out.actionOk = out.finalStateOk;
          return out;
        }

        if (${JSON.stringify(mode)} === 'ignore') {
          out.controlsOk = hasEmpty === false
            && labels.includes('忽略并新建')
            && labels.includes('导入项目');
          buttons.find((button) => buttonText(button) === '忽略并新建')?.click();
          await waitFor(() => !document.querySelector('.import-wizard'));
          await sleep(400);
          const after = await window.api.session.get();
          const workspace = window.__CAPTURE_WORKSPACE_STATE__?.() ?? null;
          out.finalStateOk = after.ok === true
            && after.data === null
            && workspace?.projectId === null;
          out.actionOk = out.finalStateOk;
          return out;
        }

        out.controlsOk = hasEmpty === false
          && selected === 1
          && labels.includes('忽略并新建')
          && labels.includes('导入项目');
        buttons.find((button) => buttonText(button) === '导入项目')?.click();
        await waitFor(() => !document.querySelector('.import-wizard'), 20000);
        let saved = null;
        const sessionDeadline = Date.now() + 20000;
        while (Date.now() < sessionDeadline) {
          const session = await window.api.session.get();
          if (session.ok && session.data?.projectId === expectedProjectId) {
            saved = session;
            break;
          }
          await sleep(100);
        }
        const projects = await window.api.project.list();
        const workspace = window.__CAPTURE_WORKSPACE_STATE__?.() ?? null;
        out.actionOk = Boolean(saved);
        out.finalStateOk = projects.ok === true
          && projects.data.some((project) => project.id === expectedProjectId)
          && workspace?.projectId === expectedProjectId;
        return out;
      } catch (error) {
        out.exception = String(error && error.stack ? error.stack : error);
        return out;
      }
    })()
  `)) as Record<string, any>;
}

async function runDetectChecks(win: BrowserWindow, sourcePath: string): Promise<Record<string, any>> {
  return (await win.webContents.executeJavaScript(`
    (async () => {
      const out = {};
      const options = {
        sensitivity: 0.62,
        minShotSeconds: 0.5,
        filterTransitions: true,
        weights: { s: 0.3, c: 0.3, h: 0.4 },
        intervalMs: 500,
      };
      try {
        const missingProject = await window.api.detect.run({
          projectId: 'no-such-detect-project',
          dryRun: true,
          options,
        });
        out.projectNotFoundOk = missingProject.ok === false
          && missingProject.error.code === 'PROJECT_NOT_FOUND';
        out.projectMessageOk = missingProject.ok === false
          && missingProject.error.message.includes('数据目录已变更')
          && Boolean(missingProject.error.details && missingProject.error.details.guide);

        const broken = await window.api.project.create({
          name: '检测失败素材',
          source: { type: 'local', path: 'D:/__dsh_detect_missing__/missing.mp4' },
        });
        if (!broken.ok) {
          out.createError = broken.error;
          return out;
        }
        out.missingSourceProjectId = broken.data.id;
        const missingSource = await window.api.detect.run({
          projectId: broken.data.id,
          dryRun: true,
          options,
        });
        out.sourceMissingOk = missingSource.ok === false
          && missingSource.error.code === 'DETECT_SOURCE_MISSING';
        out.sourceMessageOk = missingSource.ok === false
          && missingSource.error.message.includes('D:/__dsh_detect_missing__/missing.mp4')
          && Boolean(missingSource.error.details && missingSource.error.details.guide)
          && String(missingSource.error.details.guide).includes('重新导入');
        out.noFramesOk = missingSource.ok === false;

        const urlProject = await window.api.project.create({
          name: '网络检测项目',
          source: {
            type: 'url',
            path: 'D:/__dsh_detect_missing__/network-source.mp4',
            url: 'https://example.invalid/video.mp4',
          },
        });
        if (urlProject.ok) {
          const urlRun = await window.api.detect.run({
            projectId: urlProject.data.id,
            dryRun: true,
            options,
          });
          out.urlOk = urlRun.ok === true && typeof urlRun.data.jobId === 'string';
          if (urlRun.ok) await window.api.detect.cancel({ jobId: urlRun.data.jobId });
        }

        const normalProject = await window.api.project.create({
          name: '正常检测项目',
          source: { type: 'local', path: ${JSON.stringify(sourcePath)} },
        });
        if (normalProject.ok) {
          const normalRun = await window.api.detect.run({
            projectId: normalProject.data.id,
            dryRun: true,
            options,
          });
          out.normalOk = normalRun.ok === true && typeof normalRun.data.jobId === 'string';
          if (normalRun.ok) await window.api.detect.cancel({ jobId: normalRun.data.jobId });
        }
      } catch (error) {
        out.exception = String(error && error.stack ? error.stack : error);
      }
      return out;
    })()
  `)) as Record<string, any>;
}

async function runImportChecks(win: BrowserWindow): Promise<Record<string, any>> {
  return (await win.webContents.executeJavaScript(`
    (async () => {
      const out = {};
      try {
        const scanned = await window.api.data.scanCandidates();
        out.scanOk = scanned.ok === true
          && scanned.data.some((source) => source.projects.length > 0);
        if (!out.scanOk) {
          out.scanResult = scanned;
          return out;
        }
        const source = scanned.data.find((item) => item.projects.length > 0);
        const candidate = source.projects[0];
        out.candidate = candidate;
        const imported = await window.api.data.importProject({
          root: source.root,
          projectId: candidate.id,
        });
        out.importOk = imported.ok === true
          && imported.data.imported === true
          && imported.data.reason === 'imported';
        out.importResult = imported;
        const projects = await window.api.project.list();
        out.listOk = projects.ok === true
          && projects.data.some((project) => project.id === candidate.id);
        const repeated = await window.api.data.importProject({
          root: source.root,
          projectId: candidate.id,
        });
        out.idempotentOk = repeated.ok === true
          && repeated.data.imported === false
          && repeated.data.reason === 'already-exists';
        out.repeated = repeated;
      } catch (error) {
        out.exception = String(error && error.stack ? error.stack : error);
      }
      return out;
    })()
  `)) as Record<string, any>;
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
        stats: window.api.stats,
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

        const smokeTagName = '冒烟标签-' + Date.now();
        const tag = await api.tag.create({ category: '景别', name: smokeTagName, color: '#e11d48' });
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

        const smokeTermName = '冒烟术语-' + Date.now();
        const term = await api.term.create({ term: smokeTermName, definition: '画面的取景范围' });
        out.termCreateOk = term.ok === true;
        const termList = await api.term.list({});
        out.termListOk = termList.ok === true && termList.data.some((item) => item.id === term.data.id);

        const tagStats = await api.stats.tagDistribution({ projectId: project.id });
        out.statsTagOk = tagStats.ok === true
          && tagStats.data.some((item) => item.category === '景别' && item.name === smokeTagName && item.count === 1);
        const rhythmStats = await api.stats.rhythm({ projectId: project.id });
        out.statsRhythmOk = rhythmStats.ok === true
          && rhythmStats.data.length === 2
          && rhythmStats.data[0].durationSeconds === 1.5
          && rhythmStats.data[1].durationSeconds === 1;
        const progressStats = await api.stats.progress({ projectId: project.id });
        out.statsProgressOk = progressStats.ok === true
          && progressStats.data.totalShots === 2
          && progressStats.data.annotatedShots === 1
          && progressStats.data.percent === 50;

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
          out.openTagsOk = openedTags.ok === true
            && openedTags.data.some((item) => item.category === '景别' && item.name === smokeTagName);
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
    playerLayerBottom: result.layerBottomOk === true,
    playerLayerHidden: result.layerHiddenOk === true,
    playerLayerRestore: result.layerRestoreOk === true,
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

        const bottom = await api.setLayer({ level: 'bottom' });
        out.layerBottomOk = bottom.ok === true && bottom.data.layer === 'bottom' && bottom.data.hasFile === true;
        const hidden = await api.setLayer({ level: 'hidden' });
        const hiddenState = await api.getState();
        out.layerHiddenOk = hidden.ok === true
          && hidden.data.layer === 'hidden'
          && hiddenState.ok === true
          && hiddenState.data.hasFile === true;
        const restored = await api.setLayer({ level: 'normal' });
        out.layerRestoreOk = restored.ok === true && restored.data.layer === 'normal';

        return out;
      } catch (error) {
        out.exception = String(error && error.stack ? error.stack : error);
        return out;
      }
    })()
  `;
  return (await win.webContents.executeJavaScript(script)) as Record<string, any>;
}
