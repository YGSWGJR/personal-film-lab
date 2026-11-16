import { app, type BrowserWindow } from 'electron';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { DataLayer } from '../data/db';
import { resolveDetectFramesDir } from './paths';

export type ProjectSessionGate = 'multi' | 'switch' | 'close';

function memoryKiB(): number {
  return app.getAppMetrics().reduce((total, entry) => total + entry.memory.workingSetSize, 0);
}

export async function runProjectSessionGate(win: BrowserWindow, data: DataLayer, gate: ProjectSessionGate): Promise<Record<string, unknown>> {
  const paths = [1, 2, 3].map((index) => process.env['SMOKE_PROJECT_FIXTURE_' + index] ?? '');
  if (!paths.every((file) => existsSync(file)) || new Set(paths).size !== 3) {
    return { passed: false, reason: 'Three distinct playable project fixtures are required' };
  }
  const fixture = paths.map((path, index) => {
    const project = data.projects.create({
      name: `S45 M1 ${'ABC'[index]}`,
      source: { type: 'local', path },
      media: { filename: `S45-M1-${'ABC'[index]}.mp4`, durationMs: 8000, fps: 30 },
    });
    if (!project.activeMediaId) throw new Error('Missing fixture media');
    const mediaId = project.activeMediaId;
    const first = data.shots.create({ projectId: project.id, mediaId, startMs: 0, endMs: 1500 });
    const second = data.shots.create({ projectId: project.id, mediaId, startMs: 1500, endMs: 6500 });
    const x = 90 + index * 70;
    data.wall.saveLayout(project.id, [{ shotId: first.id, x, y: 125 }], mediaId);
    const folder = join(data.dataRoot, 'projects', project.id, 'stills');
    mkdirSync(folder, { recursive: true });
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWdgAAAAASUVORK5CYII=', 'base64');
    const filePath = join(folder, 'fixture.png');
    writeFileSync(filePath, png);
    const still = data.stills.create({
      projectId: project.id, mediaId, filePath, shotId: first.id, timeMs: 900, role: 'main',
    });
    return { id: project.id, mediaId, name: project.name, path, shots: [first.id, second.id], stillId: still.id, x, timeMs: 2250 + index * 700 };
  });
  const out = await win.webContents.executeJavaScript(`
    (async () => {
      const f = ${JSON.stringify(fixture)};
      const gate = ${JSON.stringify(gate)};
      const out = {};
      const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      const wait = async (check, label, timeout = 8500) => {
        const deadline = performance.now() + timeout;
        while (performance.now() < deadline) {
          const result = await check();
          if (result) return result;
          await sleep(12);
        }
        throw new Error(label);
      };
      const click = (item) => {
        if (!item) throw new Error('missing button');
        item.click();
      };
      const nav = (text) => Array.from(document.querySelectorAll('.main-nav button'))
        .find((item) => item.textContent.trim() === text);
      const tabButtons = () => Array.from((document.querySelector('.wall-stage .project-tabs')
        ?? document.querySelector('.workspace-stack .project-tabs'))?.querySelectorAll('.project-tab-select') ?? []);
      const stable = () => !document.querySelector('.workspace-stack')?.inert;
      const state = () => window.__CAPTURE_WORKSPACE_STATE__();
      const rows = () => Array.from(document.querySelectorAll('.shot-row')).map((row) => row.dataset.shotId);
      const show = async (project) => {
        await wait(() => stable() && rows().length === project.shots.length &&
          rows().every((id, index) => id === project.shots[index]) && state().projectId === project.id,
          'wrong or stale timeline: ' + project.name);
      };
      const open = async (project) => {
        click(nav('项目中心'));
        const row = await wait(() => Array.from(document.querySelectorAll('.project-row'))
          .find((item) => item.querySelector('strong')?.textContent === project.name), 'missing project center row');
        click(row);
        click(document.querySelector('.project-heading button'));
        await show(project);
      };
      const key = (key, shiftKey = false) => window.dispatchEvent(new KeyboardEvent('keydown', {
        key, ctrlKey: true, shiftKey, bubbles: true, cancelable: true,
      }));
      const wall = () => document.querySelector('.wall-stage');
      const closeWall = async () => {
        click(document.querySelector('.wall-close'));
        await wait(() => !wall(), 'wall did not close');
        await window.__S43_WALL_TEST__.setProjection(false);
      };
      const switchTo = async (project, how) => {
        const start = performance.now();
        if (how) how();
        else click(tabButtons().find((tab) => tab.dataset.projectId === project.id));
        await show(project);
        return Math.round(performance.now() - start);
      };
      try {
        await open(f[0]);
        out.singleProjectLayout = tabButtons().length === 0;
        if (gate === 'close') {
          await sleep(350);
          const memory = await window.api.projectTasks.list({ projectId: f[0].id });
          if (!memory.ok) throw new Error(memory.error.message);
          return { ...out, fixtureReady: true };
        }
        await open(f[1]);
        await open(f[2]);
        out.threeProjects = tabButtons().length === 3;
        await open(f[0]);
        out.deduplication = tabButtons().length === 3;
        if (gate === 'multi') {
          const checks = [];
          for (const [index, project] of f.entries()) {
            if (index) await switchTo(project);
            click(nav('分镜墙'));
            click(await wait(() => document.querySelector('.picker-option b')?.closest('button') &&
              Array.from(document.querySelectorAll('.picker-option')).find((button) => button.textContent.includes('本项目分镜本')),
              'storyboard picker missing'));
            await wait(wall, 'storyboard wall missing');
            const boardLayout = await window.api.wall.getLayout({ projectId: project.id, mediaId: project.mediaId });
            const cards = Array.from(wall().querySelectorAll('.wall-card')).map((card) => card.dataset.shotId);
            await closeWall();
            click(nav('静帧墙'));
            await wait(() => document.querySelector('.wall-card'), 'still wall card missing');
            const stillCards = Array.from(wall().querySelectorAll('.wall-card'));
            const stills = await window.api.still.list({ projectId: project.id });
            checks.push({
              project: project.name,
              wall: cards.length === 2 && cards.every((id) => project.shots.includes(id)) &&
                boardLayout.ok && boardLayout.data.length === 1 && boardLayout.data[0].x === project.x,
              stills: stillCards.length === 1 && stills.ok && stills.data.length === 1 &&
                stills.data[0].id === project.stillId && stillCards[0].textContent.includes('S45-M1-'),
            });
            await closeWall();
          }
          out.walls = checks;
          await switchTo(f[0]);
          click(nav('分镜墙'));
          click(await wait(() => Array.from(document.querySelectorAll('.picker-option'))
            .find((button) => button.textContent.includes('本项目分镜本')), 'A storyboard picker missing'));
          const first = await wait(() => wall()?.querySelector('.wall-card'), 'A canvas missing');
          first.click();
          const content = wall().querySelector('.wall-content');
          const initialTransform = content.style.transform;
          wall().dispatchEvent(new WheelEvent('wheel', { deltaX: 25, deltaY: 8, altKey: true, cancelable: true }));
          const transform = await wait(() => content.style.transform !== initialTransform && content.style.transform, 'A pan did not apply');
          first.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
          await wait(() => document.querySelector('.wall-ppt'), 'A presentation did not open');
          await switchTo(f[1], () => key('2'));
          const otherWallClear = !wall() && !document.querySelector('.wall-ppt');
          click(nav('静帧墙'));
          await wait(() => document.querySelector('.wall-source-tag'), 'B still wall missing');
          await switchTo(f[0], () => key('1'));
          await wait(() => document.querySelector('.wall-ppt'), 'A presentation did not restore');
          const restoredWall = wall();
          const selection = Array.from(restoredWall.querySelectorAll('.wall-card.selected')).map((card) => card.dataset.shotId);
          const restoredTransform = restoredWall.querySelector('.wall-content').style.transform;
          const ownCanvas = selection.length === 1 && f[0].shots.includes(selection[0]) && restoredTransform === transform;
          await switchTo(f[1], () => key('2'));
          const stillWallRestored = !!document.querySelector('.wall-source-tag') && !document.querySelector('.wall-ppt');
          const persisted = await wait(async () => {
            const session = await window.api.session.get();
            if (!session.ok || session.data?.projectId !== f[1].id) return false;
            const saved = session.data.openProjects;
            return saved?.length === 3 &&
              saved.find((item) => item.projectId === f[0].id)?.wallSession?.open === 'storyboard' &&
              saved.find((item) => item.projectId === f[1].id)?.wallSession?.open === 'stills';
          }, 'project tab and wall sessions did not persist');
          out.wallState = { otherWallClear, ownCanvas, stillWallRestored, persisted, selection, transform, restoredTransform };
          out.passed = out.singleProjectLayout && out.threeProjects && out.deduplication &&
            checks.every((entry) => entry.wall && entry.stills) && otherWallClear && ownCanvas && stillWallRestored && persisted;
        } else {
          for (const [index, project] of f.entries()) {
            if (index) await switchTo(project);
            click(document.querySelector('.shot-row:nth-child(2)'));
            const seek = await window.api.player.seek({ timeMs: project.timeMs });
            if (!seek.ok) throw new Error(seek.error.message);
            await wait(() => Math.abs(state().timeMs - seek.data.timeMs) <= 40, 'seek did not reach renderer');
            project.verifiedTime = seek.data.timeMs;
          }
          const samples = [];
          let crossed = 0;
          const observer = new MutationObserver(() => {
            const workspace = document.querySelector('.workspace-stack');
            const id = document.querySelector('.workspace-stack [aria-current=page]')?.dataset.projectId;
            if (!workspace?.inert && id) {
              const expected = f.find((project) => project.id === id);
              if (expected && rows().some((shot) => !expected.shots.includes(shot))) crossed += 1;
            }
          });
          observer.observe(document.body, { attributes: true, childList: true, subtree: true });
          for (let index = 0; index < 50; index += 1) {
            const project = f[index % 3];
            const ms = await switchTo(project, index === 0 ? () => key('1') : index === 1 ? () => key('Tab') : undefined);
            const player = await window.api.player.getState();
            const restored = state();
            samples.push({ project: project.name, ms, timeMs: player.ok ? player.data.timeMs : null,
              selection: restored.selectedShotId === project.shots[1],
              layout: rows().join(',') === project.shots.join(','),
              correctTime: player.ok && player.data.paused && Math.abs(player.data.timeMs - project.verifiedTime) <= 90 });
          }
          observer.disconnect();
          out.samples = samples;
          out.domCrossFrames = crossed;
          out.passed = out.threeProjects && out.deduplication && crossed === 0 &&
            samples.every((sample) => sample.selection && sample.layout && sample.correctTime);
        }
        return out;
      } catch (error) {
        return { ...out, passed: false, error: error.stack || String(error) };
      }
    })()
  `, true) as Record<string, unknown>;

  if (gate === 'switch') {
    const log = process.env['DSH_PLAYER_DEBUG'];
    const entries = log && existsSync(log)
      ? readFileSync(log, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as {
          event?: string; active?: boolean; overlayVisible?: boolean; projectTransition?: boolean; sourcePath?: string;
        })
      : [];
    const hidden = entries.filter((entry) => entry.event === 'project-transition' && entry.active);
    const opened = entries.filter((entry) => entry.event === 'file-opened' && entry.projectTransition);
    const expected = fixture.flatMap((item) => [resolve(item.path)]);
    out.overlayHiddenBeforeOpen = hidden.length >= 50 && hidden.every((entry) => entry.overlayVisible !== true) &&
      opened.length >= 50 && opened.every((entry) => entry.overlayVisible !== true && expected.includes(entry.sourcePath ?? ''));
    out.passed = out.passed === true && out.overlayHiddenBeforeOpen === true;
  }
  if (gate !== 'close' || !out.fixtureReady) return out;

  const baseline = memoryKiB();
  const closed = await win.webContents.executeJavaScript(`
    (async () => {
      const f = ${JSON.stringify(fixture)};
      const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      const wait = async (check, label) => {
        const deadline = Date.now() + 10000;
        while (Date.now() < deadline) {
          const result = await check();
          if (result) return result;
          await sleep(20);
        }
        throw new Error(label);
      };
      const open = async (p) => {
        [...document.querySelectorAll('.main-nav button')].find((item) => item.textContent.trim() === '项目中心').click();
        const row = await wait(() => [...document.querySelectorAll('.project-row')].find((item) => item.querySelector('strong')?.textContent === p.name), 'project missing');
        row.click();
        document.querySelector('.project-heading button').click();
        await wait(() => !document.querySelector('.workspace-stack')?.inert &&
          window.__CAPTURE_WORKSPACE_STATE__().projectId === p.id, 'project did not open');
      };
      try {
        await open(f[1]);
        await open(f[2]);
        const detectOptions = { sensitivity: 0.62, minShotSeconds: 0.5, filterTransitions: true,
          weights: {s: 0.3, c: 0.3, h: 0.4}, intervalMs: 75, boundaryEngine: 'opencv' };
        await window.api.projectTasks.setPaused({ projectId: f[0].id, paused: true });
        const keep = await window.api.detect.runBoundary({ projectId: f[0].id, options: detectOptions });
        if (!keep.ok) throw new Error(JSON.stringify(keep.error));
        const boundary = await window.api.detect.runBoundary({ projectId: f[1].id, options: detectOptions });
        if (!boundary.ok) throw new Error(JSON.stringify(boundary.error));
        const proxy = window.api.media.transcodeProxy({ projectId: f[1].id, sourcePath: f[1].path });
        const buttonFor = (project) => document.querySelector('.project-tab-select[data-project-id="' + project.id + '"]')?.parentElement;
        await wait(async () => {
          const result = await window.api.projectTasks.list({ projectId: f[1].id });
          return result.ok && result.data.some((task) => task.kind === 'boundary');
        }, 'B task not listed');
        buttonFor(f[1]).dispatchEvent(new MouseEvent('auxclick', { button: 1, bubbles: true, cancelable: true }));
        const prompt = await wait(() => document.querySelector('[role=alertdialog]'), 'close confirmation missing');
        const dismiss = [...prompt.querySelectorAll('button')].find((item) => item.textContent === '取消');
        dismiss.click();
        await wait(() => !document.querySelector('[role=alertdialog]'), 'cancel did not dismiss close prompt');
        const cancelledCloseKeepsTab = !!buttonFor(f[1]);
        buttonFor(f[1]).querySelector('.project-tab-close').click();
        const confirm = await wait(() => document.querySelector('[role=alertdialog]'), 'second close confirmation missing');
        [...confirm.querySelectorAll('button')].find((item) => item.textContent === '保存并关闭').click();
        await wait(() => !buttonFor(f[1]), 'B tab did not close');
        const keepAfter = await window.api.detect.getJob({ jobId: keep.data.jobId });
        const removed = await window.api.detect.getJob({ jobId: boundary.data.jobId });
        const remaining = await window.api.projectTasks.list({ projectId: f[1].id });
        const proxyResult = await proxy;
        buttonFor(f[2]).querySelector('.project-tab-close').click();
        await wait(() => !document.querySelector('.project-tabs') &&
          !document.querySelector('.workspace-stack')?.inert &&
          window.__CAPTURE_WORKSPACE_STATE__().projectId === f[0].id, 'A did not survive');
        return {
          cancelledCloseKeepsTab,
          siblingJobRetained: keepAfter.ok && keepAfter.data.status === 'queued',
          ownJobsReleased: !removed.ok && remaining.ok && remaining.data.length === 0,
          ownProxyResult: proxyResult.ok ? 'finished-before-close' : proxyResult.error.code,
          activeAfterClose: true,
        };
      } catch (error) { return { closeError: error.stack || String(error), toast: document.querySelector('.toast-copy')?.textContent?.trim() }; }
    })()
  `, true) as Record<string, unknown>;
  await new Promise((done) => setTimeout(done, 1800));
  const after = memoryKiB();
  const frameRoot = resolveDetectFramesDir(fixture[1].id);
  const tempCleared = !existsSync(frameRoot) || readdirSync(frameRoot).length === 0;
  const dataRetained = fixture.every((project) => Boolean(data.projects.get(project.id)) && existsSync(project.path));
  return {
    ...out, ...closed, baselineKiB: baseline, afterKiB: after, memoryRatio: after / baseline, tempCleared, dataRetained,
    passed: closed.cancelledCloseKeepsTab === true && closed.siblingJobRetained === true &&
      closed.ownJobsReleased === true && closed.activeAfterClose === true &&
      tempCleared && dataRetained && after <= baseline * 1.2,
  };
}
