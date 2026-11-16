import { copyFileSync, existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BrowserWindow } from 'electron';
import Database from 'better-sqlite3';
import { DataLayer } from '../data/db';
import { ProjectPackageService } from '../data/project-package';

export type MediaScopeGate = 'timeline' | 'wall' | 'stills';

export async function runMediaScopeGate(
  win: BrowserWindow,
  data: DataLayer,
  gate: MediaScopeGate,
): Promise<Record<string, unknown>> {
  const firstPath = process.env['SMOKE_PROJECT_VIDEO_ONE'];
  const secondPath = process.env['SMOKE_PROJECT_VIDEO_TWO'];
  if (!firstPath || !secondPath || !existsSync(firstPath) || !existsSync(secondPath)) {
    return { passed: false, reason: 'Two playable media fixtures are required' };
  }
  const project = data.projects.create({
    name: `S45 media scope - ${gate}`,
    source: { type: 'local', path: firstPath },
    media: { filename: 'NTM A.mp4', durationMs: 35754, fps: 29.97 },
  });
  const a = project.activeMediaId;
  if (!a) return { passed: false, reason: 'Missing first media' };
  const b = data.projectMedia.add({
    projectId: project.id,
    source: { type: 'local', path: secondPath },
    media: { filename: 'NTM B.mp4', durationMs: 12000, fps: 29.97 },
    activate: false,
  }).id;
  const makeShot = (mediaId: string, startMs: number, endMs: number) =>
    data.shots.create({ projectId: project.id, mediaId, startMs, endMs }).id;
  const a1 = makeShot(a, 0, 4000);
  const a2 = makeShot(a, 4000, 8000);
  const b1 = makeShot(b, 0, 5000);
  if (gate === 'wall') {
    data.wall.saveLayout(project.id, [{ shotId: a1, x: 112, y: 87 }], a);
    data.wall.saveLayout(project.id, [{ shotId: b1, x: 222, y: 74 }], b);
    data.wall.addEdge(project.id, a1, a2, 'solid', a);
    data.wall.saveAnnotations(project.id, a1, [{ type: 'text', color: '#fff', data: { text: 'A' } }], a);
  }
  if (gate === 'stills') {
    const dir = join(data.dataRoot, 'projects', project.id, 'stills');
    mkdirSync(dir, { recursive: true });
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWdgAAAAASUVORK5CYII=', 'base64');
    for (const [name, mediaId, shotId, role] of [
      ['a', a, a1, 'main'],
      ['b', b, b1, 'main'],
      ['thumb', b, b1, 'auto-thumb'],
    ] as const) {
      const filePath = join(dir, `${name}.png`);
      writeFileSync(filePath, png);
      data.stills.create({ projectId: project.id, mediaId, shotId, role, timeMs: 1000, filePath });
    }
  }
  const fixture = { project: project.id, a, b, a1, a2, b1 };
  const result = (await win.webContents.executeJavaScript(`
    (async () => {
      const f = ${JSON.stringify(fixture)};
      const result = {};
      const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      const waitFor = async (test, label) => {
        const deadline = Date.now() + 12000;
        while (Date.now() < deadline) {
          const value = await test();
          if (value) return value;
          await pause(15);
        }
        throw new Error(label);
      };
      const click = (selector) => {
        const el = document.querySelector(selector);
        if (!el) throw new Error('Missing ' + selector);
        el.click();
      };
      const tab = async (index, mediaId) => {
        const start = performance.now();
        click('.media-tab:nth-child(' + index + ')');
        await waitFor(async () => {
          const saved = await window.api.session.get();
          return saved.ok && saved.data?.activeMediaId === mediaId &&
            document.querySelector('.media-tab:nth-child(' + index + ')')?.ariaSelected === 'true';
        }, 'Active media not restored: ' + mediaId);
        return Math.round(performance.now() - start);
      };
      const shots = () => document.querySelectorAll('.shot-row').length;
      const closeWall = async () => {
        click('.wall-close');
        await waitFor(() => !document.querySelector('.wall-stage'), 'Wall did not close');
        await window.__S43_WALL_TEST__.setProjection(false);
      };
      const openWall = async () => {
        await window.__S43_WALL_TEST__.openProjectWall();
        await waitFor(() => document.querySelector('.wall-stage'), 'Project wall did not open');
      };
      try {
        const opened = await window.__S43_WALL_TEST__.openProject(f.project);
        if (!opened.ok) throw new Error(JSON.stringify(opened.error));
        await waitFor(() => shots() === 2, 'Initial two-shot media not shown');
        switch (${JSON.stringify(gate)}) {
          case 'timeline': {
            const zoom = async (height, density) => {
              click('.zoom-btn');
              const inputs = document.querySelectorAll('.zoom-row input[type=number]');
              for (const [index, value] of [[0, height], [1, density]]) {
                const input = inputs[index];
                input.focus();
                input.value = value;
                input.dispatchEvent(new Event('input', { bubbles: true }));
                input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
                input.blur();
                await pause(50);
              }
              click('.zoom-btn');
            };
            const timeline = () => document.querySelector('.zoom-btn')?.textContent ?? '';
            await zoom(192, 384);
            click('.shot-row:nth-child(2)');
            await waitFor(async () => {
              const selected = await window.api.player.getState();
              return selected.ok && Math.abs(selected.data.timeMs - 4000) <= 80;
            }, 'Second shot seek not settled');
            await window.__S40_SHOT_EDIT_TEST__.setTime(6500);
            click('.track-row-v1 .head-control[title*="锁"]');
            const nowA = await window.api.player.getState();
            const sessionA = await waitFor(async () => {
              const saved = await window.api.session.get();
              return saved.ok && saved.data?.mediaSessions?.[f.a]?.timeline?.view?.v1Locked && saved.data;
            }, 'First track state not persisted');
            const latencyB = await tab(2, f.b);
            await zoom(48, 24);
            await window.__S40_SHOT_EDIT_TEST__.setTime(1500);
            const nowB = await window.api.player.getState();
            const latencyA = await tab(1, f.a);
            await waitFor(() => shots() === 2 && timeline().includes('192px') &&
              timeline().includes('384 px/s') &&
              document.querySelector('.track-row-v1 .head-control[title*="锁"]')?.ariaPressed === 'true',
            'First timeline DOM not restored');
            const restoredA = await window.api.player.getState();
            const lockedA = document.querySelector('.track-row-v1 .head-control[title*="锁"]')?.ariaPressed;
            const expectedA = sessionA.mediaSessions[f.a];
            const session = await window.api.session.get();
            result.firstViewRestored = shots() === 2 && timeline().includes('192px') &&
              timeline().includes('384 px/s') && lockedA === 'true' &&
              expectedA.selectedShotId === f.a2 && session.data?.selectedShotId === f.a2;
            result.firstPlayerRestored = nowA.ok && Math.abs(nowA.data.timeMs - 6500) <= 80 &&
              restoredA.ok && restoredA.data.hasFile &&
              Math.abs(nowA.data.timeMs - restoredA.data.timeMs) <= 80;
            const latencyBReturn = await tab(2, f.b);
            await waitFor(() => shots() === 1 && timeline().includes('48px') &&
              timeline().includes('24 px/s') &&
              document.querySelector('.track-row-v1 .head-control[title*="锁"]')?.ariaPressed === 'false',
            'Second timeline DOM not restored');
            const restoredB = await window.api.player.getState();
            result.secondViewRestored = shots() === 1 && timeline().includes('48px') &&
              timeline().includes('24 px/s') &&
              document.querySelector('.track-row-v1 .head-control[title*="锁"]')?.ariaPressed === 'false';
            result.secondPlayerRestored = nowB.ok && restoredB.ok && restoredB.data.hasFile &&
              Math.abs(nowB.data.timeMs - restoredB.data.timeMs) <= 80;
            result.measured = { latencyMs: [latencyB, latencyA, latencyBReturn],
              first: [nowA.data?.timeMs, restoredA.data?.timeMs], second: [nowB.data?.timeMs, restoredB.data?.timeMs] };
            const saved = await window.api.session.get();
            result.sessionPersisted = saved.ok && saved.data?.mediaSessions?.[f.a]?.timeline?.trackHeight === 192 &&
              saved.data?.mediaSessions?.[f.b]?.timeline?.trackHeight === 48 &&
              saved.data?.activeMediaId === f.b;
            break;
          }
          case 'wall': {
            const scoped = (mediaId) => ({ projectId: f.project, mediaId });
            const mixed = await window.api.wall.addEdge({
              ...scoped(f.a), fromShotId: f.a1, toShotId: f.b1, kind: 'solid',
            });
            const badLayout = await window.api.wall.saveLayout({
              ...scoped(f.a), items: [{ shotId: f.b1, x: 0, y: 0 }],
            });
            const badGroup = await window.api.wall.createGroup({
              ...scoped(f.a), name: 'Invalid', shotIds: [f.a1, f.b1],
            });
            result.crossMediaRejected = [mixed, badLayout, badGroup].every(
              (item) => !item.ok && item.error.code === 'WALL_SHOT_NOT_IN_MEDIA');
            await openWall();
            await waitFor(() => document.querySelectorAll('.wall-card').length === 2 &&
              document.querySelectorAll('.wall-edges > path').length === 1, 'First wall nodes or edge missing');
            result.firstWallScoped = Boolean(document.querySelector('.wall-card[style*="left: 112px"]'));
            await closeWall();
            await tab(2, f.b);
            await openWall();
            await waitFor(() => document.querySelectorAll('.wall-card').length === 1, 'Second wall rendered count');
            result.secondWallScoped = !document.querySelector('.wall-edges > path') &&
              Boolean(document.querySelector('.wall-card[style*="left: 222px"]'));
            const annot = await window.api.wall.listAnnotations(scoped(f.b));
            result.annotationsScoped = annot.ok && Object.keys(annot.data).length === 0;
            const allProgress = await window.api.stats.progress({ projectId: f.project });
            const mediaProgress = await window.api.stats.progress(scoped(f.b));
            result.statsScope = allProgress.ok && allProgress.data.totalShots === 3 &&
              mediaProgress.ok && mediaProgress.data.totalShots === 1;
            break;
          }
          case 'stills': {
            const openStills = () => {
              const button = [...document.querySelectorAll('.main-nav button')].find((el) => el.textContent.trim() === '静帧墙');
              if (!button) throw new Error('Missing still wall button');
              button.click();
              return waitFor(() => document.querySelector('.wall-source-filter select'), 'Missing source selector');
            };
            const filter = (el, value) => {
              el.value = value;
              el.dispatchEvent(new Event('change', { bubbles: true }));
            };
            const cards = () => [...document.querySelectorAll('.wall-card')];
            const select = await openStills();
            await waitFor(() => cards().length === 2, 'Both stills did not render');
            const before = cards().map((node) => node.getAttribute('style'));
            result.sharedWall = document.querySelector('.wall-source-filter').textContent.includes('2 张');
            filter(select, f.a);
            await waitFor(() => cards().length === 1, 'Media A filter count');
            result.firstSource = cards()[0].querySelector('.wall-source-tag')?.textContent.includes('NTM A.mp4');
            filter(select, f.b);
            await waitFor(() => cards().length === 1 && cards()[0].textContent.includes('NTM B.mp4'), 'Media B filter count');
            result.secondSource = Boolean(cards()[0].querySelector('.wall-source-tag'));
            filter(select, '');
            await waitFor(() => cards().length === 2, 'Reset to all videos');
            result.filterLeavesLayout = JSON.stringify(before) === JSON.stringify(cards().map((node) => node.getAttribute('style')));
            await closeWall();
            await tab(2, f.b);
            const removed = await window.api.project.removeMedia({ projectId: f.project, mediaId: f.a });
            if (!removed.ok) throw new Error(JSON.stringify(removed.error));
            await window.__S43_WALL_TEST__.openProject(f.project);
            await openStills();
            await waitFor(() => cards().length === 1, 'Still wall did not remove deleted medium');
            result.remainingFrame = cards()[0].textContent.includes('NTM B.mp4');
            break;
          }
        }
      } catch (error) {
        result.exception = String(error?.stack ?? error);
      }
      return result;
    })()
  `)) as Record<string, unknown>;
  await win.webContents.executeJavaScript('window.api.player.close()');
  if (gate === 'wall') {
    const packages = new ProjectPackageService(data);
    const saved = packages.exportProject({ id: project.id, includeAssets: false });
    const imported = packages.importProject(saved.path).project;
    const [importA, importB] = imported.mediaItems;
    result.databaseAndPackage = data.wall.getLayout(project.id, a).length === 1 &&
      data.wall.getLayout(project.id, b).length === 1 &&
      !!importA && !!importB &&
      data.wall.getLayout(imported.id, importA.id)[0]?.x === 112 &&
      data.wall.getLayout(imported.id, importB.id)[0]?.x === 222 &&
      data.wall.listEdges(imported.id, importA.id).length === 1 &&
      data.wall.listEdges(imported.id, importB.id).length === 0;
    const fixtures = process.env['SMOKE_MEDIA_SCOPE_LEGACY'];
    if (fixtures) {
      const legacy = packages.importProject(join(fixtures, 'wall-v14.lapian')).project;
      const [first, second] = legacy.mediaItems;
      result.legacyPackage = !!first && !!second &&
        data.wall.getLayout(legacy.id, first.id)[0]?.x === 12.25 &&
        data.wall.getLayout(legacy.id, second.id)[0]?.x === 5 &&
        data.wall.listEdges(legacy.id, first.id).length === 1 &&
        data.wall.listGroups(legacy.id, first.id).length === 1 &&
        legacy.wallMigrationNotice?.edges === 1 && legacy.wallMigrationNotice.groups === 1 &&
        legacy.wallMigrationNotice.source === 'package';

      const legacyRoot = join(data.dataRoot, 'migration-fixture');
      mkdirSync(legacyRoot, { recursive: true });
      copyFileSync(join(fixtures, 'wall-v14.db'), join(legacyRoot, 'lapian.db'));
      const upgraded = new DataLayer(legacyRoot);
      try {
        const backups = readdirSync(join(legacyRoot, 'backups'));
        const backupName = backups.find((name) => name.startsWith('lapian-v14-'));
        if (!backupName) throw new Error('Migration backup was not created');
        const backup = new Database(join(legacyRoot, 'backups', backupName), { readonly: true });
        try {
          result.legacyMigrationBackup = backup.pragma('user_version', { simple: true }) === 14 &&
            !!backup.prepare("SELECT 1 FROM shot_edges WHERE from_shot = 'a3' AND to_shot = 'b1'").get() &&
            !!backup.prepare("SELECT 1 FROM shot_groups WHERE id = 'group-ab'").get() &&
            upgraded.db.pragma('user_version', { simple: true }) === 15 &&
            upgraded.wall.listEdges('p', 'a').length === 1 &&
            upgraded.projects.get('p').wallMigrationNotice?.groups === 1 &&
            (upgraded.db.pragma('foreign_key_check') as unknown[]).length === 0;
        } finally {
          backup.close();
        }
      } finally {
        upgraded.close();
      }
    }
  }
  if (gate === 'stills') {
    const stillWall = data.wallBoards.openStillWall(project.id);
    result.databaseAfterRemoval = stillWall.total === 1 &&
      data.wallBoards.listNodes(stillWall.boardId).length === 1 &&
      data.stills.listMainForProject(project.id)[0]?.mediaId === b &&
      data.projectMedia.list(project.id).map((item) => item.id).join() === b;
  }
  result.foreignKeys = (data.db.pragma('foreign_key_check') as unknown[]).length === 0;
  const expected = {
    timeline: ['firstViewRestored', 'firstPlayerRestored', 'secondViewRestored', 'secondPlayerRestored', 'sessionPersisted'],
    wall: ['crossMediaRejected', 'firstWallScoped', 'secondWallScoped', 'annotationsScoped', 'statsScope', 'databaseAndPackage'],
    stills: ['sharedWall', 'firstSource', 'secondSource', 'filterLeavesLayout', 'remainingFrame', 'databaseAfterRemoval'],
  }[gate];
  if (gate === 'wall' && process.env['SMOKE_MEDIA_SCOPE_LEGACY']) {
    expected.push('legacyPackage', 'legacyMigrationBackup');
  }
  return { ...result, passed: !result.exception && expected.every((field) => result[field] === true) && result.foreignKeys === true };
}
