import { randomUUID } from 'node:crypto';
import type { DataLayer } from '../db';
import { DataError } from '../errors';

export interface WallBoardNode {
  id: string;
  source: 'image' | 'text';
  assetPath: string | null;
  title: string;
  durationMs: number;
  note: string;
  shotSize: string | null;
  cameraMethod: string | null;
  x: number;
  y: number;
}

/**
 * S44 独立分镜本仓储：board 元数据 + 节点/连线/标注。
 * 图片文件由 IPC 层复制到 <dataRoot>/projects/boards/<boardId>/（lapian-asset 白名单内），
 * 仓储只登记相对路径（boards/<boardId>/<file>）。
 */
export class WallBoardsRepository {
  constructor(private readonly layer: DataLayer) {}

  private get db() {
    return this.layer.db;
  }

  listBoards(): Array<{ id: string; name: string; nodeCount: number; updatedAt: string }> {
    const boards = this.db
      .prepare('SELECT id, name, updated_at FROM wall_boards ORDER BY updated_at DESC')
      .all() as Array<{ id: string; name: string; updated_at: number }>;
    const count = this.db.prepare('SELECT COUNT(*) AS n FROM wall_nodes WHERE board_id = ?');
    return boards.map((b) => ({
      id: b.id,
      name: b.name,
      nodeCount: (count.get(b.id) as { n: number }).n,
      updatedAt: new Date(b.updated_at).toISOString(),
    }));
  }

  createBoard(name: string): { id: string } {
    const trimmed = name.trim() || '未命名分镜本';
    const id = randomUUID();
    this.layer.transaction(() => {
      this.db
        .prepare(
          "INSERT INTO wall_boards (id, name, created_at, updated_at) VALUES (?, ?, strftime('%s','now') * 1000, strftime('%s','now') * 1000)",
        )
        .run(id, trimmed);
    });
    return { id };
  }

  deleteBoard(id: string): void {
    this.layer.transaction(() => {
      this.db.prepare('DELETE FROM wall_boards WHERE id = ?').run(id);
    });
  }

  renameBoard(id: string, name: string): void {
    this.layer.transaction(() => {
      this.db
        .prepare(
          "UPDATE wall_boards SET name = ?, updated_at = strftime('%s','now') * 1000 WHERE id = ?",
        )
        .run(name.trim() || '未命名分镜本', id);
    });
  }

  assertBoard(boardId: string): void {
    const row = this.db.prepare('SELECT id FROM wall_boards WHERE id = ?').get(boardId);
    if (!row) {
      throw new DataError('WALL_BOARD_NOT_FOUND', '分镜本不存在', { boardId });
    }
  }

  listNodes(boardId: string): WallBoardNode[] {
    this.assertBoard(boardId);
    const rows = this.db
      .prepare('SELECT * FROM wall_nodes WHERE board_id = ? ORDER BY created_at ASC')
      .all(boardId) as Array<Record<string, unknown>>;
    return rows.map(mapNode);
  }

  addNode(
    boardId: string,
    input: { source: 'image' | 'text'; assetPath?: string | null; title?: string; x: number; y: number },
  ): WallBoardNode {
    this.assertBoard(boardId);
    if (input.source !== 'image' && input.source !== 'text') {
      throw new DataError('WALL_ITEM_INVALID', '节点类型无效', { source: input.source });
    }
    if (input.source === 'image' && !input.assetPath) {
      throw new DataError('WALL_ITEM_INVALID', '图片节点缺少 assetPath', {});
    }
    const id = randomUUID();
    this.layer.transaction(() => {
      this.db
        .prepare(
          'INSERT INTO wall_nodes (id, board_id, source, asset_path, title, duration_ms, note, shot_size, camera_method, x, y, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 3000, ?, NULL, NULL, ?, ?, strftime(\'%s\',\'now\') * 1000, strftime(\'%s\',\'now\') * 1000)',
        )
        .run(id, boardId, input.source, input.assetPath ?? null, input.title ?? '', '', input.x, input.y);
    });
    return this.getNode(id);
  }

  getNode(id: string): WallBoardNode {
    const row = this.db.prepare('SELECT * FROM wall_nodes WHERE id = ?').get(id) as
      | Record<string, unknown>
      | undefined;
    if (!row) throw new DataError('WALL_NODE_NOT_FOUND', '节点不存在', { id });
    return mapNode(row);
  }

  updateNode(
    id: string,
    patch: Partial<Pick<WallBoardNode, 'title' | 'durationMs' | 'note' | 'shotSize' | 'cameraMethod' | 'x' | 'y'>>,
  ): WallBoardNode {
    const current = this.getNode(id);
    const next = {
      title: patch.title ?? current.title,
      durationMs: Math.max(200, Math.round(patch.durationMs ?? current.durationMs)),
      note: patch.note ?? current.note,
      shotSize: patch.shotSize !== undefined ? patch.shotSize : current.shotSize,
      cameraMethod: patch.cameraMethod !== undefined ? patch.cameraMethod : current.cameraMethod,
      x: patch.x ?? current.x,
      y: patch.y ?? current.y,
    };
    this.layer.transaction(() => {
      this.db
        .prepare(
          'UPDATE wall_nodes SET title = ?, duration_ms = ?, note = ?, shot_size = ?, camera_method = ?, x = ?, y = ?, updated_at = strftime(\'%s\',\'now\') * 1000 WHERE id = ?',
        )
        .run(next.title, next.durationMs, next.note, next.shotSize, next.cameraMethod, next.x, next.y, id);
    });
    return this.getNode(id);
  }

  deleteNode(id: string): void {
    this.layer.transaction(() => {
      this.db.prepare('DELETE FROM wall_nodes WHERE id = ?').run(id);
    });
  }

  listNodeEdges(boardId: string): Array<{ fromNodeId: string; toNodeId: string; kind: string }> {
    this.assertBoard(boardId);
    const rows = this.db
      .prepare('SELECT from_node, to_node, kind FROM wall_node_edges WHERE board_id = ? ORDER BY created_at ASC')
      .all(boardId) as Array<{ from_node: string; to_node: string; kind: string }>;
    return rows.map((r) => ({ fromNodeId: r.from_node, toNodeId: r.to_node, kind: r.kind }));
  }

  addNodeEdge(boardId: string, fromNodeId: string, toNodeId: string, kind: 'solid' | 'dash'): void {
    this.assertBoard(boardId);
    if (fromNodeId === toNodeId) {
      throw new DataError('WALL_EDGE_SELF', '连线不能从节点连到自身', { fromNodeId });
    }
    const exists = this.db.prepare('SELECT id FROM wall_nodes WHERE board_id = ? AND id = ?');
    if (!exists.get(boardId, fromNodeId) || !exists.get(boardId, toNodeId)) {
      throw new DataError('WALL_NODE_NOT_FOUND', '连线端点不属于该分镜本', { fromNodeId, toNodeId });
    }
    this.layer.transaction(() => {
      this.db
        .prepare(
          'INSERT INTO wall_node_edges (board_id, from_node, to_node, kind, created_at) VALUES (?, ?, ?, ?, strftime(\'%s\',\'now\') * 1000) ON CONFLICT(board_id, from_node, to_node) DO UPDATE SET kind = excluded.kind',
        )
        .run(boardId, fromNodeId, toNodeId, kind);
    });
  }

  removeNodeEdge(boardId: string, fromNodeId: string, toNodeId: string): void {
    this.assertBoard(boardId);
    this.layer.transaction(() => {
      this.db
        .prepare('DELETE FROM wall_node_edges WHERE board_id = ? AND from_node = ? AND to_node = ?')
        .run(boardId, fromNodeId, toNodeId);
    });
  }

  listNodeAnnotations(
    boardId: string,
  ): Record<string, Array<{ id: string; type: string; color: string; data: unknown }>> {
    this.assertBoard(boardId);
    const rows = this.db
      .prepare(
        'SELECT node_id, id, type, color, data_json FROM wall_node_annotations WHERE board_id = ? ORDER BY created_at ASC',
      )
      .all(boardId) as Array<{ node_id: string; id: string; type: string; color: string; data_json: string }>;
    const out: Record<string, Array<{ id: string; type: string; color: string; data: unknown }>> = {};
    for (const row of rows) {
      let data: unknown = {};
      try {
        data = JSON.parse(row.data_json);
      } catch {
        data = {};
      }
      const list = out[row.node_id] ?? [];
      list.push({ id: row.id, type: row.type, color: row.color, data });
      out[row.node_id] = list;
    }
    return out;
  }

  saveNodeAnnotations(
    boardId: string,
    nodeId: string,
    items: Array<{ type: string; color: string; data: unknown }>,
  ): void {
    this.assertBoard(boardId);
    this.getNode(nodeId);
    const TYPES = new Set(['brush', 'smear', 'line', 'arrow', 'rect', 'ellipse', 'text', 'mosaic']);
    for (const item of items) {
      if (!TYPES.has(item.type)) {
        throw new DataError('WALL_ITEM_INVALID', '标注类型无效', { type: item.type });
      }
    }
    this.layer.transaction(() => {
      this.db
        .prepare('DELETE FROM wall_node_annotations WHERE board_id = ? AND node_id = ?')
        .run(boardId, nodeId);
      const insert = this.db.prepare(
        'INSERT INTO wall_node_annotations (id, board_id, node_id, type, color, data_json, created_at) VALUES (?, ?, ?, ?, ?, ?, strftime(\'%s\',\'now\') * 1000)',
      );
      for (const item of items) {
        insert.run(randomUUID(), boardId, nodeId, item.type, item.color, JSON.stringify(item.data ?? {}));
      }
    });
  }

  /** 登记已复制到 projects/boards/<boardId>/ 的图片（IPC 层负责复制与校验） */
  registerImage(boardId: string, fileName: string): { assetPath: string } {
    this.assertBoard(boardId);
    if (!/^[a-f0-9-]+\.(jpe?g|png|webp|gif)$/i.test(fileName)) {
      throw new DataError('WALL_ITEM_INVALID', '文件名无效', { fileName });
    }
    return { assetPath: 'boards/' + boardId + '/' + fileName };
  }
}

function mapNode(row: Record<string, unknown>): WallBoardNode {
  return {
    id: String(row.id),
    source: row.source === 'text' ? 'text' : 'image',
    assetPath: (row.asset_path as string | null) ?? null,
    title: String(row.title ?? ''),
    durationMs: Number(row.duration_ms ?? 3000),
    note: String(row.note ?? ''),
    shotSize: (row.shot_size as string | null) ?? null,
    cameraMethod: (row.camera_method as string | null) ?? null,
    x: Number(row.x ?? 0),
    y: Number(row.y ?? 0),
  };
}
