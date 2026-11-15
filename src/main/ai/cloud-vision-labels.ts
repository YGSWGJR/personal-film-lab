import { readFileSync } from 'node:fs';
import { extname } from 'node:path';

/**
 * S42/Z03：云端标签识别的契约（提示词、图片编码与结果规整）。
 * 云端只做"标签识别"（景别/机位/运镜/光线/声音/剪辑 + 画面描述），
 * 不做镜头边界切分——切分永远在本机由 TransNetV2/OpenCV 完成。
 */

export interface CloudVisionLabelInput {
  id: string;
  index: number;
  imagePath: string;
}

export interface CloudVisionLabelResult {
  id: string;
  remark: string;
  shotSize: string;
  cameraMethod: string;
  tags: Record<string, string[]>;
  confidence: number;
}

const MANAGED_CATEGORIES = ['景别', '机位', '运镜', '光线', '声音', '剪辑'] as const;

export const CLOUD_LABEL_PROMPT = [
  '你是影视拉片助手。输入是若干张镜头代表帧（按顺序编号）。',
  '只输出一个 JSON 对象，不要 Markdown，结构必须是：',
  '{"results":[{"index":number,"shotSize":string,"cameraMethod":string,',
  '"remark":string,"tags":{"景别":string[],"机位":string[],"运镜":string[],"光线":string[],"声音":string[],"剪辑":string[]},',
  '"confidence":0..1}]}',
  '要求：results 按 index 顺序且数量与输入一致；shotSize 用中文景别（如 远景/全景/中景/近景/特写）；',
  'cameraMethod 描述机位与运镜；remark 为 30 字以内的画面内容描述；',
  'tags 必须包含上述六个键（可为空数组）；声音标签只能根据画面推断，不确定就留空数组。',
].join('\n');

const MIME_BY_EXT: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.bmp': 'image/bmp',
};

/** 把本地代表帧编码为 data URL（云端请求体）；文件缺失时抛错由上层转为结构化错误 */
export function buildImageDataUrl(imagePath: string): string {
  const ext = extname(imagePath).toLowerCase();
  const mime = MIME_BY_EXT[ext] ?? 'image/jpeg';
  const buffer = readFileSync(imagePath);
  if (buffer.length === 0) {
    throw new Error(`代表帧为空：${imagePath}`);
  }
  return `data:${mime};base64,${buffer.toString('base64')}`;
}

/**
 * 把模型返回的 results 规整为强类型结果：
 * - 按 index 匹配输入帧（缺号/越界按顺序兜底），不产出多余对象；
 * - tags 只保留六个受管分类，字符串逐项截断，杜绝模型输出注入未分类键。
 */
export function normalizeCloudLabelResults(
  parsed: unknown,
  batch: CloudVisionLabelInput[],
): CloudVisionLabelResult[] {
  const rawResults = extractResultsArray(parsed);
  const byIndex = new Map<number, unknown>();
  let fallbackCursor = 0;
  for (const item of rawResults) {
    if (!item || typeof item !== 'object') continue;
    const record = item as Record<string, unknown>;
    const index = Number(record.index);
    if (Number.isInteger(index) && index >= 1 && index <= batch.length && !byIndex.has(index)) {
      byIndex.set(index, item);
    } else {
      while (fallbackCursor < batch.length && byIndex.has(fallbackCursor + 1)) fallbackCursor += 1;
      if (fallbackCursor < batch.length) {
        byIndex.set(fallbackCursor + 1, item);
        fallbackCursor += 1;
      }
    }
  }
  const results: CloudVisionLabelResult[] = [];
  for (let position = 0; position < batch.length; position += 1) {
    const input = batch[position];
    const raw = byIndex.get(position + 1) as Record<string, unknown> | undefined;
    if (!raw) continue;
    results.push({
      id: input.id,
      remark: cleanText(raw.remark, 200),
      shotSize: cleanText(raw.shotSize, 40),
      cameraMethod: cleanText(raw.cameraMethod, 120),
      tags: normalizeCloudTagGroups(raw.tags),
      confidence: clampConfidence(raw.confidence),
    });
  }
  return results;
}

function extractResultsArray(parsed: unknown): unknown[] {
  if (Array.isArray(parsed)) return parsed;
  if (parsed && typeof parsed === 'object') {
    const record = parsed as Record<string, unknown>;
    if (Array.isArray(record.results)) return record.results;
    if (Array.isArray(record.shots)) return record.shots;
  }
  return [];
}

function normalizeCloudTagGroups(value: unknown): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const category of MANAGED_CATEGORIES) {
    out[category] = [];
  }
  if (!value || typeof value !== 'object') return out;
  const record = value as Record<string, unknown>;
  for (const category of MANAGED_CATEGORIES) {
    const raw = record[category];
    if (!Array.isArray(raw)) continue;
    out[category] = raw
      .map((item) => cleanText(item, 40))
      .filter((item) => item.length > 0)
      .slice(0, 10);
  }
  return out;
}

function cleanText(value: unknown, maxLength: number): string {
  if (typeof value !== 'string') return '';
  return value.trim().slice(0, maxLength);
}

function clampConfidence(value: unknown): number {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  return Math.max(0, Math.min(1, number));
}
