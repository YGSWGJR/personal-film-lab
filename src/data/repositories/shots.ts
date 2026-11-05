import { randomUUID } from 'node:crypto';
import type {
  LabelApplyPolicy,
  LabelApplyResult,
  ManualShotField,
  Shot,
  ShotCreateArgs,
  ShotMergeArgs,
  ShotMergeResult,
  ShotPreview,
  ShotSplitArgs,
  ShotSplitResult,
  ShotTrimArgs,
  ShotTrimResult,
  ShotUpdateArgs,
} from '../../shared/types';
import { frameFromMs, frameToMs, safeFps } from '../../shared/time';
import type { DataLayer } from '../db';
import { DataError, isSqliteConstraintError } from '../errors';
import { removeProjectFiles } from '../paths';
import { nowIso } from './projects';

interface ShotRow {
  id: string;
  project_id: string;
  shot_index: number;
  start_ms: number;
  end_ms: number;
  duration_ms: number;
  shot_size: string | null;
  camera_method: string | null;
  dialogue: string | null;
  remark: string | null;
  origin: 'auto' | 'manual';
  locked: number;
  thumbnail: string | null;
  manual_fields_json: string | null;
  created_at: string;
  updated_at: string;
}

/** S41：受管标签分类（AI 标签应用只替换这六类） */
export const MANAGED_TAG_CATEGORIES = ['景别', '机位', '运镜', '光线', '声音', '剪辑'] as const;

const MANUAL_FIELD_KEYS: ManualShotField[] = ['shotSize', 'cameraMethod', 'dialogue', 'remark', 'tags'];

export class ShotRepository {
  constructor(private readonly layer: DataLayer) {}

  private get db() {
    return this.layer.db;
  }

  list(projectId: string): Shot[] {
    this.assertProject(projectId);
    const rows = this.db
      .prepare('SELECT * FROM shots WHERE project_id = ? ORDER BY start_ms ASC, shot_index ASC')
      .all(projectId) as ShotRow[];
    const tagIds = this.loadTagIds(rows.map((row) => row.id));
    return rows.map((row) => mapShot(row, tagIds.get(row.id) ?? []));
  }

  get(id: string): Shot {
    const row = this.db.prepare('SELECT * FROM shots WHERE id = ?').get(id) as ShotRow | undefined;
    if (!row) throw new DataError('SHOT_NOT_FOUND', `镜头不存在：${id}`, { id });
    const tagIds = this.loadTagIds([id]).get(id) ?? [];
    return mapShot(row, tagIds);
  }

  create(args: ShotCreateArgs): Shot {
    this.assertProject(args.projectId);
    this.validateRange(args.startMs, args.endMs);
    const id = randomUUID();
    const now = nowIso();
    const durationMs = args.endMs - args.startMs;

    try {
      this.layer.transaction(() => {
        const index =
          args.index ??
          ((this.db
            .prepare('SELECT COALESCE(MAX(shot_index), 0) + 1 AS next FROM shots WHERE project_id = ?')
            .get(args.projectId) as { next: number }).next);
        this.db
          .prepare(
            `INSERT INTO shots (
              id, project_id, shot_index, start_ms, end_ms, duration_ms,
              shot_size, camera_method, dialogue, remark, origin, locked, created_at, updated_at
            ) VALUES (
              @id, @projectId, @index, @startMs, @endMs, @durationMs,
              @shotSize, @cameraMethod, @dialogue, @remark, 'manual', 0, @createdAt, @updatedAt
            )`,
          )
          .run({
            id,
            projectId: args.projectId,
            index,
            startMs: args.startMs,
            endMs: args.endMs,
            durationMs,
            shotSize: args.shotSize ?? null,
            cameraMethod: args.cameraMethod ?? null,
            dialogue: args.dialogue ?? null,
            remark: args.remark ?? null,
            createdAt: now,
            updatedAt: now,
          });
        this.layer.projects.touch(args.projectId);
      });
    } catch (error) {
      if (isSqliteConstraintError(error)) {
        throw new DataError('SHOT_CREATE_FAILED', `镜头创建失败：${(error as Error).message}`);
      }
      throw error;
    }

    return this.get(id);
  }

  update(args: ShotUpdateArgs): Shot {
    const current = this.get(args.id);
    const patch = args.patch ?? {};
    const startMs = patch.startMs ?? current.startMs;
    const endMs = patch.endMs ?? current.endMs;
    this.validateRange(startMs, endMs);

    this.layer.transaction(() => {
      this.db
        .prepare(
          `UPDATE shots SET
            shot_index = @index, start_ms = @startMs, end_ms = @endMs, duration_ms = @durationMs,
            shot_size = @shotSize, camera_method = @cameraMethod, dialogue = @dialogue, remark = @remark,
            origin = 'manual', updated_at = @updatedAt
          WHERE id = @id`,
        )
        .run({
          id: current.id,
          index: patch.index ?? current.index,
          startMs,
          endMs,
          durationMs: endMs - startMs,
          shotSize: patch.shotSize !== undefined ? patch.shotSize : current.shotSize,
          cameraMethod: patch.cameraMethod !== undefined ? patch.cameraMethod : current.cameraMethod,
          dialogue: patch.dialogue !== undefined ? patch.dialogue : current.dialogue,
          remark: patch.remark !== undefined ? patch.remark : current.remark,
          updatedAt: nowIso(),
        });
      // S41：记录被用户手动编辑的语义字段
      const touchedFields = MANUAL_FIELD_KEYS.filter(
        (field) => field !== 'tags' && patch[field] !== undefined,
      );
      if (touchedFields.length > 0) {
        this.markManualFieldsInTxn(current.id, touchedFields);
      }
      this.layer.projects.touch(current.projectId);
    });

    return this.get(current.id);
  }

  split(args: ShotSplitArgs): ShotSplitResult {
    this.assertProject(args.projectId);
    const source = this.getEditableRow(args.projectId, args.shotId);
    const cutMs = this.alignCutMs(args.projectId, args.cutMs, source.start_ms, source.end_ms);
    const now = nowIso();
    const rightId = randomUUID();

    this.layer.transaction(() => {
      this.db
        .prepare(
          `UPDATE shots SET
            end_ms = ?, duration_ms = ?, origin = 'manual', updated_at = ?
          WHERE id = ?`,
        )
        .run(cutMs, cutMs - source.start_ms, now, source.id);

      this.db
        .prepare(
          `INSERT INTO shots (
            id, project_id, shot_index, start_ms, end_ms, duration_ms,
            shot_size, camera_method, dialogue, remark, origin, locked, thumbnail, manual_fields_json, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'manual', 0, NULL, ?, ?, ?)`,
        )
        .run(
          rightId,
          source.project_id,
          source.shot_index + 1,
          cutMs,
          source.end_ms,
          source.end_ms - cutMs,
          source.shot_size,
          source.camera_method,
          source.dialogue,
          source.remark,
          source.manual_fields_json ?? '[]',
          now,
          now,
        );

      this.db
        .prepare(
          `INSERT OR IGNORE INTO shot_tags (shot_id, tag_id)
           SELECT ?, tag_id FROM shot_tags WHERE shot_id = ?`,
        )
        .run(rightId, source.id);
      this.db
        .prepare('UPDATE stills SET shot_id = ?, updated_at = ? WHERE shot_id = ? AND time_ms >= ?')
        .run(rightId, now, source.id, cutMs);
      this.renumber(source.project_id);
      this.layer.projects.touch(source.project_id);
    });

    return {
      left: this.get(source.id),
      right: this.get(rightId),
    };
  }

  merge(args: ShotMergeArgs): ShotMergeResult {
    this.assertProject(args.projectId);
    const first = this.getEditableRow(args.projectId, args.shotIdA);
    const second = this.getEditableRow(args.projectId, args.shotIdB);
    if (first.id === second.id) {
      throw new DataError('NOT_ADJACENT', '不能合并同一个镜头', { shotId: first.id });
    }
    const [left, right] =
      first.start_ms <= second.start_ms ? [first, second] : [second, first];
    if (left.end_ms !== right.start_ms) {
      throw new DataError(
        left.end_ms < right.start_ms ? 'MERGE_GAP' : 'NOT_ADJACENT',
        left.end_ms < right.start_ms ? '镜头之间存在间隙，无法合并' : '镜头存在重叠，无法合并',
        { leftShotId: left.id, rightShotId: right.id },
      );
    }
    const now = nowIso();
    this.layer.transaction(() => {
      this.db
        .prepare(
          `UPDATE shots SET
            end_ms = ?, duration_ms = ?, shot_size = ?, camera_method = ?, dialogue = ?,
            remark = ?, thumbnail = ?, manual_fields_json = ?, origin = 'manual', updated_at = ?
          WHERE id = ?`,
        )
        .run(
          right.end_ms,
          right.end_ms - left.start_ms,
          this.pickText(left.shot_size, right.shot_size),
          this.pickText(left.camera_method, right.camera_method),
          this.pickText(left.dialogue, right.dialogue),
          this.pickText(left.remark, right.remark),
          left.thumbnail ?? right.thumbnail,
          unionManualFields(left.manual_fields_json, right.manual_fields_json),
          now,
          left.id,
        );
      this.db
        .prepare(
          `INSERT OR IGNORE INTO shot_tags (shot_id, tag_id)
           SELECT ?, tag_id FROM shot_tags WHERE shot_id = ?`,
        )
        .run(left.id, right.id);
      this.db
        .prepare('UPDATE notes SET shot_id = ?, updated_at = ? WHERE shot_id = ?')
        .run(left.id, now, right.id);
      this.db
        .prepare('UPDATE stills SET shot_id = ?, updated_at = ? WHERE shot_id = ?')
        .run(left.id, now, right.id);
      this.db.prepare('DELETE FROM shot_tags WHERE shot_id = ?').run(right.id);
      this.db.prepare('DELETE FROM shots WHERE id = ?').run(right.id);
      this.renumber(left.project_id);
      this.layer.projects.touch(left.project_id);
    });
    return { shot: this.get(left.id) };
  }

  trim(args: ShotTrimArgs): ShotTrimResult {
    this.assertProject(args.projectId);
    const first = this.getEditableRow(args.projectId, args.leftShotId);
    const second = this.getEditableRow(args.projectId, args.rightShotId);
    const [left, right] =
      first.start_ms <= second.start_ms ? [first, second] : [second, first];
    if (left.end_ms !== right.start_ms) {
      throw new DataError(
        left.end_ms < right.start_ms ? 'MERGE_GAP' : 'NOT_ADJACENT',
        left.end_ms < right.start_ms ? '镜头之间存在间隙，无法调整边界' : '镜头存在重叠，无法调整边界',
        { leftShotId: left.id, rightShotId: right.id },
      );
    }
    const cutMs = this.alignCutMs(
      args.projectId,
      args.cutMs,
      left.start_ms,
      right.end_ms,
    );
    const now = nowIso();
    this.layer.transaction(() => {
      this.db
        .prepare(
          `UPDATE shots SET end_ms = ?, duration_ms = ?, origin = 'manual', updated_at = ?
           WHERE id = ?`,
        )
        .run(cutMs, cutMs - left.start_ms, now, left.id);
      this.db
        .prepare(
          `UPDATE shots SET start_ms = ?, duration_ms = ?, origin = 'manual', updated_at = ?
           WHERE id = ?`,
        )
        .run(cutMs, right.end_ms - cutMs, now, right.id);
      this.db
        .prepare(
          `UPDATE stills SET shot_id = ?, updated_at = ?
           WHERE shot_id IN (?, ?) AND time_ms >= ?`,
        )
        .run(right.id, now, left.id, right.id, cutMs);
      this.db
        .prepare(
          `UPDATE stills SET shot_id = ?, updated_at = ?
           WHERE shot_id IN (?, ?) AND time_ms < ?`,
        )
        .run(left.id, now, left.id, right.id, cutMs);
      this.layer.projects.touch(args.projectId);
    });
    return { left: this.get(left.id), right: this.get(right.id) };
  }

  /** S36-2：写入镜头封面缩略图路径（可由 AI/OpenCV 预览或按需抽帧生成）。 */
  setThumbnail(id: string, thumbnail: string | null): Shot {
    this.get(id);
    this.db
      .prepare('UPDATE shots SET thumbnail = ?, updated_at = ? WHERE id = ?')
      .run(thumbnail, nowIso(), id);
    return this.get(id);
  }

  delete(id: string, extraSafeRoots: string[] = []): void {
    const current = this.get(id);
    const stillFiles = this.db
      .prepare('SELECT file_path, thumb_path FROM stills WHERE shot_id = ?')
      .all(id) as Array<{ file_path: string; thumb_path: string | null }>;
    this.layer.transaction(() => {
      this.db.prepare('DELETE FROM shot_tags WHERE shot_id = ?').run(id);
      this.db.prepare('DELETE FROM notes WHERE shot_id = ?').run(id);
      this.db.prepare('DELETE FROM stills WHERE shot_id = ?').run(id);
      this.db.prepare('DELETE FROM shots WHERE id = ?').run(id);
      this.layer.projects.touch(current.projectId);
    });
    removeProjectFiles(
      this.layer.dataRoot,
      current.projectId,
      stillFiles.flatMap((still) => [still.file_path, still.thumb_path]),
      extraSafeRoots,
    );
  }

  /**
   * 应用检测预览：保留 locked 与 origin='manual' 的人工镜头，
   * 替换其余自动镜头，并跳过与受保护区间重叠的候选（S36-2 人工修正优先）。
   */
  applyDetected(projectId: string, previews: ShotPreview[]): { applied: number; skippedProtected: number } {
    this.assertProject(projectId);
    const now = nowIso();
    let applied = 0;
    let skippedProtected = 0;
    this.layer.transaction(() => {
      const protectedRows = this.db
        .prepare(
          "SELECT start_ms, end_ms, shot_index FROM shots WHERE project_id = ? AND (locked = 1 OR origin = 'manual')",
        )
        .all(projectId) as Array<{ start_ms: number; end_ms: number; shot_index: number }>;
      this.db
        .prepare("DELETE FROM shots WHERE project_id = ? AND locked = 0 AND origin = 'auto'")
        .run(projectId);
      let nextIndex = Math.max(0, ...protectedRows.map((row) => row.shot_index)) + 1;
      const insert = this.db.prepare(
        `INSERT INTO shots (
          id, project_id, shot_index, start_ms, end_ms, duration_ms,
          shot_size, camera_method, dialogue, remark, origin, locked, thumbnail, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'auto', 0, ?, ?, ?)`,
      );
      for (const preview of previews) {
        const overlapsProtected = protectedRows.some(
          (row) => preview.startMs < row.end_ms && preview.endMs > row.start_ms,
        );
        if (overlapsProtected) {
          skippedProtected += 1;
          continue;
        }
        const shotId = randomUUID();
        insert.run(
          shotId,
          projectId,
          nextIndex++,
          preview.startMs,
          preview.endMs,
          preview.endMs - preview.startMs,
          preview.shotSize ?? null,
          preview.cameraMethod ?? null,
          preview.dialogue ?? null,
          preview.remark ?? null,
          preview.thumbnail ?? preview.thumbPath ?? null,
          now,
          now,
        );
        this.assignDetectedTags(shotId, preview.tags);
        applied += 1;
      }
      this.layer.projects.touch(projectId);
    });
    return { applied, skippedProtected };
  }

  /** S41：字段级人工保护标记（事务内复用）。 */
  markManualFields(shotId: string, fields: ManualShotField[]): void {
    this.markManualFieldsInTxn(shotId, fields);
  }

  /**
   * S41：按策略应用 Qwen 标签预览。单事务；逐镜头校验几何版本与锁定状态，
   * 单个镜头失效仅跳过（写入 skipped），数据库错误整体回滚。
   */
  applyLabelUpdates(
    projectId: string,
    updates: Array<{
      shotId: string;
      startMs: number;
      endMs: number;
      shotSize: string | null;
      cameraMethod: string | null;
      remark: string | null;
      tags: Record<string, string[]>;
    }>,
    policy: LabelApplyPolicy,
  ): LabelApplyResult {
    this.assertProject(projectId);
    let appliedShots = 0;
    let updatedFields = 0;
    let updatedTagLinks = 0;
    const preserved: Array<{ shotId: string; fields: ManualShotField[] }> = [];
    const skipped: Array<{ shotId: string; code: string; message: string }> = [];
    this.layer.transaction(() => {
      const getRow = this.db.prepare('SELECT * FROM shots WHERE id = ?');
      const updateFields = this.db.prepare(
        `UPDATE shots SET shot_size = ?, camera_method = ?, remark = ?, manual_fields_json = ?, updated_at = ?
         WHERE id = ?`,
      );
      for (const update of updates) {
        const row = getRow.get(update.shotId) as ShotRow | undefined;
        if (!row || row.project_id !== projectId) {
          skipped.push({ shotId: update.shotId, code: 'SHOT_NOT_FOUND', message: '镜头不存在或不属于该项目' });
          continue;
        }
        if (row.locked !== 0) {
          skipped.push({ shotId: update.shotId, code: 'SHOT_LOCKED', message: '镜头已锁定' });
          continue;
        }
        if (row.start_ms !== update.startMs || row.end_ms !== update.endMs) {
          skipped.push({
            shotId: update.shotId,
            code: 'LABEL_RESULT_STALE',
            message: '镜头范围已变化（切分/合并/修剪），识别结果已过期',
          });
          continue;
        }
        const manualFields = parseManualFields(row.manual_fields_json);
        const applyField = (field: ManualShotField): boolean =>
          policy === 'overwrite-all' || !manualFields.includes(field);
        const tagsLocked = !applyField('tags');
        const preservedFields = MANUAL_FIELD_KEYS.filter(
          (field) => field !== 'dialogue' && !applyField(field),
        );
        if (preservedFields.length > 0) {
          preserved.push({ shotId: update.shotId, fields: preservedFields });
        }
        const now = nowIso();
        let nextManualFields = manualFields;
        const fieldUpdates: Array<string | null> = [];
        let fieldCount = 0;
        if (applyField('shotSize')) {
          fieldUpdates.push(update.shotSize);
          fieldCount += 1;
          nextManualFields = nextManualFields.filter((field) => field !== 'shotSize');
        } else {
          fieldUpdates.push(row.shot_size);
        }
        if (applyField('cameraMethod')) {
          fieldUpdates.push(update.cameraMethod);
          fieldCount += 1;
          nextManualFields = nextManualFields.filter((field) => field !== 'cameraMethod');
        } else {
          fieldUpdates.push(row.camera_method);
        }
        if (applyField('remark')) {
          fieldUpdates.push(update.remark);
          fieldCount += 1;
          nextManualFields = nextManualFields.filter((field) => field !== 'remark');
        } else {
          fieldUpdates.push(row.remark);
        }
        updateFields.run(
          fieldUpdates[0],
          fieldUpdates[1],
          fieldUpdates[2],
          JSON.stringify(nextManualFields),
          now,
          update.shotId,
        );
        updatedFields += fieldCount;
        if (!tagsLocked) {
          const links = this.replaceManagedTags(update.shotId, update.tags);
          updatedTagLinks += links;
          if (policy === 'overwrite-all') {
            nextManualFields = nextManualFields.filter((field) => field !== 'tags');
            this.db
              .prepare('UPDATE shots SET manual_fields_json = ? WHERE id = ?')
              .run(JSON.stringify(nextManualFields), update.shotId);
          }
        }
        appliedShots += 1;
      }
      this.layer.projects.touch(projectId);
    });
    return { appliedShots, updatedFields, updatedTagLinks, preserved, skipped };
  }

  /** S41：只替换受管六类标签；自定义分类不动。AI 写入不标记 manualFields。 */
  private replaceManagedTags(
    shotId: string,
    tags: Record<string, string[]> | undefined,
  ): number {
    let links = 0;
    // 受管分类整组替换：先清空现有受管标签，再写入 AI 结果（自定义分类不受影响）
    const placeholders = MANAGED_TAG_CATEGORIES.map(() => '?').join(',');
    this.db
      .prepare(
        `DELETE FROM shot_tags WHERE shot_id = ? AND tag_id IN (
          SELECT id FROM tags WHERE category IN (${placeholders})
        )`,
      )
      .run(shotId, ...MANAGED_TAG_CATEGORIES);
    if (!tags) return links;
    const findTag = this.db.prepare('SELECT id FROM tags WHERE category = ? AND name = ? LIMIT 1');
    const insertTag = this.db.prepare(
      'INSERT INTO tags (id, category, name, color, builtin, sort_order, created_at) VALUES (?, ?, ?, NULL, 0, 0, ?)',
    );
    const assignTag = this.db.prepare('INSERT OR IGNORE INTO shot_tags (shot_id, tag_id) VALUES (?, ?)');
    for (const [rawCategory, names] of Object.entries(tags)) {
      const category = rawCategory.trim();
      if (!category || !Array.isArray(names)) continue;
      if (!(MANAGED_TAG_CATEGORIES as readonly string[]).includes(category)) continue;
      for (const rawName of names) {
        const name = String(rawName).trim();
        if (!name) continue;
        const existing = findTag.get(category, name) as { id: string } | undefined;
        const tagId = existing?.id ?? randomUUID();
        if (!existing) insertTag.run(tagId, category, name, nowIso());
        const result = assignTag.run(shotId, tagId);
        if (result.changes > 0) links += 1;
      }
    }
    return links;
  }

  private assignDetectedTags(shotId: string, tags: Record<string, string[]> | undefined): void {
    if (!tags) return;
    const findTag = this.db.prepare(
      'SELECT id FROM tags WHERE category = ? AND name = ? LIMIT 1',
    );
    const insertTag = this.db.prepare(
      'INSERT INTO tags (id, category, name, color, builtin, sort_order, created_at) VALUES (?, ?, ?, NULL, 0, 0, ?)',
    );
    const assignTag = this.db.prepare(
      'INSERT OR IGNORE INTO shot_tags (shot_id, tag_id) VALUES (?, ?)',
    );
    for (const [rawCategory, names] of Object.entries(tags)) {
      const category = rawCategory.trim();
      if (!category || !Array.isArray(names)) continue;
      for (const rawName of names) {
        const name = String(rawName).trim();
        if (!name) continue;
        const existing = findTag.get(category, name) as { id: string } | undefined;
        const tagId = existing?.id ?? randomUUID();
        if (!existing) insertTag.run(tagId, category, name, nowIso());
        assignTag.run(shotId, tagId);
      }
    }
  }

  private getEditableRow(projectId: string, id: string): ShotRow {
    const row = this.db.prepare('SELECT * FROM shots WHERE id = ?').get(id) as ShotRow | undefined;
    if (!row) throw new DataError('SHOT_NOT_FOUND', `镜头不存在：${id}`, { id });
    if (row.project_id !== projectId) {
      throw new DataError('SHOT_NOT_FOUND', '镜头不属于该项目', { id, projectId });
    }
    if (row.locked !== 0) {
      throw new DataError('SHOT_LOCKED', '镜头已锁定，无法手动编辑', { id });
    }
    return row;
  }

  private alignCutMs(projectId: string, rawCutMs: number, startMs: number, endMs: number): number {
    if (!Number.isFinite(rawCutMs) || rawCutMs <= startMs || rawCutMs >= endMs) {
      throw new DataError('CUT_OUT_OF_RANGE', '切点必须位于镜头内部', {
        projectId,
        rawCutMs,
        startMs,
        endMs,
      });
    }
    const project = this.layer.projects.get(projectId);
    const fps = safeFps(project.media.fps ?? 24);
    const cutMs = frameToMs(frameFromMs(rawCutMs, fps), fps);
    if (cutMs <= startMs || cutMs >= endMs) {
      throw new DataError('CUT_TOO_CLOSE_TO_EDGE', '切点距镜头边缘不足 1 帧', {
        rawCutMs,
        cutMs,
        startMs,
        endMs,
        fps,
      });
    }
    return cutMs;
  }

  private pickText(left: string | null, right: string | null): string | null {
    return left && left.trim() ? left : right;
  }

  private renumber(projectId: string): void {
    const rows = this.db
      .prepare('SELECT id FROM shots WHERE project_id = ? ORDER BY start_ms ASC, id ASC')
      .all(projectId) as Array<{ id: string }>;
    const update = this.db.prepare('UPDATE shots SET shot_index = ? WHERE id = ?');
    rows.forEach((row, index) => update.run(index + 1, row.id));
  }

  private validateRange(startMs: number, endMs: number): void {
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || startMs < 0 || endMs < startMs) {
      throw new DataError('INVALID_ARGUMENT', `镜头时间区间无效：startMs=${startMs} endMs=${endMs}`);
    }
  }

  private assertProject(projectId: string): void {
    if (!this.layer.projects.exists(projectId)) {
      throw new DataError('PROJECT_NOT_FOUND', `项目不存在：${projectId}`, { projectId });
    }
  }

  /** S41：事务内标记人工字段（幂等合并，不覆盖已有标记）。 */
  private markManualFieldsInTxn(shotId: string, fields: ManualShotField[]): void {
    const row = this.db
      .prepare('SELECT manual_fields_json FROM shots WHERE id = ?')
      .get(shotId) as { manual_fields_json: string | null } | undefined;
    if (!row) return;
    const current = parseManualFields(row.manual_fields_json);
    const merged = [...new Set([...current, ...fields])];
    this.db
      .prepare('UPDATE shots SET manual_fields_json = ? WHERE id = ?')
      .run(JSON.stringify(merged), shotId);
  }

  private loadTagIds(shotIds: string[]): Map<string, string[]> {
    const result = new Map<string, string[]>();
    if (shotIds.length === 0) return result;
    const placeholders = shotIds.map(() => '?').join(',');
    const rows = this.db
      .prepare(`SELECT shot_id, tag_id FROM shot_tags WHERE shot_id IN (${placeholders}) ORDER BY tag_id ASC`)
      .all(...shotIds) as Array<{ shot_id: string; tag_id: string }>;
    for (const row of rows) {
      const list = result.get(row.shot_id) ?? [];
      list.push(row.tag_id);
      result.set(row.shot_id, list);
    }
    return result;
  }
}

function mapShot(row: ShotRow, tagIds: string[]): Shot {
  return {
    id: row.id,
    projectId: row.project_id,
    index: row.shot_index,
    startMs: row.start_ms,
    endMs: row.end_ms,
    durationMs: row.duration_ms,
    shotSize: row.shot_size,
    cameraMethod: row.camera_method,
    dialogue: row.dialogue,
    remark: row.remark,
    origin: row.origin === 'auto' ? 'auto' : 'manual',
    locked: row.locked !== 0,
    thumbnail: row.thumbnail ?? null,
    tagIds,
    manualFields: parseManualFields(row.manual_fields_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** S41：解析 manual_fields_json；损坏或未知值降级为空数组。 */
function parseManualFields(raw: string | null): ManualShotField[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (value): value is ManualShotField =>
        typeof value === 'string' && (MANUAL_FIELD_KEYS as string[]).includes(value),
    );
  } catch (error) {
    console.warn(`[shots] manual_fields_json 解析失败，已降级为空：${(error as Error).message}`);
    return [];
  }
}

/** S41：merge 时合并两端人工字段（并集）。 */
function unionManualFields(left: string | null, right: string | null): string {
  return JSON.stringify([...new Set([...parseManualFields(left), ...parseManualFields(right)])]);
}

