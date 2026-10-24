import { spawnSync } from 'node:child_process';
import { resolveFfmpegBinaries } from './ffmpeg-binaries';

export interface VideoEncoderInfo {
  name: string;
  vendor: 'nvidia' | 'intel' | 'amd' | 'software';
  codec: 'h264' | 'hevc';
}

const SUPPORTED_ENCODERS = new Set([
  'h264_nvenc',
  'hevc_nvenc',
  'h264_qsv',
  'hevc_qsv',
  'h264_amf',
  'hevc_amf',
  'libx264',
]);

const SELECTION_ORDER = [
  'h264_nvenc',
  'hevc_nvenc',
  'h264_qsv',
  'h264_amf',
  'libx264',
];

const SOFTWARE_FALLBACK: VideoEncoderInfo = {
  name: 'libx264',
  vendor: 'software',
  codec: 'h264',
};

let cached: Promise<VideoEncoderInfo[]> | null = null;

/** 解析 `ffmpeg -encoders` 输出中的受支持视频编码器。 */
export function parseEncoders(output: string): VideoEncoderInfo[] {
  const encoders: VideoEncoderInfo[] = [];
  const seen = new Set<string>();

  for (const line of output.split(/\r?\n/u)) {
    const match = /^\s*(V\S*)\s+(\S+)\s+(.+)$/u.exec(line);
    if (!match || !SUPPORTED_ENCODERS.has(match[2])) continue;
    const name = match[2];
    if (seen.has(name)) continue;

    const lowerLine = line.toLowerCase();
    let vendor: VideoEncoderInfo['vendor'] = 'software';
    if (lowerLine.includes('nvidia nvenc')) {
      vendor = 'nvidia';
    } else if (lowerLine.includes('intel quick sync') || lowerLine.includes('qsv')) {
      vendor = 'intel';
    } else if (lowerLine.includes('amd')) {
      vendor = 'amd';
    }

    encoders.push({
      name,
      vendor,
      codec: name.startsWith('hevc_') ? 'hevc' : 'h264',
    });
    seen.add(name);
  }

  return encoders;
}

/**
 * 探测可用编码器并在进程生命周期内缓存。
 * 探测失败按“无硬编”处理，避免阻塞代理转码。
 */
export function resolveAvailableEncoders(): Promise<VideoEncoderInfo[]> {
  const cacheHit = cached !== null;

  if (!cached) {
    cached = (async () => {
      try {
        const { ffmpeg } = await resolveFfmpegBinaries();
        const result = spawnSync(ffmpeg, ['-hide_banner', '-encoders'], {
          windowsHide: true,
          encoding: 'utf8',
          timeout: 10_000,
          maxBuffer: 16 * 1024 * 1024,
        });
        if (result.error || result.status !== 0) return [];

        const output = `${result.stdout || ''}\n${result.stderr || ''}`;
        return output.trim().length > 0 ? parseEncoders(output) : [];
      } catch {
        return [];
      }
    })();
  }

  return cached.then((encoders) => {
    logEncoderSelection(encoders, cacheHit);
    return encoders;
  });
}

/** 按任务约定选择最优编码器；没有可用探测结果时返回 libx264 兜底。 */
export function selectBestEncoder(encoders: VideoEncoderInfo[]): VideoEncoderInfo {
  const byName = new Map(encoders.map((encoder) => [encoder.name, encoder]));
  for (const name of SELECTION_ORDER) {
    const encoder = byName.get(name);
    if (encoder) return encoder;
  }
  return SOFTWARE_FALLBACK;
}

export function isHardwareEncoder(name: string): boolean {
  return name.endsWith('_nvenc') || name.endsWith('_qsv') || name.endsWith('_amf');
}

function logEncoderSelection(encoders: VideoEncoderInfo[], cacheHit: boolean): void {
  const available = encoders.length > 0 ? encoders.map((encoder) => encoder.name).join(',') : 'none';
  const selected = selectBestEncoder(encoders).name;
  console.info(`[encoders] available: ${available} | selected: ${selected} (cache hit: ${cacheHit})`);
}
