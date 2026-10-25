import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';

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

export function removeProjectDir(dataRoot: string, projectId: string): void {
  const dir = projectDirOf(dataRoot, projectId);
  if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
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

/** 删除项目关联的单个文件；路径必须位于项目目录或调用方声明的安全根目录内。 */
export function removeProjectFiles(
  dataRoot: string,
  projectId: string,
  filePaths: Array<string | null | undefined>,
  extraSafeRoots: string[] = [],
): void {
  const projectDir = projectDirOf(dataRoot, projectId);
  const safeRoots = [projectDir, ...extraSafeRoots].map((root) => resolve(root));
  const seen = new Set<string>();
  for (const filePath of filePaths) {
    if (!filePath) continue;
    const target = resolveProjectFilePath(dataRoot, projectId, filePath);
    if (seen.has(target)) continue;
    seen.add(target);
    const safe = safeRoots.some(
      (root) => target.startsWith(`${root}${sep}`) && target !== root,
    );
    if (!safe) {
      console.warn(`[data] skip unsafe file deletion outside project roots: ${target}`);
      continue;
    }
    try {
      rmSync(target, { force: true });
    } catch (error) {
      console.warn(`[data] file deletion failed: ${target}: ${(error as Error).message}`);
    }
  }
}

/** 文件系统安全名（用于导出包名） */
export function sanitizeName(name: string): string {
  const cleaned = name.replace(/[\\/:*?"<>|]/g, '_').trim();
  return cleaned.length > 0 ? cleaned.slice(0, 80) : 'project';
}
