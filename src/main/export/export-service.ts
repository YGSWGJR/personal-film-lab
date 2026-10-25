import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, extname, join } from 'node:path';
import {
  AlignmentType,
  BorderStyle,
  Document,
  ImageRun,
  Packer,
  PageBreak,
  PageOrientation,
  Paragraph,
  ShadingType,
  Table,
  TableCell,
  TableLayoutType,
  TableRow,
  TextRun,
  VerticalAlign,
  WidthType,
} from 'docx';
import { BrowserWindow } from 'electron';
import type { DataLayer } from '../../data/db';
import { resolveProjectFilePath, sanitizeName } from '../../data/paths';
import type {
  Annotation,
  ExportDoneEvent,
  ExportProgressEvent,
  Shot,
  Still,
  StoryboardExportArgs,
  StoryboardExportResult,
  StoryboardHeader,
  StoryboardImageStrategy,
} from '../../shared/types';
import { formatTimeMs } from '../../shared/time';
import type { CaptureService } from '../capture/capture-service';
import { resolveProjectExportDir } from '../paths';
import { ExportError } from './export-error';

const DEFAULT_HEADERS: StoryboardHeader[] = [
  { key: 'index', label: '镜号' },
  { key: 'duration', label: '时长' },
  { key: 'thumbnail', label: '缩略图' },
  { key: 'shotSize', label: '景别' },
  { key: 'cameraMethod', label: '摄法 / 运镜' },
  { key: 'image', label: '画面内容' },
  { key: 'dialogue', label: '台词' },
  { key: 'remark', label: '备注' },
];

const DOCX_COLUMN_WIDTHS = [560, 820, 1250, 720, 980, 2880, 1700, 1276];

interface StoryboardRow {
  shot: Shot;
  thumbnail: Still | null;
  mainStill: Still | null;
  thumbnailPath: string | null;
  imagePath: string | null;
}

export class ExportService {
  constructor(
    private readonly data: DataLayer,
    private readonly capture: CaptureService,
    private readonly emitProgress: (event: ExportProgressEvent) => void,
    private readonly emitDone: (event: ExportDoneEvent) => void,
  ) {}

  async exportStoryboard(args: StoryboardExportArgs): Promise<StoryboardExportResult> {
    const jobId = `export-${randomUUID()}`;
    const project = this.data.projects.get(args.projectId);
    this.emitProgress({ jobId, percent: 2, stage: 'prepare', message: '正在装配分镜数据' });

    const selectedIds = new Set(args.range?.shotIds ?? []);
    const shots = this.data.shots
      .list(project.id)
      .filter((shot) => selectedIds.size === 0 || selectedIds.has(shot.id));
    if (shots.length === 0) {
      throw new ExportError('EXPORT_NO_SHOTS', '没有可导出的镜头', { projectId: project.id });
    }

    const outputPath = this.outputPathOf(project.id, project.name, args.format);

    const rows = await this.buildRows(jobId, project.id, shots, args.imageStrategy ?? 'both');
    const headers = mergeHeaders(args.headers);
    this.emitProgress({ jobId, percent: 72, stage: 'render', message: '正在排版分镜本' });

    if (args.format === 'pdf') {
      await this.exportPdf(project.name, headers, rows, outputPath, args.imageStrategy ?? 'both');
    } else {
      await this.exportDocx(project.name, headers, rows, outputPath);
    }

    this.emitProgress({ jobId, percent: 100, stage: 'write', message: '导出完成' });
    this.emitDone({ jobId, filePath: outputPath, format: args.format, rowCount: rows.length });
    return {
      jobId,
      canceled: false,
      filePath: outputPath,
      format: args.format,
      rowCount: rows.length,
    };
  }

  private async buildRows(
    jobId: string,
    projectId: string,
    shots: Shot[],
    strategy: StoryboardImageStrategy,
  ): Promise<StoryboardRow[]> {
    const rows: StoryboardRow[] = [];
    for (let index = 0; index < shots.length; index += 1) {
      const shot = shots[index];
      const stills = this.data.stills.list({ shotId: shot.id });
      let autoThumb = stills.find((still) => still.role === 'auto-thumb') ?? null;
      if (strategy !== 'full' && (!autoThumb || !autoThumb.thumbPath)) {
        autoThumb = await this.capture.captureAt({ shotId: shot.id });
      }

      const midpoint = (shot.startMs + shot.endMs) / 2;
      const mainCandidates = stills
        .filter((still) => still.role === 'main')
        .sort(
          (left, right) => {
            const distance =
              Math.abs(left.timeMs - midpoint) - Math.abs(right.timeMs - midpoint);
            if (distance !== 0) return distance;
            const annotationDelta = right.annotations.length - left.annotations.length;
            if (annotationDelta !== 0) return annotationDelta;
            return left.createdAt.localeCompare(right.createdAt);
          },
        );
      const mainStill = mainCandidates[0] ?? null;

      rows.push({
        shot,
        thumbnail: autoThumb,
        mainStill,
        thumbnailPath:
          strategy === 'full' || !autoThumb?.thumbPath
            ? null
            : resolveProjectFilePath(this.data.dataRoot, projectId, autoThumb.thumbPath),
        imagePath:
          strategy === 'thumbnail' || !mainStill
            ? null
            : resolveProjectFilePath(this.data.dataRoot, projectId, mainStill.filePath),
      });
      this.emitProgress({
        jobId,
        percent: Math.round(8 + ((index + 1) / shots.length) * 60),
        stage: 'thumbnails',
        message: `准备镜头图片 ${index + 1}/${shots.length}`,
      });
    }
    return rows;
  }

  private outputPathOf(projectId: string, projectName: string, format: 'pdf' | 'docx'): string {
    const stamp = new Date().toISOString().slice(0, 16).replace(/[T:]/g, '-');
    const exportsDir = resolveProjectExportDir(projectId);
    mkdirSync(exportsDir, { recursive: true });
    return join(exportsDir, `${sanitizeName(projectName)}-storyboard-${stamp}.${format}`);
  }

  private async exportPdf(
    projectName: string,
    headers: StoryboardHeader[],
    rows: StoryboardRow[],
    outputPath: string,
    strategy: StoryboardImageStrategy,
  ): Promise<void> {
    const projectId = rows[0]?.shot.projectId;
    if (!projectId) throw new ExportError('EXPORT_NO_SHOTS', '没有可导出的镜头');
    const sectionDir = dirname(outputPath);
    const tempHtml = join(sectionDir, `storyboard-${randomUUID()}.html`);
    const html = this.renderHtml(projectName, headers, rows, strategy);
    writeFileSync(tempHtml, html, 'utf8');

    let printWindow: BrowserWindow | null = null;
    try {
      printWindow = new BrowserWindow({
        show: false,
        width: 1100,
        height: 1400,
        webPreferences: {
          sandbox: true,
          contextIsolation: true,
          nodeIntegration: false,
          webSecurity: true,
        },
      });
      await printWindow.loadFile(tempHtml);
      const pdf = await printWindow.webContents.printToPDF({
        printBackground: true,
        preferCSSPageSize: true,
        pageSize: 'A4',
        margins: { top: 0, bottom: 0, left: 0, right: 0 },
      });
      writeFileSync(outputPath, pdf);
    } catch (error) {
      throw new ExportError('PDF_EXPORT_FAILED', `PDF 生成失败：${(error as Error).message}`, {
        outputPath,
      });
    } finally {
      if (printWindow && !printWindow.isDestroyed()) printWindow.destroy();
      try {
        if (existsSync(tempHtml)) unlinkSync(tempHtml);
      } catch {
        // 临时 HTML 清理失败不影响已导出的文件
      }
    }
  }

  private renderHtml(
    projectName: string,
    headers: StoryboardHeader[],
    rows: StoryboardRow[],
    strategy: StoryboardImageStrategy,
  ): string {
    const date = new Intl.DateTimeFormat('zh-CN', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date());
    const strategyLabel =
      strategy === 'both' ? '缩略图 + 画面大图' : strategy === 'thumbnail' ? '仅缩略图' : '仅画面大图';
    const head = headers.map((header) => `<th>${escapeHtml(header.label)}</th>`).join('');
    const body = rows
      .map((row) => {
        const shot = row.shot;
        return `
          <tr>
            <td class="mono center">${String(shot.index).padStart(2, '0')}</td>
            <td class="mono center">${formatDuration(shot.durationMs)}</td>
            <td class="image-cell thumb">${this.renderImage(row.thumbnailPath, '缩略图', row.thumbnail?.timeMs)}</td>
            <td class="center">${escapeHtml(shot.shotSize ?? '—')}</td>
            <td>${escapeHtml(shot.cameraMethod ?? '—')}</td>
            <td class="image-cell content">${this.renderMainImage(row)}</td>
            <td class="text">${escapeHtml(shot.dialogue ?? '—')}</td>
            <td class="text">${escapeHtml(shot.remark ?? '—')}</td>
          </tr>
        `;
      })
      .join('');

    return `<!doctype html>
      <html lang="zh-CN">
        <head>
          <meta charset="UTF-8" />
          <style>
            @page { size: A4 portrait; margin: 12mm 10mm; }
            * { box-sizing: border-box; }
            body { margin: 0; color: #172033; font-family: "Microsoft YaHei", "SimSun", sans-serif; }
            .cover { height: 270mm; display: flex; flex-direction: column; justify-content: center; page-break-after: always; }
            .cover-kicker { color: #be123c; font-size: 12pt; font-weight: 700; letter-spacing: 4px; }
            .cover h1 { margin: 18px 0 8px; font-size: 30pt; line-height: 1.3; }
            .cover h2 { margin: 0; color: #64748b; font-size: 15pt; font-weight: 500; }
            .cover-rule { width: 72px; height: 4px; margin: 32px 0; background: #e11d48; }
            .cover-meta { display: grid; width: 100%; grid-template-columns: repeat(3, 1fr); gap: 10px; border-top: 1px solid #cbd5e1; padding-top: 12px; }
            .cover-meta span { color: #64748b; font-size: 9pt; }
            .cover-meta strong { display: block; margin-top: 4px; color: #1e293b; font-size: 12pt; }
            .content-title { margin: 0 0 10px; font-size: 16pt; }
            table { width: 100%; border-collapse: collapse; table-layout: fixed; font-size: 7.5pt; }
            thead { display: table-header-group; }
            th { padding: 6px 4px; border: 1px solid #94a3b8; background: #172033; color: #fff; font-weight: 700; }
            td { padding: 5px 4px; border: 1px solid #cbd5e1; vertical-align: middle; overflow-wrap: anywhere; }
            tr { break-inside: avoid; page-break-inside: avoid; }
            tr:nth-child(even) td { background: #f8fafc; }
            .mono { font-family: "Cascadia Mono", Consolas, monospace; }
            .center { text-align: center; }
            .text { white-space: pre-wrap; line-height: 1.45; }
            .image-cell { padding: 4px; text-align: center; }
            .image-box { position: relative; width: 100%; aspect-ratio: 16 / 9; display: flex; align-items: center; justify-content: center; background: #eef2f7; overflow: hidden; }
            .image-box img { width: 100%; height: 100%; object-fit: contain; }
            .image-placeholder { color: #94a3b8; font-size: 7pt; }
            .annotation-layer { position: absolute; inset: 0; width: 100%; height: 100%; pointer-events: none; }
            .still-time { margin-top: 2px; color: #475569; font-family: "Cascadia Mono", Consolas, monospace; font-size: 5.2pt; white-space: nowrap; }
            .annotation-note { margin-top: 2px; color: #64748b; font-size: 6pt; }
            col:nth-child(1) { width: 5%; } col:nth-child(2) { width: 7%; } col:nth-child(3) { width: 9%; }
            col:nth-child(4) { width: 6%; } col:nth-child(5) { width: 8%; } col:nth-child(6) { width: 32%; }
            col:nth-child(7) { width: 19%; } col:nth-child(8) { width: 14%; }
          </style>
        </head>
        <body>
          <section class="cover">
            <div class="cover-kicker">PERSONAL FILM LAB</div>
            <h1>${escapeHtml(projectName)}</h1>
            <h2>镜头分析与标准分镜本</h2>
            <div class="cover-rule"></div>
            <div class="cover-meta">
              <span>镜头数量<strong>${rows.length}</strong></span>
              <span>图片策略<strong>${strategyLabel}</strong></span>
              <span>导出日期<strong>${date}</strong></span>
            </div>
          </section>
          <section>
            <h2 class="content-title">分镜表</h2>
            <table>
              <colgroup><col /><col /><col /><col /><col /><col /><col /><col /></colgroup>
              <thead><tr>${head}</tr></thead>
              <tbody>${body}</tbody>
            </table>
          </section>
        </body>
      </html>`;
  }

  private renderImage(filePath: string | null, alt: string, timeMs?: number): string {
    const image =
      !filePath || !existsSync(filePath)
        ? `<div class="image-box"><span class="image-placeholder">${alt}未生成</span></div>`
        : `<div class="image-box"><img src="${toDataUri(filePath)}" alt="${alt}" /></div>`;
    return `${image}${this.renderStillTime(timeMs)}`;
  }

  private renderMainImage(row: StoryboardRow): string {
    if (!row.imagePath || !existsSync(row.imagePath)) {
      return '<div class="image-box"><span class="image-placeholder">未截取正式静帧</span></div>';
    }
    const annotations = row.mainStill?.annotations ?? [];
    return `<div class="image-box">
      <img src="${toDataUri(row.imagePath)}" alt="画面内容" />
      <svg class="annotation-layer" viewBox="0 0 1000 562.5" preserveAspectRatio="none">
        ${annotations.map(annotationSvg).join('')}
      </svg>
    </div>
    ${this.renderStillTime(row.mainStill?.timeMs)}
    ${annotations.length ? `<div class="annotation-note">包含 ${annotations.length} 个标注</div>` : ''}`;
  }

  private renderStillTime(timeMs?: number): string {
    return Number.isFinite(timeMs)
      ? `<div class="still-time">${formatTimeMs(timeMs as number)}</div>`
      : '';
  }

  private async exportDocx(
    projectName: string,
    headers: StoryboardHeader[],
    rows: StoryboardRow[],
    outputPath: string,
  ): Promise<void> {
    const headerRow = new TableRow({
      tableHeader: true,
      cantSplit: true,
      children: headers.map(
        (header, index) =>
          new TableCell({
            width: { size: DOCX_COLUMN_WIDTHS[index], type: WidthType.DXA },
            shading: { fill: '172033', type: ShadingType.CLEAR, color: 'auto' },
            verticalAlign: VerticalAlign.CENTER,
            children: [docxParagraph(header.label, { bold: true, color: 'FFFFFF', align: AlignmentType.CENTER })],
          }),
      ),
    });

    const rowElements = rows.map(
      (row, rowIndex) =>
        new TableRow({
          cantSplit: true,
          children: [
            docxCell(String(row.shot.index).padStart(2, '0'), 0, AlignmentType.CENTER, true, rowFill(rowIndex)),
            docxCell(formatDuration(row.shot.durationMs), 1, AlignmentType.CENTER, true, rowFill(rowIndex)),
            docxImageCell(
              row.thumbnailPath,
              2,
              row.thumbnail?.annotations.length ?? 0,
              row.thumbnail?.timeMs,
              false,
              rowFill(rowIndex),
            ),
            docxCell(row.shot.shotSize ?? '—', 3, AlignmentType.CENTER, false, rowFill(rowIndex)),
            docxCell(row.shot.cameraMethod ?? '—', 4, undefined, false, rowFill(rowIndex)),
            docxImageCell(
              row.imagePath,
              5,
              row.mainStill?.annotations.length ?? 0,
              row.mainStill?.timeMs,
              true,
              rowFill(rowIndex),
            ),
            docxCell(row.shot.dialogue ?? '—', 6, undefined, false, rowFill(rowIndex)),
            docxCell(row.shot.remark ?? '—', 7, undefined, false, rowFill(rowIndex)),
          ],
        }),
    );

    const document = new Document({
      creator: '个人拉片工作台',
      title: `${projectName} 分镜本`,
      sections: [
        {
          properties: {
            page: {
              size: {
                width: 11906,
                height: 16838,
                orientation: PageOrientation.PORTRAIT,
              },
              margin: { top: 720, right: 720, bottom: 720, left: 720 },
            },
          },
          children: [
            new Paragraph({ spacing: { before: 2600 }, children: [] }),
            docxParagraph('PERSONAL FILM LAB', { color: 'BE123C', bold: true, size: 20, align: AlignmentType.CENTER }),
            docxParagraph(projectName, { bold: true, size: 52, align: AlignmentType.CENTER }),
            docxParagraph('镜头分析与标准分镜本', { color: '64748B', size: 28, align: AlignmentType.CENTER }),
            docxParagraph(`共 ${rows.length} 个镜头`, { color: '64748B', size: 20, align: AlignmentType.CENTER }),
            new Paragraph({ children: [], pageBreakBefore: false }),
            new Paragraph({ children: [new PageBreak()] }),
            docxParagraph('分镜表', { bold: true, size: 32 }),
            new Table({
              rows: [headerRow, ...rowElements],
              width: { size: 10466, type: WidthType.DXA },
              columnWidths: DOCX_COLUMN_WIDTHS,
              layout: TableLayoutType.FIXED,
              borders: {
                top: { style: BorderStyle.SINGLE, size: 4, color: 'CBD5E1' },
                bottom: { style: BorderStyle.SINGLE, size: 4, color: 'CBD5E1' },
                left: { style: BorderStyle.SINGLE, size: 4, color: 'CBD5E1' },
                right: { style: BorderStyle.SINGLE, size: 4, color: 'CBD5E1' },
                insideHorizontal: { style: BorderStyle.SINGLE, size: 2, color: 'CBD5E1' },
                insideVertical: { style: BorderStyle.SINGLE, size: 2, color: 'CBD5E1' },
              },
            }),
          ],
        },
      ],
    });

    try {
      const buffer = await Packer.toBuffer(document);
      writeFileSync(outputPath, buffer);
    } catch (error) {
      throw new ExportError('DOCX_EXPORT_FAILED', `Word 生成失败：${(error as Error).message}`, {
        outputPath,
      });
    }
  }
}

function mergeHeaders(headers?: StoryboardHeader[]): StoryboardHeader[] {
  if (!headers) return DEFAULT_HEADERS;
  const byKey = new Map(headers.map((header) => [header.key, header.label]));
  return DEFAULT_HEADERS.map((header) => ({
    ...header,
    label: byKey.get(header.key)?.trim() || header.label,
  }));
}

function formatDuration(ms: number): string {
  const totalTenths = Math.max(0, Math.round(ms / 100));
  const minutes = Math.floor(totalTenths / 600);
  const seconds = Math.floor((totalTenths % 600) / 10);
  const tenths = totalTenths % 10;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}.${tenths}`;
}

function toDataUri(filePath: string): string {
  const ext = extname(filePath).toLowerCase();
  const mime = ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : 'image/jpeg';
  return `data:${mime};base64,${readFileSync(filePath).toString('base64')}`;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function annotationSvg(annotation: Annotation): string {
  if (annotation.type === 'box') {
    return `<rect x="${(annotation.x ?? 0) * 1000}" y="${(annotation.y ?? 0) * 562.5}" width="${(annotation.w ?? 0) * 1000}" height="${(annotation.h ?? 0) * 562.5}" fill="none" stroke="${annotation.color ?? '#e11d48'}" stroke-width="3" />`;
  }
  if (annotation.type === 'arrow') {
    const start = annotation.points?.[0] ?? [0, 0];
    const end = annotation.points?.[1] ?? [0, 0];
    return `<g stroke="${annotation.color ?? '#f59e0b'}" stroke-width="3" fill="${annotation.color ?? '#f59e0b'}"><line x1="${start[0] * 1000}" y1="${start[1] * 562.5}" x2="${end[0] * 1000}" y2="${end[1] * 562.5}" /><circle cx="${end[0] * 1000}" cy="${end[1] * 562.5}" r="6" /></g>`;
  }
  return `<text x="${(annotation.x ?? 0) * 1000}" y="${(annotation.y ?? 0) * 562.5}" fill="${annotation.color ?? '#f8fafc'}" font-size="20" font-weight="600">${escapeHtml(annotation.label ?? '')}</text>`;
}

function docxParagraph(
  text: string,
  options: {
    bold?: boolean;
    color?: string;
    size?: number;
    align?: (typeof AlignmentType)[keyof typeof AlignmentType];
  } = {},
): Paragraph {
  return new Paragraph({
    alignment: options.align,
    spacing: { after: 80 },
    children: [
      new TextRun({
        text,
        bold: options.bold,
        color: options.color,
        size: options.size ?? 18,
        font: {
          ascii: 'Microsoft YaHei',
          hAnsi: 'Microsoft YaHei',
          eastAsia: 'Microsoft YaHei',
        },
      }),
    ],
  });
}

function docxCell(
  text: string,
  column: number,
  align?: (typeof AlignmentType)[keyof typeof AlignmentType],
  mono = false,
  fill?: string,
): TableCell {
  return new TableCell({
    width: { size: DOCX_COLUMN_WIDTHS[column], type: WidthType.DXA },
    verticalAlign: VerticalAlign.CENTER,
    margins: { top: 80, bottom: 80, left: 80, right: 80 },
    shading: fill ? { fill, type: ShadingType.CLEAR, color: 'auto' } : undefined,
    children: [
      docxParagraph(text, {
        align,
        size: mono ? 17 : 16,
      }),
    ],
  });
}

function docxImageCell(
  filePath: string | null,
  column: number,
  annotationCount: number,
  timeMs?: number,
  large = false,
  fill?: string,
): TableCell {
  const children: Paragraph[] = [];
  if (filePath && existsSync(filePath)) {
    const buffer = readFileSync(filePath);
    const width = large ? 150 : 88;
    const height = Math.round((width * 9) / 16);
    const type = extname(filePath).toLowerCase() === '.png' ? 'png' : 'jpg';
    children.push(
      new Paragraph({
        alignment: AlignmentType.CENTER,
        children: [
          new ImageRun({
            data: buffer,
            type,
            transformation: { width, height },
          }),
        ],
      }),
    );
  } else {
    children.push(docxParagraph('未生成', { align: AlignmentType.CENTER, color: '94A3B8' }));
  }
  if (Number.isFinite(timeMs)) {
    children.push(
      docxParagraph(formatTimeMs(timeMs as number), {
        align: AlignmentType.CENTER,
        color: '475569',
        size: 14,
      }),
    );
  }
  if (annotationCount > 0) {
    children.push(docxParagraph(`标注 ${annotationCount}`, { align: AlignmentType.CENTER, color: '64748B', size: 14 }));
  }
  return new TableCell({
    width: { size: DOCX_COLUMN_WIDTHS[column], type: WidthType.DXA },
    verticalAlign: VerticalAlign.CENTER,
    margins: { top: 60, bottom: 60, left: 50, right: 50 },
    shading: fill ? { fill, type: ShadingType.CLEAR, color: 'auto' } : undefined,
    children,
  });
}

function rowFill(index: number): string | undefined {
  return index % 2 === 0 ? undefined : 'F8FAFC';
}
