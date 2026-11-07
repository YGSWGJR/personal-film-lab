import { randomUUID } from 'node:crypto';
import type { DataLayer } from '../db';
import { DataError } from '../errors';

export interface WallBoardNode {
  id: string;
  source: 'image' | 'text' | 'composite';
  assetPath: string | null;
  parentId: string | null;
  title: string;
  textContent: string;
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
    input: {
      source: 'image' | 'text' | 'composite';
      assetPath?: string | null;
      title?: string;
      x: number;
      y: number;
    },
  ): WallBoardNode {
    this.assertBoard(boardId);
    if (input.source !== 'image' && input.source !== 'text' && input.source !== 'composite') {
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

  /** 批次8：节点所属分镜本（删除/更新后定位导出目标） */
  boardIdOfNode(nodeId: string): string | null {
    const row = this.db.prepare('SELECT board_id FROM wall_nodes WHERE id = ?').get(nodeId) as
      | { board_id: string }
      | undefined;
    return row?.board_id ?? null;
  }

  updateNode(
    id: string,
    patch: Partial<
      Pick<WallBoardNode, 'title' | 'textContent' | 'durationMs' | 'note' | 'shotSize' | 'cameraMethod' | 'x' | 'y'>
    >,
  ): WallBoardNode {
    const current = this.getNode(id);
    const next = {
      title: patch.title ?? current.title,
      textContent: patch.textContent ?? current.textContent,
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
          'UPDATE wall_nodes SET title = ?, text_content = ?, duration_ms = ?, note = ?, shot_size = ?, camera_method = ?, x = ?, y = ?, updated_at = strftime(\'%s\',\'now\') * 1000 WHERE id = ?',
        )
        .run(next.title, next.textContent, next.durationMs, next.note, next.shotSize, next.cameraMethod, next.x, next.y, id);
    });
    return this.getNode(id);
  }

  deleteNode(id: string): void {
    this.layer.transaction(() => {
      this.db.prepare('DELETE FROM wall_nodes WHERE id = ?').run(id);
    });
  }

  /** 批次9：建复合节点——成员收编 + 外部连线重路由到复合节点（内部连线保留） */
  createComposite(boardId: string, nodeIds: string[]): { id: string } {
    this.assertBoard(boardId);
    const uniqueIds = [...new Set(nodeIds)];
    if (uniqueIds.length < 2) {
      throw new DataError('WALL_ITEM_INVALID', '复合节点至少需要 2 个节点', { count: uniqueIds.length });
    }
    const inBoard = this.db.prepare('SELECT source, parent_id, x, y FROM wall_nodes WHERE board_id = ? AND id = ?');
    const members = uniqueIds.map((nodeId) => {
      const row = inBoard.get(boardId, nodeId) as
        | { source: string; parent_id: string | null; x: number; y: number }
        | undefined;
      if (!row) throw new DataError('WALL_NODE_NOT_FOUND', '节点不存在或不属于该分镜本', { nodeId });
      if (row.source === 'composite' || row.parent_id) {
        throw new DataError('WALL_ITEM_INVALID', '复合节点不能嵌套或重复收编', { nodeId });
      }
      return { nodeId, x: row.x, y: row.y };
    });
    const centerX = members.reduce((sum, m) => sum + m.x, 0) / members.length;
    const centerY = members.reduce((sum, m) => sum + m.y, 0) / members.length;
    const compositeId = this.addNode(boardId, { source: 'composite', title: '复合节点', x: centerX, y: centerY }).id;
    const childSet = new Set(uniqueIds);
    this.layer.transaction(() => {
      const setParent = this.db.prepare('UPDATE wall_nodes SET parent_id = ?, updated_at = strftime(\'%s\',\'now\') * 1000 WHERE id = ?');
      for (const nodeId of uniqueIds) setParent.run(compositeId, nodeId);
      // 外部连线重路由：child↔外部 → composite↔外部（ON CONFLICT 幂等去重）
      const edges = this.db
        .prepare('SELECT from_node, to_node, kind FROM wall_node_edges WHERE board_id = ?')
        .all(boardId) as Array<{ from_node: string; to_node: string; kind: string }>;
      const deleteEdge = this.db.prepare('DELETE FROM wall_node_edges WHERE board_id = ? AND from_node = ? AND to_node = ?');
      const insertEdge = this.db.prepare(
        'INSERT INTO wall_node_edges (board_id, from_node, to_node, kind, created_at) VALUES (?, ?, ?, ?, strftime(\'%s\',\'now\') * 1000) ON CONFLICT(board_id, from_node, to_node) DO NOTHING',
      );
      for (const edge of edges) {
        const fromChild = childSet.has(edge.from_node);
        const toChild = childSet.has(edge.to_node);
        if (fromChild === toChild) continue; // 内部边或无关边
        deleteEdge.run(boardId, edge.from_node, edge.to_node);
        insertEdge.run(boardId, fromChild ? compositeId : edge.from_node, toChild ? compositeId : edge.to_node, edge.kind);
      }
    });
    return { id: compositeId };
  }

  /** 批次9：解散复合节点——成员释放回画布，复合节点及其连线删除（外部连线不回接） */
  dissolveComposite(boardId: string, compositeId: string): void {
    this.assertBoard(boardId);
    const node = this.db
      .prepare('SELECT source FROM wall_nodes WHERE board_id = ? AND id = ?')
      .get(boardId, compositeId) as { source: string } | undefined;
    if (!node) throw new DataError('WALL_NODE_NOT_FOUND', '节点不存在', { compositeId });
    if (node.source !== 'composite') {
      throw new DataError('WALL_ITEM_INVALID', '仅复合节点可解散', { compositeId });
    }
    this.layer.transaction(() => {
      this.db
        .prepare('DELETE FROM wall_node_edges WHERE board_id = ? AND (from_node = ? OR to_node = ?)')
        .run(boardId, compositeId, compositeId);
      this.db
        .prepare('UPDATE wall_nodes SET parent_id = NULL, updated_at = strftime(\'%s\',\'now\') * 1000 WHERE parent_id = ?')
        .run(compositeId);
      this.db.prepare('DELETE FROM wall_nodes WHERE id = ?').run(compositeId);
    });
  }

  listCompositeMembers(boardId: string, compositeId: string): string[] {
    this.assertBoard(boardId);
    const rows = this.db
      .prepare('SELECT id FROM wall_nodes WHERE parent_id = ? ORDER BY created_at ASC')
      .all(compositeId) as Array<{ id: string }>;
    return rows.map((row) => row.id);
  }

  /** 批次9：设置节点所属复合节点（导入 board.json 还原层级用） */
  setParentNode(boardId: string, nodeId: string, parentId: string | null): void {
    this.assertBoard(boardId);
    if (parentId) {
      const parent = this.db
        .prepare("SELECT id FROM wall_nodes WHERE board_id = ? AND id = ? AND source = 'composite'")
        .get(boardId, parentId);
      if (!parent) {
        throw new DataError('WALL_NODE_NOT_FOUND', '目标复合节点不存在', { parentId });
      }
    }
    this.layer.transaction(() => {
      this.db
        .prepare('UPDATE wall_nodes SET parent_id = ?, updated_at = strftime(\'%s\',\'now\') * 1000 WHERE id = ?')
        .run(parentId, nodeId);
    });
  }

  listNodeEdges(boardId: string): Array<{ fromShotId: string; toShotId: string; kind: string }> {
    this.assertBoard(boardId);
    const rows = this.db
      .prepare('SELECT from_node, to_node, kind FROM wall_node_edges WHERE board_id = ? ORDER BY created_at ASC')
      .all(boardId) as Array<{ from_node: string; to_node: string; kind: string }>;
    return rows.map((r) => ({ fromShotId: r.from_node, toShotId: r.to_node, kind: r.kind }));
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

  /** 批次3：节点标签（六类，与镜头标签体系同构但不混表） */
  listTags(boardId: string): Record<string, Array<{ category: string; name: string }>> {
    this.assertBoard(boardId);
    const rows = this.db
      .prepare('SELECT node_id, category, name FROM wall_node_tags WHERE board_id = ? ORDER BY rowid ASC')
      .all(boardId) as Array<{ node_id: string; category: string; name: string }>;
    const out: Record<string, Array<{ category: string; name: string }>> = {};
    for (const row of rows) {
      const list = out[row.node_id] ?? [];
      list.push({ category: row.category, name: row.name });
      out[row.node_id] = list;
    }
    return out;
  }

  addTag(boardId: string, nodeId: string, category: string, name: string): void {
    this.assertTagTarget(boardId, nodeId, category, name);
    this.layer.transaction(() => {
      this.db
        .prepare(
          'INSERT INTO wall_node_tags (board_id, node_id, category, name) VALUES (?, ?, ?, ?) ON CONFLICT(board_id, node_id, category, name) DO NOTHING',
        )
        .run(boardId, nodeId, category, name);
    });
  }

  removeTag(boardId: string, nodeId: string, category: string, name: string): void {
    this.assertTagTarget(boardId, nodeId, category, name);
    this.layer.transaction(() => {
      this.db
        .prepare('DELETE FROM wall_node_tags WHERE board_id = ? AND node_id = ? AND category = ? AND name = ?')
        .run(boardId, nodeId, category, name);
    });
  }

  private assertTagTarget(boardId: string, nodeId: string, category: string, name: string): void {
    this.assertBoard(boardId);
    if (category.length < 1 || category.length > 40 || name.length < 1 || name.length > 40) {
      throw new DataError('WALL_ITEM_INVALID', '标签类别/名称长度无效', { category, name });
    }
    const node = this.db.prepare('SELECT id FROM wall_nodes WHERE id = ? AND board_id = ?').get(nodeId, boardId);
    if (!node) {
      throw new DataError('WALL_NODE_NOT_FOUND', '节点不存在或不属于该分镜本', { nodeId, boardId });
    }
  }
}

function mapNode(row: Record<string, unknown>): WallBoardNode {
  const source = row.source === 'text' ? 'text' : row.source === 'composite' ? 'composite' : 'image';
  return {
    id: String(row.id),
    source,
    assetPath: (row.asset_path as string | null) ?? null,
    parentId: (row.parent_id as string | null) ?? null,
    title: String(row.title ?? ''),
    textContent: String(row.text_content ?? ''),
    durationMs: Number(row.duration_ms ?? 3000),
    note: String(row.note ?? ''),
    shotSize: (row.shot_size as string | null) ?? null,
    cameraMethod: (row.camera_method as string | null) ?? null,
    x: Number(row.x ?? 0),
    y: Number(row.y ?? 0),
  };
}
