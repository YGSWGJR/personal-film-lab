import { net, protocol } from 'electron';
import { pathToFileURL } from 'node:url';
import { isAbsolute, resolve, sep } from 'node:path';

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
export function registerAssetProtocol(getAllowedRoots: () => string[]): void {
  protocol.handle(ASSET_SCHEME, async (request) => {
    try {
      const url = new URL(request.url);
      const projectId = decodeURIComponent(url.hostname);
      const relativePath = decodeURIComponent(url.pathname.replace(/^\/+/u, ''));
      const roots = getAllowedRoots().map((root) => resolve(root));
      const projectRoot = resolve(roots[0] ?? '', projectId);
      const target = isAbsolute(relativePath)
        ? resolve(relativePath)
        : resolve(projectRoot, relativePath);
      const allowed = isAbsolute(relativePath)
        ? roots.some((root) => target === root || target.startsWith(`${root}${sep}`))
        : target.startsWith(`${projectRoot}${sep}`);
      if (!allowed) {
        return new Response('Forbidden', { status: 403 });
      }
      return net.fetch(pathToFileURL(target).toString());
    } catch {
      return new Response('Not found', { status: 404 });
    }
  });
}
