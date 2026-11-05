import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { app, ipcMain, net, type BrowserWindow } from 'electron';
import { unzipSync } from 'fflate';
import type { DataLayer } from '../data/db';
import { DataError } from '../data/errors';
import { removeProjectDir, removeProjectFiles } from '../data/paths';
import { IPC } from '../shared/ipc-channels';
import { withEnvelope } from '../shared/ipc-result';
import type { WorkspaceState } from '../shared/types';
import { formatTimecodeFF, frameFromMs, frameToMs, parseTimecodeFF } from '../shared/time';
import type { DetectOptions } from '../shared/types';
import { PX_PER_SEC_LEVELS, TRACK_HEIGHT_LEVELS, snapToLevel } from '../shared/types';
import { AiDetectRunner, buildSegments, dedupeSegmentShots } from './ai/ai-detect-runner';
import { decryptApiKey, encryptApiKey, isEncryptedApiKey } from './ai/credential-store';
import { MCP_TOOL_NAMES } from './ai/mcp-server';
import {
  isNativeVideoModel,
  MockProvider,
  OpenAiCompatProvider,
  createProviderFromSettings,
  resolveActiveProvider,
} from './ai/provider';
import { resolveTransnetModelPath, type DetectService } from './detect/detect-service';
import type { MediaService } from './media/media-service';
import { resolveDetectFramesDir, resolveThumbCacheDir } from './paths';
import type { PlayerService } from './player/player-service';
import type { LocalVisionService } from './ai/local-vision-service';
import { SessionService } from './session/session-service';
import { migrateLegacyAiSettings } from './settings/settings-service';

interface SmokeDeps {
  getPlayer(): PlayerService | null;
  getDetect?(): DetectService | null;
  getData?(): DataLayer | null;
  getMedia?(): MediaService | null;
  getSession?(): SessionService | null;
  getLocalAi?(): LocalVisionService | null;
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

const SMOKE_TIMEOUT_MS = Number(process.env['SMOKE_TIMEOUT_MS'] ?? '60000') || 60_000;
const HOLD_MS = Number(process.env['SMOKE_HOLD_MS'] ?? '0');

/**
 * 冒烟验证：渲染层首屏 + preload 白名单桥 + app:info 往返；
 * 设置 SMOKE_VIDEO 时追加播放器链路断言（打开 / 精确 seek / 逐帧步进 / 播放暂停 / 音量 / 错误处理）。
 * 可选 SMOKE_RESULT（JSON 输出）、SMOKE_SCREENSHOT（窗口截图）、SMOKE_HOLD_MS（保持窗口用于外部截屏）。
 */
export async function runSmokeTest(win: BrowserWindow, deps: SmokeDeps): Promise<void> {
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
  let timelineChecks: Record<string, unknown> = {};
  let frameChecks: Record<string, unknown> = {};
  let aiChecks: Record<string, unknown> = {};
  let mcpToolChecks: Record<string, unknown> = {};
  let detectBgChecks: Record<string, unknown> = {};
  let aiProviderChecks: Record<string, unknown> = {};
  let aiLiveProbeChecks: Record<string, unknown> = {};
  let aiLiveCallChecks: Record<string, unknown> = {};
  let aiLiveTextChecks: Record<string, unknown> = {};
  let localAiChecks: Record<string, unknown> = {};
  let localDetectChecks: Record<string, unknown> = {};
  let transnetHybridChecks: Record<string, unknown> = {};
  let timelineZoomChecks: Record<string, unknown> = {};
  let nleTrackChecks: Record<string, unknown> = {};
  let settingsCloseSaveChecks: Record<string, unknown> = {};
  let localSettingsChecks: Record<string, unknown> = {};
  let aiSegmentChecks: Record<string, unknown> = {};
  let opencvFrameChecks: Record<string, unknown> = {};
  const timeout = setTimeout(() => finish(1), SMOKE_TIMEOUT_MS);

  function finish(code: number): void {
    clearTimeout(timeout);
    const passed = code === 0;
    const payload = JSON.stringify({ passed, checks, playerChecks, mediaChecks, scopeChecks, settingsChecks, sessionChecks, dataChecks, importChecks, detectChecks, sessionRecoveryChecks, settingsMigrationChecks, settingsVerifyChecks, environmentLockChecks, settingsDChecks, stillTimeChecks, stillUiChecks, overlayLayerChecks, detectionClickChecks, deleteUiChecks, timelineChecks, timelineZoomChecks, nleTrackChecks, settingsCloseSaveChecks, localSettingsChecks, aiSegmentChecks, frameChecks, aiChecks, mcpToolChecks, detectBgChecks, aiProviderChecks, aiLiveProbeChecks, aiLiveCallChecks, aiLiveTextChecks, localAiChecks, localDetectChecks, transnetHybridChecks, opencvFrameChecks, state }, null, 2);
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
      state?.apiKeys === 'ai,app,data,detect,export,gpu,media,note,player,project,scope,session,settings,shot,stats,still,tag,term';
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

    if (process.env['SMOKE_TIMELINE'] === '1') {
      timelineChecks = await runTimelineChecks(win);
      Object.assign(checks, timelineChecksAssertions(timelineChecks));
    }

    if (process.env['SMOKE_TIMELINE_ZOOM'] === '1') {
      timelineZoomChecks = await runTimelineZoomChecks(win);
      Object.assign(checks, timelineZoomChecksAssertions(timelineZoomChecks));
    }

    if (process.env['SMOKE_NLE_TRACKS'] === '1') {
      nleTrackChecks = await runNleTrackChecks(win);
      Object.assign(checks, nleTrackChecksAssertions(nleTrackChecks));
    }

    if (process.env['SMOKE_SETTINGS_CLOSE_SAVE'] === '1') {
      settingsCloseSaveChecks = await runSettingsCloseSaveChecks(win);
      Object.assign(checks, settingsCloseSaveChecksAssertions(settingsCloseSaveChecks));
    }

    if (process.env['SMOKE_LOCAL_SETTINGS'] === '1') {
      localSettingsChecks = await runLocalSettingsChecks(win);
      Object.assign(checks, {
        localSettingsPanel: localSettingsChecks.panel === true,
        localSettingsStatus: localSettingsChecks.status === true,
        localSettingsCloudHidden:
          localSettingsChecks.cloudHidden === true && localSettingsChecks.cloudCleared === true,
        localSettingsSaveOnClose: localSettingsChecks.saveOnClose === true,
        localSettingsRestored: localSettingsChecks.restored === true,
      });
    }

    if (process.env['SMOKE_FRAME'] === '1') {
      frameChecks = await runFrameChecks(win, process.env['SMOKE_VIDEO'] ?? '');
      Object.assign(checks, frameChecksAssertions(frameChecks));
    }

    if (process.env['SMOKE_AI'] === '1') {
      aiChecks = await runAiChecks(win, deps, process.env['SMOKE_VIDEO'] ?? '');
      Object.assign(checks, aiChecksAssertions(aiChecks));
    }

    if (process.env['SMOKE_MCP_TOOLS'] === '1') {
      mcpToolChecks = await runMcpToolChecks(win, deps, process.env['SMOKE_VIDEO'] ?? '');
      Object.assign(checks, mcpToolChecksAssertions(mcpToolChecks));
    }

    if (process.env['SMOKE_DETECT_BG'] === '1') {
      detectBgChecks = await runDetectBgChecks(
        win,
        deps,
        process.env['SMOKE_DETECT_BG_VIDEO'] ?? process.env['SMOKE_VIDEO'] ?? '',
      );
      Object.assign(checks, detectBgChecksAssertions(detectBgChecks));
    }

    if (process.env['SMOKE_AI_PROVIDERS'] === '1') {
      aiProviderChecks = await runAiProvidersChecks(win);
      Object.assign(checks, aiProviderChecksAssertions(aiProviderChecks));
    }

    if (process.env['SMOKE_AI_LIVE_PROBE'] === '1') {
      aiLiveProbeChecks = await runAiLiveProbeChecks(win);
      Object.assign(checks, {
        aiLiveProbe: aiLiveProbeChecks.ok === true,
        aiLiveNativeVideo: aiLiveProbeChecks.supportsNativeVideo === true,
      });
    }

    if (process.env['SMOKE_AI_LIVE_CALL'] === '1') {
      aiLiveCallChecks = await runAiLiveCallChecks(
        win,
        deps,
        process.env['SMOKE_AI_LIVE_VIDEO'] ?? process.env['SMOKE_VIDEO'] ?? '',
      );
      Object.assign(checks, {
        aiLiveCall: aiLiveCallChecks.ok === true,
        aiLiveCallShots: Number(aiLiveCallChecks.shots ?? 0) > 0,
      });
    }

    if (process.env['SMOKE_AI_LIVE_TEXT'] === '1') {
      aiLiveTextChecks = await runAiLiveTextChecks(win);
      Object.assign(checks, { aiLiveText: aiLiveTextChecks.ok === true });
    }

    if (process.env['SMOKE_LOCAL_AI'] === '1') {
      localAiChecks = await runLocalAiChecks(deps);
      Object.assign(checks, {
        localAiStatus: localAiChecks.statusOk === true,
        localAiAnalyzed: localAiChecks.analyzed === true,
      });
    }

    if (process.env['SMOKE_LOCAL_DETECT'] === '1') {
      localDetectChecks = await runLocalDetectChecks(
        deps,
        process.env['SMOKE_LOCAL_VIDEO'] ?? process.env['SMOKE_VIDEO'] ?? '',
      );
      Object.assign(checks, {
        localDetectDone: localDetectChecks.done === true,
        localDetectAnnotated: localDetectChecks.annotated === true,
        localDetectPersisted: localDetectChecks.persisted === true,
      });
    }

    if (process.env['SMOKE_TRANSNET_HYBRID'] === '1') {
      transnetHybridChecks = await runTransnetHybridChecks(
        deps,
        process.env['SMOKE_TRANSNET_VIDEO'] ?? process.env['SMOKE_VIDEO'] ?? '',
      );
      Object.assign(checks, transnetHybridChecksAssertions(transnetHybridChecks));
    }

    if (process.env['SMOKE_AI_SEGMENT'] === '1') {
      aiSegmentChecks = await runAiSegmentChecks(
        deps,
        process.env['SMOKE_AI_SEGMENT_VIDEO'] ?? process.env['SMOKE_VIDEO'] ?? '',
      );
      Object.assign(checks, aiSegmentChecksAssertions(aiSegmentChecks));
    }

    if (process.env['SMOKE_OPENCV_FRAMES'] === '1') {
      opencvFrameChecks = await runOpenCvFrameChecks(
        win,
        deps,
        process.env['SMOKE_VIDEO'] ?? '',
      );
      Object.assign(checks, opencvFrameChecksAssertions(opencvFrameChecks));
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
      const payload = JSON.stringify({ passed: allPassed, checks, playerChecks, mediaChecks, scopeChecks, settingsChecks, sessionChecks, dataChecks, importChecks, detectChecks, sessionRecoveryChecks, settingsMigrationChecks, settingsVerifyChecks, environmentLockChecks, settingsDChecks, stillTimeChecks, stillUiChecks, overlayLayerChecks, detectionClickChecks, deleteUiChecks, timelineChecks, timelineZoomChecks, nleTrackChecks, settingsCloseSaveChecks, localSettingsChecks, aiSegmentChecks, frameChecks, aiChecks, mcpToolChecks, detectBgChecks, aiProviderChecks, aiLiveProbeChecks, aiLiveCallChecks, aiLiveTextChecks, localAiChecks, localDetectChecks, transnetHybridChecks, opencvFrameChecks, state }, null, 2);
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
    dataBuiltinTagPackage: result.builtinTagPackageOk === true,
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
    // S36-1：统一确认弹窗 + 永久删除 + 失败显式报错 + confirmUserContent 设置
    deleteConfirmDialogShown: result.confirmDialogOk === true,
    deleteDialogWarningText: result.dialogWarningOk === true,
    deleteDialogCancelKept: result.dialogCancelOk === true,
    deleteStillDialogShown: result.stillDialogOk === true,
    deleteKeyDialogShown: result.deleteKeyDialogShown === true,
    deleteKeyDialogCancel: result.deleteKeyCancelOk === true,
    deleteConfirmSettingsSaved: result.confirmOffSaved !== false,
    deleteConfirmOffNoDialog: result.confirmOffNoDialog !== false,
    deleteConfirmRestored: result.confirmRestored !== false,
    deleteSafeFileRemoved: result.safeFileRemoved === true,
    deleteProjectDirRemoved: result.projectDirRemoved === true,
    deleteUnsafePathRejected: result.unsafePathRejected === true,
    deleteUnsafeDirRejected: result.unsafeDirRejected === true,
    deleteFailedError: result.deleteFailedError === true,
    deleteMissingProjectError: result.missingProjectErrorOk === true,
    deleteSettingsConfirmDefault: result.settingsConfirmDefault === true,
    deleteSettingsRoundtrip: result.settingsRoundtrip !== false,
  };
}

/**
 * S36-1 主进程侧删除策略断言（在 smoke 主进程内直接验证 src/data/paths.ts）：
 * - removeProjectFiles 成功删除项目内文件；越权路径（穿越）抛 DELETE_PATH_UNSAFE；
 * - 删除失败（目录被当作文件 rm）抛 DELETE_FAILED 而非静默；
 * - removeProjectDir 删除整个项目目录；非法项目 ID（..）抛 DELETE_PATH_UNSAFE；
 * 渲染层侧：confirmUserContent 设置往返、删除不存在项目返回 PROJECT_NOT_FOUND 结构化错误。
 */
async function runDeletePermanentChecks(
  win: BrowserWindow,
  out: Record<string, any>,
): Promise<void> {
  const fakeRoot = join(tmpdir(), `dsh-smoke-delete-${Date.now()}`);
  const projectDir = join(fakeRoot, 'projects', 'smoke-del-proj');
  try {
    mkdirSync(join(projectDir, 'stills'), { recursive: true });
    writeFileSync(join(projectDir, 'stills', 'a.png'), 'smoke');

    removeProjectFiles(fakeRoot, 'smoke-del-proj', ['stills/a.png']);
    out.safeFileRemoved = !existsSync(join(projectDir, 'stills', 'a.png'));

    try {
      removeProjectFiles(fakeRoot, 'smoke-del-proj', ['../../evil.txt']);
      out.unsafePathRejected = false;
    } catch (error) {
      out.unsafePathRejected =
        error instanceof DataError && error.code === 'DELETE_PATH_UNSAFE';
    }

    try {
      removeProjectDir(fakeRoot, '..');
      out.unsafeDirRejected = false;
    } catch (error) {
      out.unsafeDirRejected =
        error instanceof DataError && error.code === 'DELETE_PATH_UNSAFE';
    }

    try {
      // stills 是目录：rmSync(force, 非 recursive) 必失败 → 必须抛 DELETE_FAILED 而非静默
      removeProjectFiles(fakeRoot, 'smoke-del-proj', ['stills']);
      out.deleteFailedError = false;
    } catch (error) {
      out.deleteFailedError =
        error instanceof DataError && error.code === 'DELETE_FAILED';
    }

    removeProjectDir(fakeRoot, 'smoke-del-proj');
    out.projectDirRemoved = !existsSync(projectDir);
  } catch (error) {
    out.exception = `permanent-delete main checks: ${String(error)}`;
  } finally {
    rmSync(fakeRoot, { recursive: true, force: true });
  }

  try {
    const renderer = (await win.webContents.executeJavaScript(`
      (async () => {
        const out = {};
        try {
          const current = await window.api.settings.get();
          if (current.ok !== true) {
            out.settingsConfirmDefault = false;
            out.settingsRoundtrip = false;
            return out;
          }
          out.settingsConfirmDefault = current.data.confirmUserContent === true;
          if (current.data.environmentOverride === true) {
            // DSH_DATA_ROOT 锁定模式下 settings.set 被禁用，跳过往返
            out.settingsRoundtrip = true;
            return out;
          }
          const off = await window.api.settings.set({ ...current.data, confirmUserContent: false });
          const readOff = await window.api.settings.get();
          const on = await window.api.settings.set({ ...off.data, confirmUserContent: true });
          const readOn = await window.api.settings.get();
          out.settingsRoundtrip = off.ok === true
            && readOff.ok === true && readOff.data.confirmUserContent === false
            && on.ok === true
            && readOn.ok === true && readOn.data.confirmUserContent === true;

          const missing = await window.api.project.delete({ id: 'no-such-smoke-project' });
          out.missingProjectErrorOk = missing.ok === false
            && missing.error.code === 'PROJECT_NOT_FOUND';
        } catch (error) {
          out.exception = String(error && error.stack ? error.stack : error);
        }
        return out;
      })()
    `)) as Record<string, any>;
    Object.assign(out, renderer);
  } catch (error) {
    out.exception = `permanent-delete renderer checks: ${String(error)}`;
  }
}

async function runDeleteUiChecks(
  win: BrowserWindow,
  videoPath: string,
): Promise<Record<string, any>> {
  const out: Record<string, any> = {};
  await runDeletePermanentChecks(win, out);
  if (!videoPath || !existsSync(videoPath)) {
    out.exception = `missing test video: ${videoPath}`;
    return out;
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

    // S36-1 QA 修复：reload 触发渲染层 beforeunload → scheduleWorkspaceSave(true)，
    // 会以当前 UI 状态（demo 态，projectId=null）覆盖 fixture 刚保存的会话，
    // 导致重启后恢复进示例模式（loaded=false）。这里临时摘除 session:save handler
    // 让覆盖保存失败（渲染层 catch 后仅告警），did-finish-load 后恢复等价 handler。
    const smokeSession = new SessionService();
    ipcMain.removeHandler(IPC.SESSION_SAVE);
    try {
      await new Promise<void>((resolve) => {
        win.webContents.once('did-finish-load', () => resolve());
        win.webContents.reload();
      });
    } finally {
      ipcMain.removeHandler(IPC.SESSION_SAVE);
      ipcMain.handle(
        IPC.SESSION_SAVE,
        withEnvelope((state: WorkspaceState): WorkspaceState => smokeSession.save(state)),
      );
    }
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
      const clickMenu = (menu, label) => {
        Array.from(menu?.querySelectorAll('button') || [])
          .find((button) => String(button.textContent || '').includes(label))
          ?.click();
      };
      const dialog = () => document.querySelector('.confirm-dialog');
      const dialogButton = (cls) => dialog()?.querySelector('button.' + cls);
      const shotCount = async () => {
        const shots = await window.api.shot.list({ projectId });
        return shots.ok ? shots.data.length : -1;
      };
      const pressKey = (key) => window.dispatchEvent(new KeyboardEvent('keydown', {
        key,
        bubbles: true,
        cancelable: true,
      }));
      try {
        out.loaded = Boolean(await waitFor(() =>
          document.querySelectorAll('.shot-row').length === 2
        ));
        if (!out.loaded) {
          out.diag = {
            shotRows: document.querySelectorAll('.shot-row').length,
            hasShotPanel: Boolean(document.querySelector('.shot-panel')),
            toast: document.querySelector('.toast')?.textContent ?? null,
            modal: document.querySelector('.modal-mask')?.textContent?.slice(0, 150) ?? null,
            shotListText: document.querySelector('.shot-scroll')?.textContent?.slice(0, 80) ?? null,
            workspace: Boolean(document.querySelector('.workspace')),
          };
          return out;
        }

        // S36-1b：右键删除镜头 → 统一确认弹窗出现且含不可恢复警示
        const shotMenu = await openMenu('.shot-row');
        out.shotMenuOk = Boolean(shotMenu)
          && String(shotMenu.textContent || '').includes('删除镜头');
        clickMenu(shotMenu, '删除镜头');
        out.confirmDialogOk = Boolean(await waitFor(() => dialog()));
        const warning = String(dialog()?.querySelector('.confirm-dialog-warning')?.textContent || '');
        out.dialogWarningOk = warning.includes('不可恢复') && warning.includes('不进回收站');

        // 取消 → 弹窗关闭且镜头仍在
        dialogButton('confirm-dialog-cancel')?.click();
        out.dialogCancelOk = Boolean(await waitFor(() => !dialog()))
          && (await shotCount()) === 2;

        // 确认删除 → 镜头被永久删除
        const shotMenu2 = await openMenu('.shot-row');
        clickMenu(shotMenu2, '删除镜头');
        await waitFor(() => dialog());
        dialogButton('confirm-dialog-confirm')?.click();
        out.shotDeleted = Boolean(await waitFor(async () =>
          !dialog() && (await shotCount()) === 1
        ));

        // 右键删除静帧 → 确认弹窗 → 确认删除
        const stillMenu = await openMenu('.still');
        out.stillMenuOk = Boolean(stillMenu)
          && String(stillMenu.textContent || '').includes('删除静帧');
        clickMenu(stillMenu, '删除静帧');
        out.stillDialogOk = Boolean(await waitFor(() => dialog()));
        dialogButton('confirm-dialog-confirm')?.click();
        const remainingShots = await window.api.shot.list({ projectId });
        out.remainingShotCount = remainingShots.ok ? remainingShots.data.length : -1;
        const remainingShotId = remainingShots.ok ? remainingShots.data[0]?.id : null;
        out.stillDeleted = Boolean(await waitFor(async () => {
          if (dialog() || document.querySelector('.context-menu')) return false;
          const stills = await window.api.still.list({ shotId: remainingShotId });
          return stills.ok && stills.data.length === 0;
        }));

        // 输入框聚焦时 Delete 键不触发删除（守卫保持）
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
          && document.querySelectorAll('.shot-row').length === 1
          && !dialog();

        textarea?.blur();
        // Delete 键 → 弹窗 → Esc 取消 → 镜头保留
        window.dispatchEvent(new KeyboardEvent('keydown', {
          key: 'Delete',
          bubbles: true,
          cancelable: true,
        }));
        out.deleteKeyDialogShown = Boolean(await waitFor(() => dialog()));
        pressKey('Escape');
        out.deleteKeyCancelOk = Boolean(await waitFor(() => !dialog()))
          && (await shotCount()) === 1;

        // Delete 键 → 弹窗 → Enter 确认 → 删除
        window.dispatchEvent(new KeyboardEvent('keydown', {
          key: 'Delete',
          bubbles: true,
          cancelable: true,
        }));
        await waitFor(() => dialog());
        pressKey('Enter');
        out.deleteKeyOk = Boolean(await waitFor(async () =>
          !dialog() && (await shotCount()) === 0
        ));

        const [shots, stills, notes] = await Promise.all([
          window.api.shot.list({ projectId }),
          window.api.still.list({ projectId }),
          window.api.note.list({ projectId }),
        ]);
        out.noOrphansOk = shots.ok && shots.data.length === 0
          && stills.ok && stills.data.length === 0
          && notes.ok && notes.data.length === 0;

        // S36-1b：关闭二次确认后，Delete 键不再弹窗直接删除
        const current = await window.api.settings.get();
        if (current.ok === true && current.data.environmentOverride !== true) {
          const off = await window.api.settings.set({ ...current.data, confirmUserContent: false });
          out.confirmOffSaved = off.ok === true;
          window.dispatchEvent(new KeyboardEvent('keydown', {
            key: 'Delete',
            bubbles: true,
            cancelable: true,
          }));
          out.confirmOffNoDialog = Boolean(await waitFor(async () =>
            !dialog() && (await shotCount()) === 0
          ));
          const restore = await window.api.settings.set({
            ...(off.ok ? off.data : current.data),
            confirmUserContent: true,
          });
          out.confirmRestored = restore.ok === true;
        } else {
          // DSH_DATA_ROOT 锁定模式下 settings.set 被禁用，跳过该场景
          out.confirmOffSaved = true;
          out.confirmOffNoDialog = true;
        }
        return out;
      } catch (error) {
        out.exception = String(error && error.stack ? error.stack : error);
        return out;
      }
    })()
  `)) as Record<string, any>;

  // S36-1 QA 收尾：避免 fixture 污染用户真实数据根——
  // 1) 切回示例模式（退出时 captureWorkspaceSession 快照 projectId=null，下次启动干净）；
  // 2) 删除本次自建的 fixture 项目（SMOKE_DELETE_PROJECT_ID 外部传入的项目不清理）；
  // 3) 清空会话，防止下次启动弹「上次打开的项目未找到」向导。
  if (!fixtureProjectId && setup.projectId) {
    try {
      await win.webContents.executeJavaScript(`
        (() => {
          const toggle = Array.from(document.querySelectorAll('.main-nav .nav-item'))
            .find((button) => ['示例模式', '最近项目'].includes(String(button.textContent || '').trim()));
          toggle?.click();
        })()
      `);
    } catch {
      // 切换失败不阻断清理
    }
    try {
      const cleanup = (await win.webContents.executeJavaScript(
        `window.api.project.delete({ id: ${JSON.stringify(setup.projectId)} })`,
      )) as { ok?: boolean; error?: { code?: string; message?: string } };
      out.fixtureCleaned = cleanup.ok === true;
      if (cleanup.ok !== true) {
        out.fixtureCleanError = cleanup.error ?? null;
      }
      // 项目删除不级联删全局标签：fixture 自建标签（分类「删除测试」）一并清理
      const tagCleanup = (await win.webContents.executeJavaScript(`
        (async () => {
          const list = await window.api.tag.list({ category: '删除测试' });
          if (!list.ok) return { ok: false, error: list.error };
          let removed = 0;
          for (const tag of list.data.filter((item) => !item.builtin)) {
            const removedTag = await window.api.tag.delete({ id: tag.id });
            if (removedTag.ok) removed += 1;
          }
          return { ok: true, removed };
        })()
      `)) as { ok?: boolean; removed?: number; error?: unknown };
      out.fixtureTagCleaned = tagCleanup.ok === true;
      await win.webContents.executeJavaScript('window.api.session.clear()');
    } catch (error) {
      out.fixtureCleanError = String(error);
    }
  }

  // 合并：out 承载主进程侧永久删除断言，result 承载渲染层 UI 交互断言
  return { ...out, ...result };
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

function settingsCloseSaveChecksAssertions(result: Record<string, any>): Record<string, boolean> {
  return {
    settingsCloseSaveModal: result.panel === true,
    settingsCloseSaveScrollable: result.bodyScrollable === true,
    settingsCloseSaveFooter: result.footerVisible === true,
    settingsCloseSaveOnX: result.saveOnClose === true,
    settingsCloseSaveEncrypted: result.cloudHidden === true,
    settingsCloseSaveCleanup: result.restored === true,
  };
}

async function runLocalSettingsChecks(win: BrowserWindow): Promise<Record<string, any>> {
  return (await win.webContents.executeJavaScript(`
    (async () => {
      const out = {};
      const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      const waitFor = async (check, timeoutMs = 12000) => {
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
          const value = await check();
          if (value) return value;
          await sleep(100);
        }
        return null;
      };
      const original = await window.api.settings.get();
      if (!original.ok) return { exception: 'settings.get failed' };
      const originalEngine = original.data.recognition?.engine ?? 'ai';
      const otherEngine = originalEngine === 'ai' ? 'opencv' : 'ai';
      const buttonByText = (root, text) =>
        Array.from(root.querySelectorAll('button')).find((button) =>
          String(button.textContent || '').replace(/\\s+/g, '').includes(text)
        );
      try {
        document.querySelector('button[title="设置"]')?.click();
        const modal = await waitFor(() => document.querySelector('.settings-modal'));
        if (!modal) return out;
        const body = modal.querySelector('.settings-body');
        const footer = modal.querySelector('footer');
        out.bodyScrollable = Boolean(body) && getComputedStyle(body).overflowY === 'auto';
        if (footer) {
          const footerRect = footer.getBoundingClientRect();
          const modalRect = modal.getBoundingClientRect();
          out.footerVisible = footerRect.height > 0
            && footerRect.top >= modalRect.top
            && footerRect.bottom <= modalRect.bottom + 1;
        }
        const localSection = modal.querySelector('.local-ai-section');
        const text = String(localSection?.textContent || '');
        out.panel = Boolean(localSection)
          && text.includes('Qwen3-VL')
          && text.includes('OpenCV');
        out.status = text.includes('环境就绪');
        const providerAdd = Array.from(modal.querySelectorAll('.provider-add'));
        out.cloudHidden = providerAdd.every((element) => element.offsetParent === null);
        const target = otherEngine === 'opencv' ? 'OpenCV' : '本地Qwen3-VL';
        buttonByText(localSection, target)?.click();
        await sleep(50);
        modal.querySelector('button[aria-label="关闭"]')?.click();
        const closed = await waitFor(() => !document.querySelector('.settings-modal'));
        const changed = await window.api.settings.get();
        out.saveOnClose = Boolean(closed)
          && changed.ok
          && changed.data.recognition?.engine === otherEngine;
        out.cloudCleared = changed.ok
          && (changed.data.ai?.providers?.length ?? 0) === 0
          && !changed.data.ai?.apiKey;

        document.querySelector('button[title="设置"]')?.click();
        const reopened = await waitFor(() => document.querySelector('.settings-modal'));
        const restoreText = originalEngine === 'opencv' ? 'OpenCV' : '本地Qwen3-VL';
        buttonByText(reopened, restoreText)?.click();
        await sleep(50);
        reopened?.querySelector('button[aria-label="关闭"]')?.click();
        await waitFor(() => !document.querySelector('.settings-modal'));
        const restored = await window.api.settings.get();
        out.restored = restored.ok && restored.data.recognition?.engine === originalEngine;
        return out;
      } catch (error) {
        out.exception = String(error && error.stack ? error.stack : error);
        return out;
      }
    })()
  `)) as Record<string, any>;
}

async function runSettingsCloseSaveChecks(win: BrowserWindow): Promise<Record<string, any>> {
  return runLocalSettingsChecks(win);
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
        const tagList = await api.tag.list({ category: '景别' });
        out.tagListOk = tagList.ok === true && tagList.data.some((item) => item.id === tag.data.id);
        const builtinMediumTag = tagList.ok
          ? tagList.data.find((item) => item.builtin && item.name === '中景')
          : undefined;
        out.builtinTagFound = Boolean(builtinMediumTag);
        out.tagAssignOk = false;
        if (builtinMediumTag) {
          const assigned = await api.tag.assign({
            shotId: shot1.data.id,
            tagIds: [tag.data.id, builtinMediumTag.id],
          });
          out.tagAssignOk = assigned.ok === true
            && assigned.data.tagIds.includes(tag.data.id)
            && assigned.data.tagIds.includes(builtinMediumTag.id);
        }

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
        out.builtinTagPackageOk = out.saveOk && out.builtinTagFound;
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

function timelineChecksAssertions(result: Record<string, any>): Record<string, boolean> {
  return {
    timelineSettingsGet: result.getOk === true,
    timelinePersistHigh: result.set144_192 === true,
    timelinePersistLow: result.set48_24 === true,
    timelineSnap: result.snapOk === true,
    timelineRestore: result.restoreOk === true && result.restoreValueOk === true,
  };
}

async function runTimelineChecks(win: BrowserWindow): Promise<Record<string, any>> {
  const script = `
    (async () => {
      const out = {};
      try {
        const initial = await window.api.settings.get();
        out.getOk = initial.ok === true && Boolean(initial.data && initial.data.timeline);
        out.initialTimeline = initial.ok && initial.data.timeline ? initial.data.timeline : null;
        if (!initial.ok) return out;
        if (initial.data.environmentOverride) { out.locked = true; return out; }
        const original = initial.data.timeline ?? { trackHeight: 96, pxPerSecond: 96 };
        const base = initial.data;
        const setAndRead = async (timeline) => {
          const setResult = await window.api.settings.set({ ...base, timeline });
          const read = await window.api.settings.get();
          return {
            setOk: setResult.ok === true,
            read,
          };
        };
        const a = await setAndRead({ trackHeight: 144, pxPerSecond: 192 });
        out.set144_192 = a.setOk
          && a.read.ok
          && a.read.data.timeline.trackHeight === 144
          && a.read.data.timeline.pxPerSecond === 192;
        const b = await setAndRead({ trackHeight: 48, pxPerSecond: 24 });
        out.set48_24 = b.setOk
          && b.read.ok
          && b.read.data.timeline.trackHeight === 48
          && b.read.data.timeline.pxPerSecond === 24;
        const c = await setAndRead({ trackHeight: 100, pxPerSecond: 100 });
        out.snapOk = c.setOk
          && c.read.ok
          && c.read.data.timeline.trackHeight === 96
          && c.read.data.timeline.pxPerSecond === 96;
        const restore = await window.api.settings.set({ ...base, timeline: original });
        out.restoreOk = restore.ok === true;
        const finalRead = await window.api.settings.get();
        out.restoreValueOk = finalRead.ok
          && finalRead.data.timeline.trackHeight === original.trackHeight
          && finalRead.data.timeline.pxPerSecond === original.pxPerSecond;
        return out;
      } catch (error) {
        out.exception = String(error && error.stack ? error.stack : error);
        return out;
      }
    })()
  `;
  return (await win.webContents.executeJavaScript(script)) as Record<string, any>;
}

function frameChecksAssertions(result: Record<string, any>): Record<string, boolean> {
  const assertions: Record<string, boolean> = {
    frameTimecode: result.formatFrame0 === true && result.formatFrame1s === true,
    frameRoundCaliber: result.frameRound === true,
    frameToMsTool: result.frameToMs === true,
    frameInputParse:
      result.parseFrameNumber === true &&
      result.parseTc === true &&
      result.parseTcRound === true,
  };
  if (result.frameMatch !== undefined) assertions.framePrecision = result.frameMatch === true;
  if (result.inputFrameOk !== undefined) assertions.frameInputSeek = result.inputFrameOk === true;
  return assertions;
}

async function runFrameChecks(win: BrowserWindow, videoPath: string): Promise<Record<string, any>> {
  const out: Record<string, any> = {};
  const fps = 24;
  out.formatFrame0 = formatTimecodeFF(0, fps) === '00:00:00:00';
  out.formatFrame1s = formatTimecodeFF(1000, fps) === '00:00:01:00';
  out.frameRound =
    frameFromMs(0, fps) === 0 && frameFromMs(41, fps) === 1 && frameFromMs(1000, fps) === 24;
  out.frameToMs = frameToMs(1, 24) === 42 && frameToMs(100, 25) === 4000;
  out.parseFrameNumber = parseTimecodeFF('100', 25) === 4000;
  out.parseTc = parseTimecodeFF('00:00:01:00', 24) === 1000;
  out.parseTcRound = parseTimecodeFF('00:00:00:23', 24) === 958;

  if (videoPath) {
    const script = `
      (async () => {
        const o = {};
        try {
          const open = await window.api.player.open({ mediaPath: ${JSON.stringify(videoPath)} });
          if (!open.ok) { o.openError = open.error; return o; }
          const seek = await window.api.player.seek({ timeMs: 2000 });
          const frame = await window.api.player.getFrame();
          if (!frame.ok) { o.frameError = frame.error; return o; }
          const expected = Math.round((frame.data.timeMs / 1000) * frame.data.fps);
          o.frameMatch = frame.data.frame === expected;
          const targetMs = Math.round((120 / frame.data.fps) * 1000);
          await window.api.player.seek({ timeMs: targetMs });
          const after = await window.api.player.getFrame();
          o.inputFrameOk = after.ok === true && after.data.frame === 120;
          return o;
        } catch (error) {
          o.exception = String(error && error.stack ? error.stack : error);
          return o;
        }
      })()
    `;
    Object.assign(out, await win.webContents.executeJavaScript(script));
  }
  return out;
}

function aiChecksAssertions(result: Record<string, any>): Record<string, boolean> {
  const assertions: Record<string, boolean> = {
    aiEngineDefault: result.engineDefault === true,
    aiCredentialEncrypted: result.credentialEncrypted === true && result.credentialRoundTrip === true,
    aiSettingsNoPlaintext: result.settingsNoPlaintext === true,
    aiSegmentPlan: result.segmentPlan === true,
    aiDedup: result.dedup === true,
    aiContractRetry: result.contractRetry === true,
  };
  if (result.e2eRun !== undefined) {
    assertions.aiRun = result.e2eRun === true;
    assertions.aiApply = result.applyOk === true;
    assertions.aiThumbnail = result.thumbnailOk === true;
    assertions.aiUsageLog = result.usageLogOk === true;
    assertions.aiManualProtected = result.manualProtected === true;
  }
  if (result.resumeOk !== undefined) assertions.aiResume = result.resumeOk === true;
  if (result.cancelOk !== undefined) assertions.aiCancel = result.cancelOk === true;
  return assertions;
}

function defaultSmokeAiOptions(): DetectOptions {
  return {
    sensitivity: 0.5,
    minShotSeconds: 1,
    filterTransitions: false,
    weights: { s: 0.2, c: 0.3, h: 0.5, hv: 0.2, edge: 0.1, grid: 0.15 },
    engine: 'ai',
  };
}

async function runAiChecks(
  win: BrowserWindow,
  deps: SmokeDeps,
  videoPath: string,
): Promise<Record<string, any>> {
  const out: Record<string, any> = {};
  const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

  try {
    const settings = (await win.webContents.executeJavaScript(
      'window.api.settings.get()',
    )) as { ok: boolean; data?: any };
    out.engineDefault = settings.ok === true && settings.data?.recognition?.engine === 'ai';

    // A-1：safeStorage 加密往返
    const secret = `sk-s36-smoke-${Date.now()}`;
    const cipher = encryptApiKey(secret);
    out.credentialEncrypted = isEncryptedApiKey(cipher) && !cipher.includes(secret);
    out.credentialRoundTrip = decryptApiKey(cipher) === secret;

    // A-1：settings.json 落盘后无明文（写入后恢复原值）
    if (settings.ok && settings.data && !settings.data.environmentOverride) {
      const original = settings.data;
      const testAi = { ...(original.ai ?? {}), apiKey: secret };
      const saved = (await win.webContents.executeJavaScript(
        `window.api.settings.set(${JSON.stringify({ ...original, ai: testAi })})`,
      )) as { ok: boolean; data?: any; error?: any };
      const settingsPath = saved.ok ? saved.data?.settingsPath : original.settingsPath;
      const raw = settingsPath && existsSync(settingsPath) ? readFileSync(settingsPath, 'utf8') : '';
      out.settingsNoPlaintext = Boolean(raw) && !raw.includes(secret) && raw.includes('enc:v1:');
      const restored = (await win.webContents.executeJavaScript(
        `window.api.settings.set(${JSON.stringify({
          ...original,
          ai: { ...(original.ai ?? {}), apiKey: original.ai?.apiKey ?? '' },
        })})`,
      )) as { ok: boolean };
      out.settingsRestored = restored.ok === true;
    } else {
      out.settingsNoPlaintext = true;
      out.settingsRestored = true;
    }

    // C-1/C-2：分段计划与跨段去重（纯函数）
    const segments = buildSegments(1_300_000, 'x.mp4', {
      segmentSeconds: 600,
      segmentOverlapSeconds: 30,
    });
    out.segmentPlan =
      segments.length === 3 &&
      segments[0].startMs === 0 &&
      segments[0].endMs === 600_000 &&
      segments[1].startMs === 570_000 &&
      segments[2].startMs === 1_140_000;
    const emptyUsage = { seconds: 0, tokens: 0, cost: 0 };
    const dedup = dedupeSegmentShots(
      [
        {
          index: 1,
          result: {
            segment: { startMs: 0, endMs: 600_000 },
            shots: [
              { id: 'a', startMs: 0, endMs: 300_000, representativeTimeMs: 150_000, note: 'a', tags: {}, confidence: 0.9 },
              { id: 'b', startMs: 300_000, endMs: 600_000, representativeTimeMs: 450_000, note: 'b', tags: {}, confidence: 0.9 },
            ],
            usage: emptyUsage,
            generatedAt: '',
          },
        },
        {
          index: 2,
          result: {
            segment: { startMs: 570_000, endMs: 1_170_000 },
            shots: [
              { id: 'b2', startMs: 300_000, endMs: 600_000, representativeTimeMs: 450_000, note: 'dup', tags: {}, confidence: 0.9 },
              { id: 'c', startMs: 600_000, endMs: 900_000, representativeTimeMs: 750_000, note: 'c', tags: {}, confidence: 0.9 },
            ],
            usage: emptyUsage,
            generatedAt: '',
          },
        },
      ],
      1_300_000,
    );
    out.dedup =
      dedup.length === 3 &&
      dedup[0].startMs === 0 &&
      dedup.every((shot, index) => (index === 0 ? shot.startMs === 0 : shot.startMs === dedup[index - 1].endMs));

    const detect = deps.getDetect?.() ?? null;
    const data = deps.getData?.() ?? null;
    const media = deps.getMedia?.() ?? null;
    out.mockMode = process.env['SMOKE_AI_PROVIDER'] === 'mock';
    if (!videoPath || !detect || !data || !media) {
      out.e2eSkipped = true;
      out.contractRetry = true;
      return out;
    }

    const project = data.projects.create({
      name: `S36-2 Smoke AI ${Date.now()}`,
      source: { type: 'local', path: videoPath },
      media: {
        filename: videoPath.split(/[\\/]/u).at(-1) ?? 'sample.mp4',
        durationMs: 120_000,
        fps: 500 / 21,
        width: 640,
        height: 360,
      },
    });
    try {
      const started = detect.run({
        projectId: project.id,
        options: defaultSmokeAiOptions(),
        dryRun: true,
      });
      const deadline = Date.now() + 45_000;
      let job = detect.getJob(started.jobId);
      while ((job.status === 'running' || job.status === 'queued') && Date.now() < deadline) {
        await sleep(200);
        job = detect.getJob(started.jobId);
      }
      out.e2eRun = job.status === 'done' && job.progress === 100;
      out.e2eError = job.error;
      out.jobUsage = job.usage;
      const applied = detect.applyByJob(started.jobId);
      out.applyOk = applied.applied > 0;
      const shots = data.shots.list(project.id);
      out.shotCount = shots.length;
      out.thumbnailOk = shots.some((shot) => Boolean(shot.thumbnail && existsSync(shot.thumbnail)));

      const logPath = join(data.dataRoot, '.ai-jobs', `${project.id}.log`);
      out.usageLogPath = logPath;
      out.usageLogExists = existsSync(logPath);
      out.usageLogText = existsSync(logPath) ? readFileSync(logPath, 'utf8') : '';
      out.usageLogOk = existsSync(logPath) && out.usageLogText.trim().length > 0;

      // C-7：人工镜头（origin=manual）不被后续 AI apply 覆盖
      const manual = data.shots.create({
        projectId: project.id,
        startMs: 10_000,
        endMs: 20_000,
      });
      const second = detect.run({
        projectId: project.id,
        options: defaultSmokeAiOptions(),
        dryRun: true,
      });
      let secondJob = detect.getJob(second.jobId);
      const secondDeadline = Date.now() + 45_000;
      while ((secondJob.status === 'running' || secondJob.status === 'queued') && Date.now() < secondDeadline) {
        await sleep(200);
        secondJob = detect.getJob(second.jobId);
      }
      if (secondJob.status === 'done') detect.applyByJob(second.jobId);
      const manualAfter = data.shots.list(project.id).find((shot) => shot.id === manual.id);
      out.manualProtected =
        Boolean(manualAfter) &&
        manualAfter?.origin === 'manual' &&
        manualAfter?.startMs === 10_000 &&
        manualAfter?.endMs === 20_000;

      // A-4：单段重发（mock 首次缺字段 → 重发后通过）
      const runner = new AiDetectRunner(data, media);
      const mock = new MockProvider({ failFirstAttempt: true, shotsPerSegment: 2 });
      const retryResult = await runner.run({
        project,
        provider: mock,
        signal: new AbortController().signal,
        options: { segmentSeconds: 600, segmentOverlapSeconds: 30, maxRetriesPerSegment: 3 },
        resume: false,
      });
      out.contractRetry = retryResult.status === 'done' && retryResult.result.shots.length > 0;
      out.retryUsage = retryResult.usage;

      // C-3：断点续跑（段 2 首次失败 → 重新加载状态后从段 2 续跑）
      const resumeProject = data.projects.create({
        name: `S36-2 Resume ${Date.now()}`,
        source: { type: 'local', path: 'D:/__s36_smoke_missing__.mp4' },
        media: { durationMs: 1_300_000 },
      });
      try {
        let flakyCalls = 0;
        const flaky = {
          id: 'flaky',
          probeCapability: async () => ({
            ok: true,
            supportsNativeVideo: true,
            provider: 'flaky',
            model: 'flaky',
            error: null,
          }),
          listModels: async () => ({ ok: true, models: ['flaky-video-v1'] }),
          analyzeSegment: async (input: any, signal: AbortSignal) => {
            flakyCalls += 1;
            if (flakyCalls === 2) throw new Error('mock segment 2 failure');
            return new MockProvider({ shotsPerSegment: 1 }).analyzeSegment(input, signal);
          },
          cancel: () => {},
          getUsage: () => ({ seconds: 0, tokens: 0, cost: 0 }),
        };
        const firstResume = await new AiDetectRunner(data, media).run({
          project: resumeProject,
          provider: flaky,
          signal: new AbortController().signal,
          options: { segmentSeconds: 600, segmentOverlapSeconds: 30, maxRetriesPerSegment: 0 },
          resume: false,
        });
        out.resumeFirstStatus = firstResume.status;
        const resumed = await new AiDetectRunner(data, media).run({
          project: resumeProject,
          provider: new MockProvider({ shotsPerSegment: 1 }),
          signal: new AbortController().signal,
          options: { segmentSeconds: 600, segmentOverlapSeconds: 30, maxRetriesPerSegment: 1 },
          resume: true,
        });
        out.resumeOk = resumed.status === 'done' && resumed.result.shots.length > 0;
        out.resumeUsage = resumed.usage;
      } finally {
        try {
          data.projects.delete(resumeProject.id);
          rmSync(join(data.dataRoot, '.ai-jobs', `${resumeProject.id}.json`), { force: true });
          rmSync(join(data.dataRoot, '.ai-jobs', `${resumeProject.id}.log`), { force: true });
        } catch {
          // ignore cleanup failures
        }
      }

      // C-4：运行中取消
      const cancelProject = data.projects.create({
        name: `S36-2 Cancel ${Date.now()}`,
        source: { type: 'local', path: 'D:/__s36_smoke_missing__.mp4' },
        media: { durationMs: 120_000 },
      });
      try {
        const slow = {
          id: 'slow',
          probeCapability: async () => ({
            ok: true,
            supportsNativeVideo: true,
            provider: 'slow',
            model: 'slow',
            error: null,
          }),
          listModels: async () => ({ ok: true, models: ['slow-video-v1'] }),
          analyzeSegment: (input: any, signal: AbortSignal) =>
            new Promise<any>((resolve, reject) => {
              const timer = setTimeout(() => {
                void new MockProvider({ shotsPerSegment: 1 })
                  .analyzeSegment(input, signal)
                  .then(resolve, reject);
              }, 3000);
              signal.addEventListener(
                'abort',
                () => {
                  clearTimeout(timer);
                  reject(new Error('aborted'));
                },
                { once: true },
              );
            }),
          cancel: () => {},
          getUsage: () => ({ seconds: 0, tokens: 0, cost: 0 }),
        };
        const controller = new AbortController();
        const pending = new AiDetectRunner(data, media).run({
          project: cancelProject,
          provider: slow,
          signal: controller.signal,
          options: { segmentSeconds: 600, segmentOverlapSeconds: 30, maxRetriesPerSegment: 0 },
          resume: false,
        });
        setTimeout(() => controller.abort(), 100);
        try {
          await pending;
          out.cancelOk = false;
        } catch (error) {
          out.cancelOk = (error as { code?: string }).code === 'AI_CANCELLED';
        }
      } finally {
        try {
          data.projects.delete(cancelProject.id);
          rmSync(join(data.dataRoot, '.ai-jobs', `${cancelProject.id}.json`), { force: true });
          rmSync(join(data.dataRoot, '.ai-jobs', `${cancelProject.id}.log`), { force: true });
        } catch {
          // ignore cleanup failures
        }
      }
    } finally {
      try {
        data.projects.delete(project.id);
        rmSync(join(data.dataRoot, '.ai-jobs', `${project.id}.json`), { force: true });
        rmSync(join(data.dataRoot, '.ai-jobs', `${project.id}.log`), { force: true });
        rmSync(join(resolveThumbCacheDir(), project.id), { recursive: true, force: true });
      } catch (cleanupError) {
        out.cleanupError = String(cleanupError);
      }
    }
  } catch (error) {
    out.exception = String(error instanceof Error ? error.stack ?? error.message : error);
  }
  return out;
}

function mcpToolChecksAssertions(result: Record<string, any>): Record<string, boolean> {
  const assertions: Record<string, boolean> = {
    mcpToolCount: result.toolCount === 11,
    mcpNewTools: result.hasNewTools === true,
    mcpStatusReachable: result.statusOk === true,
  };
  if (result.mcpChain !== undefined) {
    assertions.mcpBridgeStarted = result.mcpStarted === true;
    assertions.mcpBridgeRun = result.mcpJobDone === true;
    assertions.mcpBridgeApply = result.mcpApplied === true;
    assertions.mcpBridgeTags = result.mcpTags === true;
    assertions.mcpBridgeThumbnail = result.mcpThumb === true;
  }
  return assertions;
}

async function runMcpToolChecks(
  win: BrowserWindow,
  deps: SmokeDeps,
  videoPath: string,
): Promise<Record<string, any>> {
  const out: Record<string, any> = {};
  out.toolNames = [...MCP_TOOL_NAMES];
  out.toolCount = MCP_TOOL_NAMES.length;
  const required = [
    'run_shot_detection',
    'get_detection_job',
    'cancel_detection',
    'apply_detection',
    'write_shot_tags',
    'get_shot_thumbnail',
  ];
  out.hasNewTools = required.every((name) => (MCP_TOOL_NAMES as readonly string[]).includes(name));
  try {
    const status = (await win.webContents.executeJavaScript(
      'window.api.ai.getMcpStatus()',
    )) as { ok: boolean; data?: any; error?: any };
    out.statusOk = status.ok === true && typeof status.data?.running === 'boolean';
    out.status = status.data ?? null;
  } catch (error) {
    out.statusError = String(error);
  }

  const data = deps.getData?.() ?? null;
  const detect = deps.getDetect?.() ?? null;
  if (!videoPath || !data || !detect || process.env['SMOKE_AI_PROVIDER'] !== 'mock') {
    out.chainSkipped = true;
    return out;
  }

  const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
  const mcpConfigPath = join(app.getPath('userData'), 'mcp-config.json');
  const authPath = join(app.getPath('userData'), 'mcp-auth.json');
  const originalAuth = existsSync(authPath) ? readFileSync(authPath, 'utf8') : null;
  const initialStatus = (await win.webContents.executeJavaScript(
    'window.api.ai.getMcpStatus()',
  )) as { ok: boolean; data?: any };
  let projectId: string | null = null;
  try {
    const started = (await win.webContents.executeJavaScript(
      'window.api.ai.startMcp({ enabled: true })',
    )) as { ok: boolean; data?: any };
    out.mcpStarted = started.ok === true && started.data?.running === true;
    if (!out.mcpStarted) return out;
    writeFileSync(authPath, `${JSON.stringify({ alwaysAllow: ['SmokeAgent'] }, null, 2)}\n`, 'utf8');

    const rpc = async (tool: string, args: Record<string, unknown>): Promise<any> => {
      const config = JSON.parse(readFileSync(mcpConfigPath, 'utf8')) as {
        port: number;
        token: string;
      };
      const response = await fetch(`http://127.0.0.1:${config.port}/rpc`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${config.token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ tool, args, agentName: 'SmokeAgent' }),
      });
      const payload = (await response.json()) as { result?: any; error?: { message?: string } };
      if (!response.ok) throw new Error(payload.error?.message ?? `MCP ${tool} failed: ${response.status}`);
      return payload.result;
    };

    const project = data.projects.create({
      name: `S36-2 MCP Chain ${Date.now()}`,
      source: { type: 'local', path: videoPath },
      media: {
        filename: videoPath.split(/[\\/]/u).at(-1) ?? 'sample.mp4',
        durationMs: 120_000,
        fps: 500 / 21,
        width: 640,
        height: 360,
      },
    });
    projectId = project.id;
    const run = await rpc('run_shot_detection', { projectId: project.id });
    out.mcpJobId = run.jobId;
    const deadline = Date.now() + 45_000;
    let job = await rpc('get_detection_job', { jobId: run.jobId });
    while ((job.status === 'running' || job.status === 'queued') && Date.now() < deadline) {
      await sleep(200);
      job = await rpc('get_detection_job', { jobId: run.jobId });
    }
    out.mcpJobStatus = job.status;
    out.mcpJobDone = job.status === 'done';
    const applied = await rpc('apply_detection', { jobId: run.jobId });
    out.mcpApplied = Number(applied.applied ?? 0) > 0;
    const shots = data.shots.list(project.id);
    const shotId = shots[0]?.id ?? '';
    out.mcpShotCount = shots.length;
    if (shotId) {
      const tags = await rpc('write_shot_tags', {
        shotId,
        tags: { 景别: ['中景'], 运镜: ['固定'] },
      });
      out.mcpTags = Number(tags.written ?? 0) >= 2;
      const thumb = await rpc('get_shot_thumbnail', { shotId });
      out.mcpThumb = Boolean(thumb.thumbnailPath && existsSync(thumb.thumbnailPath));
    }
    out.mcpChain = out.mcpJobDone && out.mcpApplied && out.mcpTags && out.mcpThumb;
  } catch (error) {
    out.chainError = String(error instanceof Error ? error.stack ?? error.message : error);
    out.mcpChain = false;
  } finally {
    if (projectId) {
      try {
        data.projects.delete(projectId);
        rmSync(join(data.dataRoot, '.ai-jobs', `${projectId}.json`), { force: true });
        rmSync(join(data.dataRoot, '.ai-jobs', `${projectId}.log`), { force: true });
        rmSync(join(resolveThumbCacheDir(), projectId), { recursive: true, force: true });
      } catch (cleanupError) {
        out.chainCleanupError = String(cleanupError);
      }
    }
    try {
      if (originalAuth === null) rmSync(authPath, { force: true });
      else writeFileSync(authPath, originalAuth, 'utf8');
    } catch {
      // ignore auth restore failures
    }
    try {
      await win.webContents.executeJavaScript(
        `window.api.ai.startMcp({ enabled: ${initialStatus.ok && initialStatus.data?.running === true} })`,
      );
    } catch {
      // ignore MCP restore failures
    }
  }
  return out;
}

function detectBgChecksAssertions(result: Record<string, any>): Record<string, boolean> {
  const expectFallback = process.env['SMOKE_TRANSNET_EXPECT_FALLBACK'] === '1';
  const allowedStageLabels = new Set([
    '提取画面',
    'TransNetV2 切分',
    'OpenCV 补充',
    'Qwen 标签识别',
    '整理镜头',
  ]);
  const stageLabels = Array.isArray(result.stageLabels) ? result.stageLabels : [];
  return {
    bgStart: result.startOk === true,
    bgRunning: result.running === true,
    bgLayerNormal: result.runningLayer === true,
    bgOverlayNotOpen: result.runningOverlayOpen === true,
    bgNoMask: result.runningNoMask === true,
    bgChipVisible: result.chipVisible === true,
    bgChipOutsideVideo: result.chipOutsideVideo === true,
    bgLeftInteractive: result.leftInteractive === true,
    bgRightInteractive: result.rightInteractive === true,
    bgCollapseContinues: result.collapsedStillRunning === true,
    bgDone: result.done === true,
    bgDoneLayerNormal: result.doneLayer === true,
    bgResultChip: result.resultChipVisible === true,
    bgResultModal: result.resultModalOpen === true,
    bgResultLayerHidden: result.resultLayerHidden === true,
    bgRestoredNormal: result.restoredNormal === true,
    bgCancelStopped: result.cancelStopped === true,
    bgCancelStatus: result.cancelJobStatus === 'cancelled',
    bgStageLabelsObserved: stageLabels.length > 0,
    bgStageLabelsKnown: stageLabels.every((label) => allowedStageLabels.has(label)),
    bgMergedShotLabel: String(result.resultSummaryText ?? '').includes('合并镜头'),
    bgFallbackPrompt: expectFallback
      ? result.fallbackVisible === true &&
        String(result.fallbackText ?? '').includes('已使用 OpenCV 备用切分')
      : true,
  };
}

async function runDetectBgChecks(
  win: BrowserWindow,
  deps: SmokeDeps,
  videoPath: string,
): Promise<Record<string, any>> {
  const data = deps.getData?.() ?? null;
  if (!videoPath || !data) return { skipped: true, reason: 'missing video/data' };
  const result = (await win.webContents.executeJavaScript(`
    (async () => {
      const out = {};
      const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      const stageLabels = new Set();
      let stageTimer = null;
      const waitFor = async (check, timeoutMs = 15000) => {
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
          const value = await check();
          if (value) return value;
          await sleep(100);
        }
        return null;
      };
      const ui = () => window.__S36_DETECT_TEST__;
      const state = () => ui()?.state?.() ?? null;
      const layer = async () => {
        const s = await window.api.player.getState();
        return s.ok ? s.data.layer : null;
      };
      const centerProbe = (selector) => {
        const el = document.querySelector(selector);
        if (!el) return { found: false, inside: false };
        const r = el.getBoundingClientRect();
        const x = r.left + r.width / 2;
        const y = r.top + r.height / 2;
        const hit = document.elementFromPoint(x, y);
        return {
          found: true,
          inside: Boolean(hit && (el === hit || el.contains(hit))),
          x,
          y,
          hitTag: hit?.tagName ?? null,
          hitClass: hit?.className ? String(hit.className) : null,
          rect: { x: r.x, y: r.y, width: r.width, height: r.height },
        };
      };
      const intersects = (a, b) =>
        Boolean(a && b && a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top);
      try {
        if (!ui()) { out.exception = 'S36 detect test hook missing'; return out; }
        const created = await window.api.project.create({
          name: 'S36-6 BG Test ' + Date.now(),
          source: { type: 'local', path: ${JSON.stringify(videoPath)} },
          media: {
            filename: 's36-bg-test.mp4',
            durationMs: 120000,
            fps: 500 / 21,
            width: 640,
            height: 360,
          },
        });
        if (!created.ok) { out.createError = created.error; return out; }
        const projectId = created.data.id;
        out.projectId = projectId;
        stageTimer = setInterval(() => {
          const label = state()?.stageLabel;
          if (label) stageLabels.add(label);
        }, 50);
        const started = await ui().start(projectId);
        out.startOk = started?.ok === true;
        const running = await waitFor(() => {
          const s = state();
          return s && s.detecting ? s : null;
        }, 20000);
        out.running = Boolean(running);
        out.runningLayer = (await layer()) === 'normal';
        out.runningOverlayOpen = running?.overlayOpen === false;
        out.runningNoMask = !document.querySelector('.modal-mask');
        const chip = document.querySelector('.detect-status-chip');
        out.chipVisible = Boolean(chip);
        if (chip) {
          const chipRect = chip.getBoundingClientRect();
          const videoRect = document.querySelector('.video-slot')?.getBoundingClientRect() ?? null;
          out.chipOutsideVideo = !intersects(chipRect, videoRect);
          out.chipRect = { x: chipRect.x, y: chipRect.y, width: chipRect.width, height: chipRect.height };
          out.videoRect = videoRect
            ? { x: videoRect.x, y: videoRect.y, width: videoRect.width, height: videoRect.height }
            : null;
        }
        // 启动导入向导可能正在退场；等遮罩消失后再断言左右面板可交互。
        await waitFor(() => !document.querySelector('.import-modal-mask'), 3000);
        const leftProbe = centerProbe('.shot-panel');
        const rightProbe = centerProbe('.detail-panel');
        out.leftProbe = leftProbe;
        out.rightProbe = rightProbe;
        out.leftInteractive = leftProbe.inside === true;
        out.rightInteractive = rightProbe.inside === true;

        // 收起状态胶囊：任务继续，迷你胶囊出现
        ui().collapse();
        await sleep(250);
        const collapsed = state();
        out.collapsedStillRunning =
          collapsed?.detecting === true &&
          collapsed?.capsuleHidden === true &&
          Boolean(document.querySelector('.detect-mini-chip'));

        const done = await waitFor(() => {
          const s = state();
          return s && !s.detecting && s.resultReady ? s : null;
        }, ${JSON.stringify(Number(process.env['SMOKE_DETECT_DONE_MS'] ?? '30000') || 30_000)});
        out.done = Boolean(done);
        out.doneLayer = (await layer()) === 'normal';
        out.resultChipVisible = Boolean(document.querySelector('.detect-result-chip'));
        out.resultCount = done?.resultCount ?? 0;

        // 结果胶囊 → 模态结果弹窗 → 视频层 hidden
        document.querySelector('.detect-result-chip')?.click();
        await waitFor(() => state()?.detectionOpen === true, 5000);
        await waitFor(async () => (await layer()) === 'hidden', 8000);
        out.resultModalOpen = Boolean(document.querySelector('.detect-modal'));
        out.resultLayerHidden = (await layer()) === 'hidden';
        out.resultSummaryText = document.querySelector('.result-summary')?.textContent ?? '';
        out.fallbackVisible = Boolean(document.querySelector('.detect-fallback'));
        out.fallbackText = document.querySelector('.detect-fallback')?.textContent ?? '';
        document.querySelector('.detect-modal .modal-head button[aria-label="关闭"]')?.click();
        await waitFor(async () => (await layer()) === 'normal', 8000);
        out.restoredNormal = (await layer()) === 'normal';

        // 取消测试
        await ui().start(projectId);
        const secondRunning = await waitFor(() => {
          const s = state();
          return s && s.detecting ? s : null;
        }, 20000);
        out.secondRunning = Boolean(secondRunning);
        const withJob = await waitFor(() => {
          const s = state();
          return s && s.detecting && s.jobId ? s : null;
        }, 10000);
        out.secondJobId = withJob?.jobId ?? null;
        const cancelButton = document.querySelector('.detect-chip-cancel');
        out.cancelButtonVisible = Boolean(cancelButton);
        cancelButton?.click();
        const stopped = await waitFor(() => {
          const s = state();
          return s && !s.detecting ? s : null;
        }, 10000);
        out.cancelStopped = Boolean(stopped);
        out.jobId = stopped?.jobId ?? withJob?.jobId ?? secondRunning?.jobId ?? running?.jobId ?? null;
        if (out.jobId) {
          const deadline = Date.now() + 5000;
          let status = null;
          while (Date.now() < deadline) {
            const job = await window.api.detect.getJob({ jobId: out.jobId });
            status = job.ok ? job.data.status : null;
            if (status && status !== 'running' && status !== 'queued') break;
            await sleep(150);
          }
          out.cancelJobStatus = status;
        }
        out.layerAfterCancel = await layer();
        return out;
      } catch (error) {
        out.exception = String(error && error.stack ? error.stack : error);
        return out;
      } finally {
        if (stageTimer) clearInterval(stageTimer);
        out.stageLabels = [...stageLabels];
      }
    })()
  `)) as Record<string, any>;
  const projectId = typeof result.projectId === 'string' ? result.projectId : null;
  if (projectId) {
    try {
      data.projects.delete(projectId);
      deps.getSession?.()?.clear();
      rmSync(join(data.dataRoot, '.ai-jobs', `${projectId}.json`), { force: true });
      rmSync(join(data.dataRoot, '.ai-jobs', `${projectId}.log`), { force: true });
      rmSync(join(resolveThumbCacheDir(), projectId), { recursive: true, force: true });
    } catch (cleanupError) {
      result.cleanupError = String(cleanupError);
    }
  }
  return result;
}

function aiProviderChecksAssertions(result: Record<string, any>): Record<string, boolean> {
  return {
    providerLegacyMigration: result.p1 === true,
    providerKeysEncrypted: result.p2Keys === true,
    providerMultiSave: result.p2 === true,
    providerLegacyCleared: result.p2Cleared === true,
    providerSwitchResolve: result.p3 === true,
    providerModelListMock: result.p4Mock === true,
    providerModelListError: result.p4Error === true,
    providerModelListServer: result.p4ServerList === true,
    providerExplicitModel: result.p4Explicit === true,
    providerDoubaoRegex: result.p5Regex === true,
    providerDoubaoProbe: result.p5Probe === true,
    providerProbeStoredKey: result.p7 === true,
    providerDeleteFallback: result.p6 === true,
  };
}

async function runAiLiveProbeChecks(win: BrowserWindow): Promise<Record<string, any>> {
  try {
    const settings = (await win.webContents.executeJavaScript(
      'window.api.settings.get()',
    )) as { ok: boolean; data?: any };
    if (!settings.ok || !settings.data?.ai) return { ok: false, error: 'settings unavailable' };
    const probe = await createProviderFromSettings(settings.data.ai).probeCapability();
    return {
      ok: probe.ok === true,
      supportsNativeVideo: probe.supportsNativeVideo === true,
      provider: probe.provider,
      model: probe.model,
      error: probe.error,
    };
  } catch (error) {
    return { ok: false, error: String(error) };
  }
}

async function runAiLiveCallChecks(
  win: BrowserWindow,
  deps: SmokeDeps,
  videoPath: string,
): Promise<Record<string, any>> {
  const data = deps.getData?.() ?? null;
  const media = deps.getMedia?.() ?? null;
  if (!videoPath || !data || !media) return { skipped: true };
  const settings = (await win.webContents.executeJavaScript(
    'window.api.settings.get()',
  )) as { ok: boolean; data?: any };
  if (!settings.ok || !settings.data?.ai) return { ok: false, error: 'settings unavailable' };
  const active = resolveActiveProvider(settings.data.ai);
  if (!active?.baseUrl || !active.apiKey) return { ok: false, error: 'provider unavailable' };
  const project = data.projects.create({
    name: `S37 Live AI ${Date.now()}`,
    source: { type: 'local', path: videoPath },
    media: {
      filename: 'ai-live-smoke.mp4',
      proxyPath: videoPath,
      durationMs: 8000,
      fps: 500 / 21,
      width: 640,
      height: 360,
    },
  });
  try {
    const result = await new AiDetectRunner(data, media).run({
      project,
      provider: new OpenAiCompatProvider({
        baseUrl: active.baseUrl,
        apiKey: decryptApiKey(active.apiKey),
        model: active.model,
        timeoutMs: 45_000,
      }),
      signal: new AbortController().signal,
      options: { segmentSeconds: 30, segmentOverlapSeconds: 5, maxRetriesPerSegment: 0 },
      resume: false,
    });
    return {
      ok: result.status === 'done',
      status: result.status,
      shots: result.result.shots.length,
      segments: result.segmentsTotal,
      usage: result.usage,
      error: result.error,
    };
  } catch (error) {
    return {
      ok: false,
      error: String(error instanceof Error ? error.stack ?? error.message : error),
    };
  } finally {
    try {
      data.projects.delete(project.id);
      rmSync(join(data.dataRoot, '.ai-jobs', `${project.id}.json`), { force: true });
      rmSync(join(data.dataRoot, '.ai-jobs', `${project.id}.log`), { force: true });
      rmSync(join(resolveThumbCacheDir(), project.id), { recursive: true, force: true });
    } catch {
      // ignore cleanup failures
    }
  }
}

async function runAiLiveTextChecks(win: BrowserWindow): Promise<Record<string, any>> {
  try {
    const settings = (await win.webContents.executeJavaScript(
      'window.api.settings.get()',
    )) as { ok: boolean; data?: any };
    if (!settings.ok || !settings.data?.ai) return { ok: false, error: 'settings unavailable' };
    const active = resolveActiveProvider(settings.data.ai);
    if (!active?.baseUrl || !active.apiKey) {
      return { ok: false, error: 'provider unavailable' };
    }
    const response = await net.fetch(`${active.baseUrl.replace(/\/+$/u, '')}/chat/completions`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${decryptApiKey(active.apiKey)}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: active.model,
        messages: [{ role: 'user', content: '只回复 OK' }],
        max_tokens: 8,
        temperature: 0,
      }),
      signal: AbortSignal.timeout(45_000),
    });
    const text = await response.text();
    return {
      ok: response.ok,
      status: response.status,
      response: text.slice(0, 500),
    };
  } catch (error) {
    return {
      ok: false,
      error: String(error instanceof Error ? error.stack ?? error.message : error),
    };
  }
}

async function runAiProvidersChecks(win: BrowserWindow): Promise<Record<string, any>> {
  const out: Record<string, any> = {};
  try {
    // P-1：旧扁平配置 → legacy provider（纯函数，不写文件）
    const migrated = migrateLegacyAiSettings({
      provider: 'openai-compatible',
      baseUrl: 'https://legacy.example/v1',
      apiKey: 'sk-legacy-plain',
    });
    const legacy = migrated.providers?.[0];
    out.p1 =
      migrated.activeProviderId === 'legacy' &&
      legacy?.id === 'legacy' &&
      legacy?.baseUrl === 'https://legacy.example/v1' &&
      migrated.baseUrl === 'https://legacy.example/v1';
    out.p1KeyEncrypted = Boolean(legacy?.apiKey?.startsWith('enc:v1:'));

    // P-2：多供应商保存/回读 + key 加密 + legacy 字段清空
    const settings = (await win.webContents.executeJavaScript(
      'window.api.settings.get()',
    )) as { ok: boolean; data?: any };
    if (!settings.ok || !settings.data) {
      out.settingsError = settings;
      return out;
    }
    const original = settings.data;
    const testProviders = [
      {
        id: 'legacy',
        name: '默认供应商',
        note: '旧配置',
        homeUrl: 'https://legacy.example.com',
        baseUrl: 'https://legacy.example/v1',
        apiKey: 'sk-legacy-test',
        model: 'legacy-video-v1',
        models: ['legacy-video-v1'],
      },
      {
        id: 'prov-b',
        name: '测试二',
        note: '方舟',
        homeUrl: 'https://ark.cn-beijing.volces.com',
        baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
        apiKey: 'sk-b-test',
        model: 'doubao-seed-2-1-pro-260915',
        models: ['doubao-seed-2-1-pro-260915', 'doubao-seed-1-6'],
      },
    ];
    try {
      const saved = (await win.webContents.executeJavaScript(
        `window.api.settings.set(${JSON.stringify({
          ...original,
          ai: { ...(original.ai ?? {}), providers: testProviders, activeProviderId: 'prov-b' },
        })})`,
      )) as { ok: boolean; data?: any; error?: any };
      if (saved.ok && saved.data?.ai) {
        out.p2 =
          saved.data.ai.providers?.length === 2 && saved.data.ai.activeProviderId === 'prov-b';
        out.p2Keys = saved.data.ai.providers.every(
          (provider: any) => !provider.apiKey || String(provider.apiKey).startsWith('enc:v1:'),
        );
        out.p2Cleared = saved.data.ai.baseUrl === '' && saved.data.ai.apiKey === '';
        const switched = (await win.webContents.executeJavaScript(
          `window.api.settings.set(${JSON.stringify({
            ...saved.data,
            ai: { ...saved.data.ai, activeProviderId: 'legacy' },
          })})`,
        )) as { ok: boolean; data?: any };
        out.p2Switch = switched.ok && switched.data?.ai?.activeProviderId === 'legacy';
      } else {
        out.p2Error = saved.error ?? saved;
      }
    } finally {
      try {
        await win.webContents.executeJavaScript(
          `window.api.settings.set(${JSON.stringify(original)})`,
        );
      } catch {
        // restore best effort
      }
    }

    // P-3：activeProviderId 切换解析
    const twoProviders = {
      providers: [
        { id: 'a', name: 'A', baseUrl: 'https://a.example/v1' },
        { id: 'b', name: 'B', baseUrl: 'https://b.example/v1' },
      ],
      activeProviderId: 'b',
    };
    out.p3 =
      resolveActiveProvider(twoProviders)?.baseUrl === 'https://b.example/v1' &&
      resolveActiveProvider({ ...twoProviders, activeProviderId: 'a' })?.baseUrl ===
        'https://a.example/v1';

    // P-4：模型列表（Mock / 错误端点 / 本地服务）
    const mockModels = await new MockProvider().listModels();
    const missing = await new OpenAiCompatProvider({ baseUrl: '', apiKey: '' }).listModels();
    out.p4Mock = mockModels.ok === true && (mockModels.models?.length ?? 0) === 2;
    out.p4Error =
      missing.ok === false && missing.error?.code === 'PROVIDER_BASE_URL_MISSING';

    let capturedModel: string | null = null;
    let capturedAuth: string | null = null;
    const server = createServer((request, response) => {
      let body = '';
      request.on('data', (chunk) => {
        body += chunk;
      });
      request.on('end', () => {
        if (request.method === 'GET' && request.url === '/models') {
          capturedAuth = request.headers.authorization ?? null;
          response.writeHead(200, { 'content-type': 'application/json' });
          response.end(
            JSON.stringify({
              data: [
                { id: 'doubao-seed-2-1-pro-260915' },
                { id: 'doubao-seed-1-6' },
                { id: 'other-model' },
              ],
            }),
          );
          return;
        }
        if (request.method === 'POST' && request.url === '/chat/completions') {
          try {
            capturedModel = JSON.parse(body).model ?? null;
          } catch {
            capturedModel = null;
          }
          const result = {
            segment: { startMs: 0, endMs: 1000 },
            shots: [
              {
                id: 's1',
                startMs: 0,
                endMs: 1000,
                representativeTimeMs: 500,
                note: '中景 · 固定 · 测试主体 · 自然光 · 静止',
                tags: {},
                confidence: 0.9,
              },
            ],
            usage: { seconds: 1, tokens: 10, cost: 0 },
            generatedAt: '2026-11-04T00:00:00Z',
          };
          response.writeHead(200, { 'content-type': 'application/json' });
          response.end(
            JSON.stringify({
              choices: [{ message: { content: JSON.stringify(result) } }],
              usage: { prompt_tokens: 5, completion_tokens: 5 },
            }),
          );
          return;
        }
        response.writeHead(404, { 'content-type': 'application/json' });
        response.end('{}');
      });
    });
    try {
      await new Promise<void>((resolveListen) =>
        server.listen(0, '127.0.0.1', () => resolveListen()),
      );
      const address = server.address();
      const port = address && typeof address === 'object' ? address.port : 0;
      const provider = new OpenAiCompatProvider({
        baseUrl: `http://127.0.0.1:${port}`,
        apiKey: 'sk-test',
        model: 'doubao-seed-2-1-pro-260915',
        timeoutMs: 5000,
      });
      const list = await provider.listModels();
      out.p4ServerList = list.ok === true && (list.models?.length ?? 0) === 3;
      const probe = await provider.probeCapability();
      out.p5Probe =
        probe.ok === true &&
        probe.supportsNativeVideo === true &&
        probe.model === 'doubao-seed-2-1-pro-260915';
      const analysis = await provider.analyzeSegment(
        {
          videoPath: `http://127.0.0.1:${port}/video.mp4`,
          startMs: 0,
          endMs: 1000,
        },
        new AbortController().signal,
      );
      out.p4Explicit =
        capturedModel === 'doubao-seed-2-1-pro-260915' && analysis.shots.length === 1;

      // P-7：providerId + baseUrl 但未传 draft apiKey 时，应回落到已存密文
      const currentSettings = (await win.webContents.executeJavaScript(
        'window.api.settings.get()',
      )) as { ok: boolean; data?: any };
      if (currentSettings.ok && currentSettings.data) {
        const original = currentSettings.data;
        const tempProvider = {
          id: 'local-probe',
          name: 'Local Probe',
          baseUrl: `http://127.0.0.1:${port}`,
          apiKey: 'sk-stored-probe',
          models: [],
        };
        try {
          const saved = (await win.webContents.executeJavaScript(
            `window.api.settings.set(${JSON.stringify({
              ...original,
              ai: {
                ...(original.ai ?? {}),
                providers: [tempProvider],
                activeProviderId: 'local-probe',
              },
            })})`,
          )) as { ok: boolean };
          const probed = (await win.webContents.executeJavaScript(
            `window.api.ai.probeProvider(${JSON.stringify({
              providerId: 'local-probe',
              baseUrl: `http://127.0.0.1:${port}`,
            })})`,
          )) as { ok: boolean; data?: any };
          out.p7 =
            saved.ok === true &&
            probed.ok === true &&
            probed.data?.supportsNativeVideo === true &&
            capturedAuth === 'Bearer sk-stored-probe';
        } finally {
          await win.webContents.executeJavaScript(
            `window.api.settings.set(${JSON.stringify(original)})`,
          );
        }
      }
    } finally {
      await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    }

    // P-5：豆包正则
    out.p5Regex =
      isNativeVideoModel('doubao-seed-2-1-pro-260915') === true &&
      isNativeVideoModel('doubao-seed-1-6') === true &&
      isNativeVideoModel('plain-text-model') === false;

    // P-6：删除激活供应商后回落到第一个
    const p6Before = migrateLegacyAiSettings({
      providers: [
        { id: 'a', name: 'A', baseUrl: 'https://a.example/v1' },
        { id: 'b', name: 'B', baseUrl: 'https://b.example/v1' },
      ],
      activeProviderId: 'b',
    });
    const p6After = migrateLegacyAiSettings({
      ...p6Before,
      providers: (p6Before.providers ?? []).filter((item) => item.id !== 'b'),
      activeProviderId: 'b',
    });
    out.p6 = p6Before.activeProviderId === 'b' && p6After.activeProviderId === 'a';
  } catch (error) {
    out.exception = String(error instanceof Error ? error.stack ?? error.message : error);
  }
  return out;
}

function timelineZoomChecksAssertions(result: Record<string, any>): Record<string, boolean> {
  return {
    zoomSnapPure: result.snap === true,
    zoomCapsule: result.capsule === true,
    zoomPopover: result.popover === true,
    zoomHeightSlider: result.heightSlider === true,
    zoomMinHeight: result.minHeight === true,
    zoomMinCollapsed: Number(result.minHeightRowPx ?? 99) <= 2,
    zoomDensitySlider: result.densitySlider === true,
    zoomDirectInput: result.directInput === true,
    zoomWheel: result.wheel === true,
    zoomReset: result.reset === true,
    zoomOutsideClose: result.outsideClose === true,
    zoomPersist: result.persist === true,
  };
}

function nleTrackChecksAssertions(result: Record<string, any>): Record<string, boolean> {
  return {
    nleThreeTrackHeads: result.badges?.join(',') === 'V2,V1,A1',
    nleShotCounts: result.v2Count === true && result.v1Count === true,
    nleV1Selection: result.v1Selection === true,
    nleV1Lock: result.v1Lock === true,
    nleV2Visibility: result.v2Visibility === true,
    nleAudioMS: result.audioMute === true && result.audioSolo === true,
    nleZoomPreserved: result.zoom === true,
    nleZoomUnclipped: result.zoomUnclipped === true,
    nleNavigator: result.navigator === true && result.navigatorMoved === true,
    nleRestoreWorkspace: result.restoredWorkspace === true,
  };
}

async function runNleTrackChecks(win: BrowserWindow): Promise<Record<string, any>> {
  const result = (await win.webContents.executeJavaScript(`
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
        const navButtons = Array.from(document.querySelectorAll('.main-nav .nav-item'));
        const startedInDemo = navButtons.some(
          (button) => String(button.textContent || '').trim() === '最近项目',
        );
        const demoButton = Array.from(document.querySelectorAll('.main-nav .nav-item')).find(
          (button) => String(button.textContent || '').trim() === '示例模式',
        );
        demoButton?.click();
        await waitFor(() => document.querySelectorAll('.v1-clip').length > 0, 5000);
        const timeline = await waitFor(() => document.querySelector('.timeline'));
        if (!timeline) return { exception: 'timeline missing' };
        const badges = Array.from(timeline.querySelectorAll('.track-badge'))
          .map((item) => String(item.textContent || '').trim());
        out.badges = badges;
        const v2Head = timeline.querySelector('.track-row-v2 .track-head');
        const v1Head = timeline.querySelector('.track-row-v1 .track-head');
        const a1Head = timeline.querySelector('.track-row-a1 .track-head');
        out.v2Count = /\\d+ 个片段/.test(String(v2Head?.textContent || ''));
        out.v1Count = /\\d+ 个剪辑/.test(String(v1Head?.textContent || ''));
        out.a1Shown = Boolean(a1Head && /音频 1/.test(String(a1Head.textContent || '')));

        const clips = timeline.querySelectorAll('.v1-clip');
        out.v1ClipCount = clips.length;
        const target = clips.length > 1 ? clips[1] : clips[0];
        target?.dispatchEvent(new PointerEvent('pointerdown', {
          bubbles: true,
          cancelable: true,
          button: 0,
          clientX: 320,
          clientY: 200,
        }));
        await sleep(120);
        out.v1Selection = Boolean(timeline.querySelector('.v1-clip.selected'));

        const v1Controls = timeline.querySelectorAll('.track-row-v1 .head-control');
        v1Controls[1]?.click();
        await sleep(80);
        out.v1Lock = v1Controls[1]?.getAttribute('aria-pressed') === 'true'
          && timeline.querySelectorAll('.v1-clip .trim-handle').length === 0;

        const v2Toggle = timeline.querySelector('.track-row-v2 .head-control');
        v2Toggle?.click();
        await sleep(80);
        out.v2Visibility = v2Toggle?.getAttribute('aria-pressed') === 'false'
          && timeline.querySelector('.track-row-v2')?.classList.contains('track-hidden')
          && Boolean(timeline.querySelector('.track-row-v2 .hidden-note'));

        const audioControls = timeline.querySelectorAll('.track-row-a1 .head-control');
        audioControls[0]?.click();
        audioControls[1]?.click();
        await sleep(80);
        out.audioMute = audioControls[0]?.getAttribute('aria-pressed') === 'true'
          && timeline.querySelector('.track-row-a1')?.classList.contains('track-muted');
        out.audioSolo = audioControls[1]?.getAttribute('aria-pressed') === 'true'
          && timeline.querySelector('.a1-lane')?.classList.contains('solo');

        const navigator = timeline.querySelector('.timeline-navigator-slider');
        const navigatorLabel = timeline.querySelector('.navigator-range-label');
        const navigatorBefore = String(navigatorLabel?.textContent || '').trim();
        out.navigator = Boolean(navigator) && Number(navigator?.max || 0) > 0;
        if (navigator) {
          const target = Math.round(Number(navigator.max) / 2);
          Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')
            ?.set?.call(navigator, String(target));
          navigator.dispatchEvent(new Event('input', { bubbles: true }));
          await sleep(120);
          out.navigatorMoved = Number(navigator.value) === target
            && String(navigatorLabel?.textContent || '').trim() !== navigatorBefore;
        }

        const zoomButton = timeline.querySelector('.zoom-btn');
        zoomButton?.click();
        await sleep(80);
        const zoomPop = timeline.querySelector('.zoom-pop');
        out.zoom = Boolean(zoomButton && zoomPop && getComputedStyle(zoomPop).display !== 'none');
        if (zoomPop) {
          const popRect = zoomPop.getBoundingClientRect();
          const rulerRect = timeline.querySelector('.track-container')?.getBoundingClientRect();
          const point = document.elementFromPoint(
            popRect.left + popRect.width / 2,
            popRect.top + popRect.height / 2,
          );
          out.zoomUnclipped = popRect.height > 50
            && Boolean(rulerRect)
            && popRect.bottom > rulerRect.bottom
            && Boolean(point?.closest('.zoom-pop'));
        }
        zoomButton?.click();
        v2Toggle?.click();
        v1Controls[1]?.click();
        audioControls[0]?.click();
        audioControls[1]?.click();
        await sleep(120);
        out.startedInDemo = startedInDemo;
        return out;
      } catch (error) {
        out.exception = String(error && error.stack ? error.stack : error);
        return out;
      }
    })()
  `)) as Record<string, any>;
  const screenshotPath = process.env['SMOKE_NLE_SCREENSHOT'];
  if (screenshotPath) {
    const image = await win.webContents.capturePage();
    writeFileSync(screenshotPath, image.toPNG());
  }
  if (result.startedInDemo === false) {
    result.restoredWorkspace = await win.webContents.executeJavaScript(`
      (async () => {
        const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
        const recentButton = Array.from(document.querySelectorAll('.main-nav .nav-item')).find(
          (button) => String(button.textContent || '').trim() === '最近项目',
        );
        recentButton?.click();
        await sleep(300);
        return !Array.from(document.querySelectorAll('.main-nav .nav-item')).some(
          (button) => String(button.textContent || '').trim() === '最近项目',
        );
      })()
    `);
  } else {
    result.restoredWorkspace = true;
  }
  return result;
}

async function runTimelineZoomChecks(win: BrowserWindow): Promise<Record<string, any>> {
  const out: Record<string, any> = {
    snap:
      snapToLevel(50, TRACK_HEIGHT_LEVELS) === 48 &&
      snapToLevel(200, TRACK_HEIGHT_LEVELS) === 192 &&
      snapToLevel(120, PX_PER_SEC_LEVELS) === 96 &&
      snapToLevel(500, PX_PER_SEC_LEVELS) === 384,
  };
  const ui = (await win.webContents.executeJavaScript(`
    (async () => {
      const out = {};
      const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      const waitFor = async (check, timeoutMs = 5000) => {
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
          const value = await check();
          if (value) return value;
          await sleep(100);
        }
        return null;
      };
      const settings = await window.api.settings.get();
      if (!settings.ok) return { exception: 'settings.get failed' };
      const originalTimeline = settings.data.timeline ?? { trackHeight: 96, pxPerSecond: 96 };
      out.originalTimeline = originalTimeline;
      const setValue = (input, value) => {
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
        setter?.call(input, String(value));
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
      };
      const readTimeline = async () => {
        const current = await window.api.settings.get();
        return current.ok ? current.data.timeline : null;
      };
      try {
        await sleep(2500);
        const button = await waitFor(() => document.querySelector('.zoom-btn'), 15000);
        out.capsule = Boolean(button);
        if (!button) return out;
        button.click();
        const pop = await waitFor(() => document.querySelector('.zoom-pop'), 5000);
        out.popover = Boolean(pop) && getComputedStyle(pop).display !== 'none';
        if (!pop) return out;
        const ranges = pop.querySelectorAll('.zoom-row input[type="range"]');
        const numbers = pop.querySelectorAll('.zoom-num');
        out.rangeCount = ranges.length;
        if (ranges.length < 2 || numbers.length < 2) return out;

        setValue(ranges[0], 200);
        await sleep(250);
        out.heightButtonText1 = document.querySelector('.zoom-btn')?.textContent?.trim() ?? null;
        out.heightRange1 = ranges[0].value;
        out.timeline1 = await readTimeline();
        out.uiState1 = window.__S36_TIMELINE_UI_STATE__?.() ?? null;
        out.toast1 = document.querySelector('.toast')?.textContent?.trim() ?? null;
        await waitFor(async () => (await readTimeline())?.trackHeight === 192, 4000);
        out.heightSlider = (await readTimeline())?.trackHeight === 192;
        out.heightButtonText2 = document.querySelector('.zoom-btn')?.textContent?.trim() ?? null;
        out.timeline2 = await readTimeline();

        setValue(ranges[1], 500);
        await sleep(250);
        out.densityButtonText1 = document.querySelector('.zoom-btn')?.textContent?.trim() ?? null;
        out.densityRange1 = ranges[1].value;
        out.timeline3 = await readTimeline();
        out.uiState3 = window.__S36_TIMELINE_UI_STATE__?.() ?? null;
        out.toast3 = document.querySelector('.toast')?.textContent?.trim() ?? null;
        await waitFor(async () => (await readTimeline())?.pxPerSecond === 384, 4000);
        out.densitySlider = (await readTimeline())?.pxPerSecond === 384;
        out.densityButtonText2 = document.querySelector('.zoom-btn')?.textContent?.trim() ?? null;
        out.timeline4 = await readTimeline();
        out.persist = out.heightSlider === true && out.densitySlider === true;

        const heightNumber = numbers[0];
        heightNumber.focus();
        setValue(heightNumber, 50);
        heightNumber.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
        await waitFor(async () => (await readTimeline())?.trackHeight === 48, 4000);
        out.directInput = (await readTimeline())?.trackHeight === 48;

        const heightRow = pop.querySelectorAll('.zoom-row')[0];
        heightRow?.dispatchEvent(
          new WheelEvent('wheel', { deltaY: -100, bubbles: true, cancelable: true }),
        );
        await waitFor(async () => (await readTimeline())?.trackHeight === 96, 4000);
        const wheelUp = (await readTimeline())?.trackHeight === 96;
        heightRow?.dispatchEvent(
          new WheelEvent('wheel', { deltaY: 100, bubbles: true, cancelable: true }),
        );
        await waitFor(async () => (await readTimeline())?.trackHeight === 48, 4000);
        const wheelDown = (await readTimeline())?.trackHeight === 48;
        out.wheel = wheelUp === true && wheelDown === true;

        heightNumber.focus();
        setValue(heightNumber, 1);
        heightNumber.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
        await waitFor(async () => (await readTimeline())?.trackHeight === 1, 4000);
        out.minHeight = (await readTimeline())?.trackHeight === 1;
        out.minHeightRowPx = Math.round(
          document.querySelector('.track-row-v1')?.getBoundingClientRect().height ?? 99,
        );

        document.querySelector('.zoom-reset')?.click();
        await waitFor(async () => {
          const timeline = await readTimeline();
          return timeline?.trackHeight === 96 && timeline?.pxPerSecond === 96;
        }, 4000);
        const resetTimeline = await readTimeline();
        out.reset = resetTimeline?.trackHeight === 96 && resetTimeline?.pxPerSecond === 96;

        document.querySelector('.tracks')?.dispatchEvent(
          new PointerEvent('pointerdown', { bubbles: true }),
        );
        await sleep(150);
        out.outsideClose = getComputedStyle(pop).display === 'none';
        return out;
      } finally {
        try {
          // 等 App 的 400ms 防抖写入落定，再做恢复，避免恢复被迟到的写入覆盖。
          await sleep(700);
          const current = await window.api.settings.get();
          if (current.ok) {
            await window.api.settings.set({ ...current.data, timeline: originalTimeline });
          }
        } catch {
          // restore best effort
        }
      }
    })()
  `)) as Record<string, any>;
  return { ...out, ...ui };
}

function aiSegmentChecksAssertions(result: Record<string, any>): Record<string, boolean> {
  return {
    aiSegmentCreated: result.created === true,
    aiSegmentBounded: Number(result.sizeBytes ?? 0) > 0
      && Number(result.sizeBytes ?? 0) < 64 * 1024 * 1024,
    aiSegmentDuration: result.durationOk === true,
    aiSegmentRunnerClip: result.runnerUsedTemporaryClip === true,
    aiSegmentRunnerBounded: result.runnerClipBounded === true,
  };
}

async function runLocalAiChecks(deps: SmokeDeps): Promise<Record<string, any>> {
  const service = deps.getLocalAi?.() ?? null;
  if (!service) return { skipped: true };
  const status = service.getStatus();
  const imageDir =
    process.env['SMOKE_LOCAL_IMAGE_DIR']
    ?? join(app.getAppPath(), 'src', 'renderer', 'src', 'assets', 'demo-stills');
  const items = [1, 2, 3, 4]
    .map((index) => ({
      id: `local-smoke-${index}`,
      index,
      startMs: index * 1000,
      endMs: index * 1000 + 800,
      imagePath: join(imageDir, `shot-${String(index).padStart(2, '0')}.jpg`),
    }))
    .filter((item) => existsSync(item.imagePath));
  const out: Record<string, any> = {
    statusOk: status.available === true,
    status,
  };
  if (items.length === 0) return { ...out, skipped: true };
  try {
    const started = Date.now();
    const result = await service.analyze(items, {
      signal: new AbortController().signal,
      onProgress: (completed, total, percent) => {
        out.progress = { completed, total, percent };
      },
    });
    out.analyzed = result.length === items.length
      && result.every((item) => item.remark.trim().length > 0);
    out.elapsedMs = Date.now() - started;
    out.items = result;
  } catch (error) {
    out.exception = String(error instanceof Error ? error.stack ?? error.message : error);
  }
  return out;
}

async function runLocalDetectChecks(
  deps: SmokeDeps,
  videoPath: string,
): Promise<Record<string, any>> {
  const data = deps.getData?.() ?? null;
  const detect = deps.getDetect?.() ?? null;
  if (!videoPath || !data || !detect) return { skipped: true };
  const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
  const project = data.projects.create({
    name: `S37 Local Vision ${Date.now()}`,
    source: { type: 'local', path: videoPath },
    media: {
      filename: 'local-vision-smoke.mp4',
      durationMs: 4000,
      fps: 500 / 21,
      width: 640,
      height: 360,
    },
  });
  const out: Record<string, any> = {};
  try {
    const started = detect.run({
      projectId: project.id,
      dryRun: true,
      options: {
        sensitivity: 0.5,
        minShotSeconds: 0.4,
        filterTransitions: false,
        weights: { s: 0.3, c: 0.3, h: 0.4 },
        intervalMs: 500,
        engine: 'ai',
      },
    });
    const deadline = Date.now() + 150_000;
    let job = detect.getJob(started.jobId);
    while ((job.status === 'running' || job.status === 'queued') && Date.now() < deadline) {
      await sleep(500);
      job = detect.getJob(started.jobId);
    }
    out.status = job.status;
    out.error = job.error;
    out.done = job.status === 'done';
    if (job.status !== 'done') return out;
    const result = detect.getJobResult(started.jobId);
    out.shotCount = result.shots.length;
    out.annotated = result.shots.some(
      (shot) => Boolean(shot.remark && shot.shotSize && shot.tags),
    );
    const applied = detect.applyByJob(started.jobId);
    out.applied = applied.applied;
    const persisted = data.shots.list(project.id);
    out.persisted = persisted.some((shot) => Boolean(shot.remark && shot.shotSize && shot.tagIds.length));
    out.shots = result.shots;
  } catch (error) {
    out.exception = String(error instanceof Error ? error.stack ?? error.message : error);
  } finally {
    try {
      data.projects.delete(project.id);
      rmSync(join(data.dataRoot, '.ai-jobs', `${project.id}.json`), { force: true });
      rmSync(join(data.dataRoot, '.ai-jobs', `${project.id}.log`), { force: true });
      rmSync(join(resolveThumbCacheDir(), project.id), { recursive: true, force: true });
    } catch {
      // ignore cleanup failures
    }
  }
  return out;
}

function transnetHybridChecksAssertions(result: Record<string, any>): Record<string, boolean> {
  const expectedEngine = process.env['SMOKE_TRANSNET_BOUNDARY_MODE'] ?? 'hybrid';
  const expectFallback = process.env['SMOKE_TRANSNET_EXPECT_FALLBACK'] === '1';
  return {
    transnetModelPresent: result.modelPresent === !expectFallback,
    transnetHybridEngine: result.boundaryEngine === (expectFallback ? 'opencv' : expectedEngine),
    transnetHybridNoFallback: result.boundaryFallback === expectFallback,
    transnetHybridDone: result.done === true,
    transnetHybridShots: Number(result.shotCount ?? 0) >= 2,
    transnetHybridContinuous: result.continuous === true,
    transnetHybridCoverage: result.coverage === true,
    transnetHybridThumbnails: result.thumbnails === true,
    transnetHybridApplied: Number(result.applied ?? 0) >= 2,
    transnetHybridPersisted: result.persisted === true,
    transnetHybridFramesClean: result.framesClean === true,
    transnetHybridCancel: result.cancelStatus === 'cancelled',
    transnetHybridQwen: process.env['SMOKE_TRANSNET_WITH_QWEN'] !== '1' || result.annotated === true,
  };
}

async function runTransnetHybridChecks(
  deps: SmokeDeps,
  videoPath: string,
): Promise<Record<string, any>> {
  const data = deps.getData?.() ?? null;
  const detect = deps.getDetect?.() ?? null;
  const media = deps.getMedia?.() ?? null;
  const out: Record<string, any> = {
    modelPath: resolveTransnetModelPath(),
  };
  const requestedBoundary = process.env['SMOKE_TRANSNET_BOUNDARY_MODE'] ?? 'hybrid';
  if (!['hybrid', 'transnetv2', 'opencv'].includes(requestedBoundary)) {
    return { ...out, error: `unsupported boundary mode: ${requestedBoundary}` };
  }
  out.modelPresent = existsSync(out.modelPath);
  if (!videoPath || !data || !detect || !media) {
    return { ...out, skipped: true, reason: 'missing video/data/detect/media' };
  }

  const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
  const probe = await media.probe({ path: videoPath });
  const project = data.projects.create({
    name: `S39 TransNetV2 Hybrid ${Date.now()}`,
    source: { type: 'local', path: videoPath },
    media: {
      filename: probe.filename,
      container: probe.container,
      durationMs: probe.durationMs,
      width: probe.width,
      height: probe.height,
      fps: probe.fps,
      videoCodec: probe.videoCodec,
      audioCodec: probe.audioCodec,
      sizeBytes: statSync(videoPath).size,
    },
  });
  const options: DetectOptions = {
    sensitivity: 0.62,
    minShotSeconds: 0.3,
    filterTransitions: true,
    weights: { s: 0.15, c: 0.15, h: 0.25, hv: 0.2, edge: 0.1, grid: 0.15 },
    intervalMs: 250,
    engine: process.env['SMOKE_TRANSNET_WITH_QWEN'] === '1' ? 'ai' : 'opencv',
    boundaryEngine: requestedBoundary as DetectOptions['boundaryEngine'],
  };

  try {
    const started = detect.run({ projectId: project.id, dryRun: true, options });
    const deadline = Date.now() + 240_000;
    let job = detect.getJob(started.jobId);
    while ((job.status === 'running' || job.status === 'queued') && Date.now() < deadline) {
      await sleep(250);
      job = detect.getJob(started.jobId);
    }
    out.status = job.status;
    out.error = job.error;
    out.boundaryEngine = job.boundaryEngine;
    out.boundaryFallback = job.boundaryFallback;
    out.boundaryWarning = job.boundaryWarning;
    out.done = job.status === 'done';
    if (job.status !== 'done') return out;

    const result = detect.getJobResult(started.jobId);
    out.shotCount = result.shots.length;
    out.shots = result.shots.map((shot) => ({
      index: shot.index,
      startMs: shot.startMs,
      endMs: shot.endMs,
      thumbnail: shot.thumbnail,
      hasAnnotation: Boolean(shot.remark && shot.shotSize),
    }));
    out.continuous =
      result.shots.length > 0 &&
      result.shots[0].startMs === 0 &&
      result.shots.every(
        (shot, index) =>
          shot.endMs > shot.startMs &&
          (index === 0 || shot.startMs === result.shots[index - 1].endMs),
      );
    const durationMs = Math.max(1, project.media.durationMs);
    out.coverage = Math.abs((result.shots.at(-1)?.endMs ?? 0) - durationMs) <= 100;
    out.thumbnails = result.shots.every(
      (shot) => Boolean(shot.thumbnail && existsSync(shot.thumbnail)),
    );
    out.annotated = result.shots.some((shot) => Boolean(shot.remark && shot.shotSize));

    out.applied = detect.applyByJob(started.jobId).applied;
    const persisted = data.shots.list(project.id);
    out.persisted =
      persisted.length === out.applied &&
      persisted.every((shot) => shot.startMs >= 0 && shot.endMs > shot.startMs);

    const cancelJob = detect.run({ projectId: project.id, dryRun: true, options });
    detect.cancel(cancelJob.jobId);
    const cancelDeadline = Date.now() + 15_000;
    let cancelSnapshot = detect.getJob(cancelJob.jobId);
    while (
      (cancelSnapshot.status === 'running' || cancelSnapshot.status === 'queued') &&
      Date.now() < cancelDeadline
    ) {
      await sleep(150);
      cancelSnapshot = detect.getJob(cancelJob.jobId);
    }
    out.cancelStatus = cancelSnapshot.status;
    const frameRoot = resolveDetectFramesDir(project.id);
    out.framesClean = !existsSync(frameRoot) || readdirSync(frameRoot).length === 0;
  } catch (error) {
    out.exception = String(error instanceof Error ? error.stack ?? error.message : error);
  } finally {
    try {
      data.projects.delete(project.id);
      rmSync(join(resolveThumbCacheDir(), project.id), { recursive: true, force: true });
    } catch (cleanupError) {
      out.cleanupError = String(cleanupError);
    }
  }
  return out;
}

async function runAiSegmentChecks(
  deps: SmokeDeps,
  videoPath: string,
): Promise<Record<string, any>> {
  const media = deps.getMedia?.() ?? null;
  const data = deps.getData?.() ?? null;
  if (!videoPath || !media) return { skipped: true };
  const outputDir = join(tmpdir(), `lapian-ai-segment-${Date.now()}`);
  const outputPath = join(outputDir, 'segment-001.mp4');
  const requestedEndMs = Math.max(
    1000,
    Number(process.env['SMOKE_AI_SEGMENT_END_MS'] ?? '8000') || 8000,
  );
  const out: Record<string, any> = {};
  try {
    mkdirSync(outputDir, { recursive: true });
    await media.createAiSegment({
      path: videoPath,
      startMs: 0,
      endMs: requestedEndMs,
      outputPath,
      timeoutMs: 120_000,
    });
    out.created = existsSync(outputPath);
    if (out.created) {
      out.sizeBytes = statSync(outputPath).size;
      const probe = await media.probe({ path: outputPath });
      out.durationMs = probe.durationMs;
      out.width = probe.width;
      out.height = probe.height;
      out.requestedEndMs = requestedEndMs;
      out.durationOk = Math.abs(probe.durationMs - requestedEndMs) <= 2000;
    }

    if (data) {
      const project = data.projects.create({
        name: `S37 AI Segment ${Date.now()}`,
        source: { type: 'local', path: videoPath },
        media: {
          filename: 'ai-segment-smoke.mp4',
          proxyPath: videoPath,
          durationMs: requestedEndMs,
          fps: 500 / 21,
          width: 640,
          height: 360,
        },
      });
      try {
        let observedPath = '';
        let observedSize = 0;
        const provider = {
          id: 'ai-segment-probe',
          requiresVideoBytes: true,
          probeCapability: async () => ({
            ok: true,
            supportsNativeVideo: true,
            provider: 'ai-segment-probe',
            model: 'probe-video-v1',
            error: null,
          }),
          listModels: async () => ({ ok: true, models: ['probe-video-v1'] }),
          analyzeSegment: async (input: any, signal: AbortSignal) => {
            observedPath = input.videoPath;
            observedSize = existsSync(input.videoPath) ? statSync(input.videoPath).size : 0;
            return new MockProvider({ shotsPerSegment: 2 }).analyzeSegment(input, signal);
          },
          cancel: () => {},
          getUsage: () => ({ seconds: 0, tokens: 0, cost: 0 }),
        };
        const result = await new AiDetectRunner(data, media).run({
          project,
          provider,
          signal: new AbortController().signal,
          options: { segmentSeconds: 30, segmentOverlapSeconds: 5, maxRetriesPerSegment: 0 },
          resume: false,
        });
        out.runnerUsedTemporaryClip =
          observedPath !== videoPath
          && observedPath.length > 0
          && !existsSync(observedPath);
        out.runnerClipBounded = observedSize > 0 && observedSize < 64 * 1024 * 1024;
        out.runnerStatus = result.status;
      } finally {
        try {
          data.projects.delete(project.id);
          rmSync(join(data.dataRoot, '.ai-jobs', `${project.id}.json`), { force: true });
          rmSync(join(data.dataRoot, '.ai-jobs', `${project.id}.log`), { force: true });
          rmSync(join(resolveThumbCacheDir(), project.id), { recursive: true, force: true });
        } catch {
          // ignore cleanup failures
        }
      }
    }
  } catch (error) {
    out.exception = String(error instanceof Error ? error.stack ?? error.message : error);
  } finally {
    rmSync(outputDir, { recursive: true, force: true });
  }
  return out;
}

function opencvFrameChecksAssertions(result: Record<string, any>): Record<string, boolean> {
  const error = String(result.secondError ?? '');
  return {
    opencvFramesDone: result.done === true,
    opencvFramesApplied: Number(result.applied ?? 0) > 0,
    opencvFramesShots: Number(result.shots ?? 0) > 0,
    opencvFramesNoMissing:
      !error.includes('无法读取帧') &&
      !error.includes('DETECT_FRAMES_MISSING') &&
      !error.includes('检测帧文件'),
  };
}

async function runOpenCvFrameChecks(
  _win: BrowserWindow,
  deps: SmokeDeps,
  videoPath: string,
): Promise<Record<string, any>> {
  const data = deps.getData?.() ?? null;
  const detect = deps.getDetect?.() ?? null;
  if (!videoPath || !data || !detect) return { skipped: true };
  const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
  const project = data.projects.create({
    name: `S37 OpenCV Frames ${Date.now()}`,
    source: { type: 'local', path: videoPath },
    media: {
      filename: 'opencv-frames.mp4',
      durationMs: 8000,
      fps: 500 / 21,
      width: 640,
      height: 360,
    },
  });
  const out: Record<string, any> = {};
  try {
    const options: DetectOptions = {
      sensitivity: 0.5,
      minShotSeconds: 0.4,
      filterTransitions: false,
      weights: { s: 0.3, c: 0.3, h: 0.4 },
      intervalMs: 500,
      engine: 'opencv',
    };
    try {
      const first = detect.run({ projectId: project.id, options, dryRun: true });
      out.firstJobId = first.jobId;
      await sleep(400);
      detect.cancel(first.jobId);
    } catch (error) {
      out.firstError = String(error);
    }
    const second = detect.run({ projectId: project.id, options, dryRun: true });
    out.secondJobId = second.jobId;
    const deadline = Date.now() + 60_000;
    let job = detect.getJob(second.jobId);
    while ((job.status === 'running' || job.status === 'queued') && Date.now() < deadline) {
      await sleep(250);
      job = detect.getJob(second.jobId);
    }
    out.secondStatus = job.status;
    out.secondError = job.error;
    out.done = job.status === 'done';
    if (job.status === 'done') {
      const applied = detect.applyByJob(second.jobId);
      out.applied = applied.applied;
      out.shots = data.shots.list(project.id).length;
    }
  } catch (error) {
    out.exception = String(error instanceof Error ? error.stack ?? error.message : error);
  } finally {
    try {
      data.projects.delete(project.id);
      rmSync(join(resolveDetectFramesDir(project.id)), { recursive: true, force: true });
      rmSync(join(resolveThumbCacheDir(), project.id), { recursive: true, force: true });
      deps.getSession?.()?.clear();
    } catch (error) {
      out.cleanupError = String(error);
    }
  }
  return out;
}
