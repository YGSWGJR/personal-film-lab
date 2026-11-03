import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { DataError } from './errors';

/** 项目资源目录结构（S01 §7.4） */
export const PROJECT_SUBDIRS = ['source', 'proxy', 'frames', 'stills', 'exports'] as const;

export function ensureProjectDirs(dataRoot: string, projectId: string): string {
  const dir = resolve(dataRoot, 'projects', projectId);
  mkdirSync(dir, { recursive: true });
  for (const sub of PROJECT_SUBDIRS) {
    mkdirSync(resolve(dir, sub), { recursive: true });
  }
  return dir;
}

export function projectDirOf(dataRoot: string, projectId: string): string {
  return resolve(dataRoot, 'projects', projectId);
}

/** 项目 ID 安全校验：拒绝绝对路径、目录穿越（..）与路径分隔符（S36-1a） */
export function isSafeProjectId(projectId: string): boolean {
  return (
    projectId.length > 0 &&
    !isAbsolute(projectId) &&
    projectId !== '.' &&
    projectId !== '..' &&
    !projectId.includes('/') &&
    !projectId.includes('\\')
  );
}

/**
 * 永久删除项目目录（不进回收站，S36-1）。
 * 越权/穿越路径直接抛 DELETE_PATH_UNSAFE；删除失败抛 DELETE_FAILED。
 */
export function removeProjectDir(dataRoot: string, projectId: string): void {
  if (!isSafeProjectId(projectId)) {
    throw new DataError('DELETE_PATH_UNSAFE', `非法项目 ID：${projectId}`, { projectId });
  }
  const root = resolve(dataRoot);
  const dir = projectDirOf(dataRoot, projectId);
  if (dir === root || !dir.startsWith(`${root}${sep}`)) {
    throw new DataError(
      'DELETE_PATH_UNSAFE',
      `项目目录必须位于数据根之内：${dir}`,
      { dir, dataRoot: root },
    );
  }
  if (!existsSync(dir)) return;
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch (error) {
    const reason = (error as Error).message;
    throw new DataError('DELETE_FAILED', `项目目录删除失败：${dir}`, { dir, reason });
  }
}

/** 若文件在项目目录内，返回相对项目目录的路径（保存到 DB）；相对路径入参直接视为项目内路径 */
export function toProjectRelativePath(dataRoot: string, projectId: string, filePath: string): string {
  // 相对路径本就是项目目录内的路径（S01 约定），统一成正斜杠
  if (!isAbsolute(filePath)) {
    return filePath.split(/[\\/]/u).filter((part) => part.length > 0).join('/');
  }
  const dir = projectDirOf(dataRoot, projectId);
  const rel = relative(dir, resolve(filePath));
  if (rel.length > 0 && !isAbsolute(rel) && !rel.startsWith('..') && !rel.includes(`..${sep}`)) {
    return rel.split(sep).join('/');
  }
  return filePath;
}

/** 把 DB 里的路径解析为绝对路径（相对路径相对项目目录） */
export function resolveProjectFilePath(dataRoot: string, projectId: string, filePath: string): string {
  const dir = projectDirOf(dataRoot, projectId);
  return /^[a-zA-Z]:[\\/]/u.test(filePath) || filePath.startsWith('/')
    ? filePath
    : resolve(dir, filePath);
}

/**
 * 永久删除项目关联的单个文件（不进回收站，S36-1）；路径必须位于项目目录或调用方声明的安全根目录内。
 * 越权路径抛 DELETE_PATH_UNSAFE；删除失败收集后统一抛 DELETE_FAILED（经 IPC 透传渲染层显式报错）。
 */
export function removeProjectFiles(
  dataRoot: string,
  projectId: string,
  filePaths: Array<string | null | undefined>,
  extraSafeRoots: string[] = [],
): void {
  const projectDir = projectDirOf(dataRoot, projectId);
  const safeRoots = [projectDir, ...extraSafeRoots].map((root) => resolve(root));
  const seen = new Set<string>();
  const failures: Array<{ path: string; reason: string }> = [];
  for (const filePath of filePaths) {
    if (!filePath) continue;
    const target = resolveProjectFilePath(dataRoot, projectId, filePath);
    if (seen.has(target)) continue;
    seen.add(target);
    const safe = safeRoots.some(
      (root) => target.startsWith(`${root}${sep}`) && target !== root,
    );
    if (!safe) {
      console.warn(`[data] reject unsafe file deletion outside project roots: ${target}`);
      throw new DataError(
        'DELETE_PATH_UNSAFE',
        `拒绝删除项目目录之外的文件：${target}`,
        { path: target, safeRoots },
      );
    }
    try {
      rmSync(target, { force: true });
    } catch (error) {
      failures.push({ path: target, reason: (error as Error).message });
    }
  }
  if (failures.length > 0) {
    throw new DataError(
      'DELETE_FAILED',
      `文件删除失败（${failures.length} 个）`,
      { failures },
    );
  }
}

/** 文件系统安全名（用于导出包名） */
export function sanitizeName(name: string): string {
  const cleaned = name.replace(/[\\/:*?"<>|]/g, '_').trim();
  return cleaned.length > 0 ? cleaned.slice(0, 80) : 'project';
}
