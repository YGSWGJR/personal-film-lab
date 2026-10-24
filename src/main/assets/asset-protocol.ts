import { net, protocol } from 'electron';
import { pathToFileURL } from 'node:url';
import { resolve, sep } from 'node:path';

export const ASSET_SCHEME = 'lapian-asset';

export function registerAssetScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: ASSET_SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        stream: true,
      },
    },
  ]);
}

/** 仅暴露 projects/<id>/ 下的项目资源，阻止目录穿越读取用户文件。 */
export function registerAssetProtocol(dataRoot: string): void {
  protocol.handle(ASSET_SCHEME, async (request) => {
    try {
      const url = new URL(request.url);
      const projectId = decodeURIComponent(url.hostname);
      const relativePath = decodeURIComponent(url.pathname.replace(/^\/+/u, ''));
      const projectRoot = resolve(dataRoot, 'projects', projectId);
      const target = resolve(projectRoot, relativePath);
      if (!target.startsWith(`${projectRoot}${sep}`)) {
        return new Response('Forbidden', { status: 403 });
      }
      return net.fetch(pathToFileURL(target).toString());
    } catch {
      return new Response('Not found', { status: 404 });
    }
  });
}
