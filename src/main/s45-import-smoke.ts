import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { dialog, type BrowserWindow, type OpenDialogReturnValue } from 'electron';

export async function runMediaPickerSmoke(win: BrowserWindow): Promise<Record<string, unknown>> {
  const paths = [1, 2, 3].map((index) => process.env[`SMOKE_PROJECT_FIXTURE_${index}`]);
  if (!process.env['DSH_DATA_ROOT'] || !process.env['DSH_USER_DATA_ROOT'] ||
      paths.some((file) => !file || !existsSync(file))) {
    return { passed: false, error: 'The picker smoke test requires three videos and isolated data/profile directories.' };
  }

  const [first, second, third] = paths.map((file) => resolve(file!));
  const picks = [null, first, second, third, second];
  let dialogs = 0;
  const original = dialog.showOpenDialog;
  // Supply the Windows picker result only. The renderer, preload, IPC handler and player remain live.
  dialog.showOpenDialog = async (): Promise<OpenDialogReturnValue> => {
    if (dialogs >= picks.length) throw new Error('Unexpected extra media picker call');
    const path = picks[dialogs++];
    return path ? { canceled: false, filePaths: [path] } : { canceled: true, filePaths: [] };
  };

  try {
    const result = await win.webContents.executeJavaScript(`
      (async () => {
        const paths = ${JSON.stringify({ first, second, third })};
        const out = {};
        const state = () => window.__CAPTURE_WORKSPACE_STATE__();
        const loads = [];
        const unsubscribe = window.api.player.onLoaded((media) => loads.push(media.path));
        const button = (selector, label) => [...document.querySelectorAll(selector)]
          .find((item) => item.textContent.trim() === label);
        const click = (item) => {
          if (!item || item.disabled) throw new Error('Missing or disabled button');
          item.click();
        };
        const wait = async (check, reason) => {
          const deadline = performance.now() + 12000;
          while (performance.now() < deadline) {
            const value = await check();
            if (value) return value;
            await new Promise((resolve) => setTimeout(resolve, 30));
          }
          throw new Error(reason + ' ' + (document.querySelector('.toast-copy')?.textContent?.trim() ?? ''));
        };
        const projects = async () => {
          const list = await window.api.project.list();
          if (!list.ok) throw new Error(list.error.message);
          return list.data;
        };
        const workspaceReady = () => !document.querySelector('.workspace-stack')?.inert;
        const navigation = (label) => button('.main-nav button', label);
        const openCenter = async () => {
          click(navigation('项目中心'));
          await wait(() => document.querySelector('.project-center'), 'Project center did not open');
        };
        const opened = async (path) => wait(async () => {
          if (!workspaceReady()) return false;
          const project = (await projects()).find((entry) => entry.source.path === path);
          return project && project.id === state().projectId && loads.includes(path) && project;
        }, 'The imported video did not reach the active player.');

        try {
          const before = (await projects()).length;
          const canceled = await window.api.player.pickMedia();
          if (!canceled.ok) throw new Error(canceled.error.code + ' ' + canceled.error.message);
          out.cancelReturnsNull = canceled.data === null && (await projects()).length === before;

          click(navigation('导入影片'));
          const first = await opened(paths.first);
          out.topBarImport = first.mediaItems.length === 1 && first.media.durationMs > 0;

          await openCenter();
          click(button('.project-center .actions button', '导入影片到新项目'));
          const second = await opened(paths.second);
          out.centerImport = second.id !== first.id && (await projects()).length === before + 2;

          await openCenter();
          click(button('.project-center .media-title button', '+ 追加视频'));
          const appended = await opened(paths.third);
          out.appendToProject = appended.id === second.id && appended.mediaItems.length === 2 &&
            appended.mediaItems.some((media) => media.source.path === paths.second) &&
            appended.mediaItems.some((media) => media.source.path === paths.third);

          await openCenter();
          click([...document.querySelectorAll('.project-row')]
            .find((row) => row.querySelector('strong')?.textContent === first.name));
          await wait(() => document.querySelector('.project-heading h3')?.textContent === first.name,
            'The inactive project was not selected in the center.');
          const oldLoadCount = loads.length;
          click(button('.project-center .media-card button', '重定位'));
          await wait(async () => {
            const found = await window.api.project.get({ id: first.id });
            return found.ok && found.data.mediaItems[0]?.source.path === paths.second &&
              document.querySelector('.project-center .media-card button')?.disabled === false;
          }, 'Relinking did not update the original media.');
          out.relinkInactiveProject = state().projectId === second.id &&
            state().activeMediaId === appended.activeMediaId && loads.length === oldLoadCount;
          return out;
        } catch (error) {
          return { ...out, error: error.message };
        } finally {
          unsubscribe();
        }
      })()
    `, true) as Record<string, unknown>;
    return { ...result, dialogs, passed: !result['error'] &&
      dialogs === picks.length &&
      ['cancelReturnsNull', 'topBarImport', 'centerImport', 'appendToProject', 'relinkInactiveProject']
        .every((name) => result[name] === true) };
  } finally {
    dialog.showOpenDialog = original;
  }
}
