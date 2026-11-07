import { copyFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { WallBoardsRepository } from '../../data/repositories/wall-boards';
import type { WallBoardFilePayload } from '../../shared/types';

/**
 * 批次8：分镜本独立保存。
 * 每个分镜本自动同步为 <boardSaveDir>/board-<id8>/（board.json + assets/），
 * 变更经 IPC 层 schedule 防抖落盘，可备份/携迁；导入见 ipc wall:importBoardFile。
 */
export class BoardExportService {
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(
    private readonly getBoards: () => WallBoardsRepository | null,
    private readonly getDir: () => string | null,
    private readonly getDataRoot: () => string,
  ) {}

  private get dataRoot(): string {
    return this.getDataRoot();
  }

  /** 保存目录（boardSaveDir 未配置时回退 exports/boards，仅作目录定位用） */
  resolveDir(): string | null {
    return this.getDir();
  }

  boardDir(boardId: string): string {
    const root = this.resolveDir();
    return join(root ?? '', `board-${boardId.slice(0, 8)}`);
  }

  schedule(boardId: string, delayMs = 800): void {
    const existing = this.timers.get(boardId);
    if (existing) clearTimeout(existing);
    this.timers.set(
      boardId,
      setTimeout(() => {
        this.timers.delete(boardId);
        this.exportNow(boardId);
      }, delayMs),
    );
  }

  cancel(boardId: string): void {
    const existing = this.timers.get(boardId);
    if (existing) clearTimeout(existing);
    this.timers.delete(boardId);
  }

  dispose(): void {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }

  /** 立即导出；失败静默（独立保存是附加保障，不打断主流程） */
  exportNow(boardId: string): { path: string; nodeCount: number } | null {
    try {
      const boards = this.getBoards();
      if (!boards || !this.resolveDir()) return null;
      const meta = boards.listBoards().find((board) => board.id === boardId);
      if (!meta) return null;
      const nodes = boards.listNodes(boardId);
      const boardDir = this.boardDir(boardId);
      const assetsDir = join(boardDir, 'assets');
      mkdirSync(assetsDir, { recursive: true });
      const payload: WallBoardFilePayload & { nodes: Array<Record<string, unknown>> } = {
        kind: 'lapian-board',
        version: 1,
        boardId,
        name: meta.name,
        exportedAt: new Date().toISOString(),
        nodes: nodes.map((node) => {
          let assetFile: string | null = null;
          if (node.source === 'image' && node.assetPath) {
            const fileName = node.assetPath.split(/[\\/]/u).pop() ?? null;
            const src = fileName
              ? join(this.dataRoot, 'projects', 'boards', boardId, fileName)
              : null;
            if (src && fileName && existsSync(src)) {
              copyFileSync(src, join(assetsDir, fileName));
              assetFile = fileName;
            }
          }
          return { ...node, assetFile };
        }),
        edges: boards
          .listNodeEdges(boardId)
          .map((edge) => ({ fromNodeId: edge.fromShotId, toNodeId: edge.toShotId, kind: edge.kind })),
        tags: Object.entries(boards.listTags(boardId)).flatMap(([nodeId, list]) =>
          list.map((tag) => ({ nodeId, category: tag.category, name: tag.name })),
        ),
        annotations: boards.listNodeAnnotations(boardId),
      };
      const target = join(boardDir, 'board.json');
      writeFileSync(target, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
      return { path: target, nodeCount: nodes.length };
    } catch {
      return null;
    }
  }
}
