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
      const fileResponse = await net.fetch(pathToFileURL(target).toString());
      // 批次9：补 CORS 头——渲染层把资产画进 canvas（复合缩略图/投影截图导出）需要跨域许可，
      // 否则 toDataURL 抛 SecurityError（tainted canvas）。
      const headers = new Headers(fileResponse.headers);
      headers.set('Access-Control-Allow-Origin', '*');
      return new Response(fileResponse.body, {
        status: fileResponse.status,
        statusText: fileResponse.statusText,
        headers,
      });
    } catch {
      return new Response('Not found', { status: 404 });
    }
  });
}
