import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { extname, join } from 'node:path';
import { dialog, type BrowserWindow } from 'electron';
import type { DataLayer } from '../../data/db';
import { DataError } from '../../data/errors';
import type { TermExportResult, TermImportResult, TermJsonEntry } from '../../shared/types';
import { resolveTermExportDir } from '../paths';

const JSON_FILTERS = [{ name: '术语库 JSON', extensions: ['json'] }];

export class TermTransferService {
  constructor(
    private readonly data: DataLayer,
    private readonly getWindow: () => BrowserWindow | null,
  ) {}

  async importJson(): Promise<TermImportResult> {
    const win = this.requireWindow();
    const defaultDir = resolveTermExportDir();
    mkdirSync(defaultDir, { recursive: true });
    const selection = await dialog.showOpenDialog(win, {
      title: '导入术语库',
      defaultPath: defaultDir,
      properties: ['openFile'],
      filters: JSON_FILTERS,
    });
    if (selection.canceled || selection.filePaths.length === 0) {
      return { canceled: true, path: null, total: 0, imported: 0, skipped: 0 };
    }

    const filePath = selection.filePaths[0];
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(filePath, 'utf8'));
    } catch (error) {
      throw new DataError('TERM_IMPORT_INVALID', `术语 JSON 无法读取：${(error as Error).message}`, {
        path: filePath,
      });
    }
    const entries = this.normalizeEntries(parsed, filePath);
    let imported = 0;
    let skipped = 0;
    for (let index = 0; index < entries.length; index += 1) {
      const entry = entries[index];
      try {
        this.data.terms.create({
          category: entry.category ?? 'custom',
          term: entry.term,
          definition: entry.definition,
          sortOrder: index + 1,
        });
        imported += 1;
      } catch (error) {
        if ((error as { code?: string }).code === 'TERM_EXISTS') {
          skipped += 1;
          continue;
        }
        throw error;
      }
    }
    return {
      canceled: false,
      path: filePath,
      total: entries.length,
      imported,
      skipped,
    };
  }

  async exportJson(): Promise<TermExportResult> {
    const win = this.requireWindow();
    const terms = this.data.terms.list();
    const stamp = new Date().toISOString().slice(0, 10).replaceAll('-', '');
    const defaultDir = resolveTermExportDir();
    mkdirSync(defaultDir, { recursive: true });
    const result = await dialog.showSaveDialog(win, {
      title: '导出术语库',
      defaultPath: join(defaultDir, `lapian-terms-${stamp}.json`),
      filters: JSON_FILTERS,
    });
    if (result.canceled || !result.filePath) {
      return { canceled: true, path: null, count: terms.length };
    }

    const payload: TermJsonEntry[] = terms.map((term) => ({
      category: term.category,
      term: term.term,
      definition: term.definition,
    }));
    const outputPath = extname(result.filePath) ? result.filePath : `${result.filePath}.json`;
    try {
      writeFileSync(outputPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
    } catch (error) {
      throw new DataError('TERM_EXPORT_FAILED', `术语 JSON 无法写入：${(error as Error).message}`, {
        path: outputPath,
      });
    }
    return { canceled: false, path: outputPath, count: payload.length };
  }

  private normalizeEntries(value: unknown, filePath: string): TermJsonEntry[] {
    const raw = Array.isArray(value)
      ? value
      : value && typeof value === 'object' && Array.isArray((value as { terms?: unknown }).terms)
        ? (value as { terms: unknown[] }).terms
        : null;
    if (!raw) {
      throw new DataError('TERM_IMPORT_INVALID', 'JSON 顶层必须是术语数组，或包含 terms 数组', {
        path: filePath,
      });
    }

    const entries: TermJsonEntry[] = [];
    for (let index = 0; index < raw.length; index += 1) {
      const item = raw[index];
      if (!item || typeof item !== 'object') {
        throw new DataError('TERM_IMPORT_INVALID', `第 ${index + 1} 项不是有效对象`, {
          path: filePath,
          index,
        });
      }
      const record = item as Record<string, unknown>;
      const term = typeof record.term === 'string' ? record.term.trim() : typeof record.name === 'string' ? record.name.trim() : '';
      const definition = typeof record.definition === 'string' ? record.definition.trim() : '';
      if (!term || !definition) {
        throw new DataError('TERM_IMPORT_INVALID', `第 ${index + 1} 项缺少术语名或释义`, {
          path: filePath,
          index,
        });
      }
      const category = typeof record.category === 'string' && record.category.trim()
        ? record.category.trim()
        : 'custom';
      entries.push({ term, definition, category });
    }
    return entries;
  }

  private requireWindow(): BrowserWindow {
    const win = this.getWindow();
    if (!win) throw new DataError('WINDOW_UNAVAILABLE', '主窗口尚未就绪');
    return win;
  }
}
