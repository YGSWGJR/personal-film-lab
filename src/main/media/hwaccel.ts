import { spawnSync } from 'node:child_process';
import { resolveFfmpegBinaries } from './ffmpeg-binaries';

export type SelectedHwaccel = 'cuda' | 'd3d11va' | 'none';

let cached: Promise<string[]> | null = null;

export function parseHwaccels(output: string): string[] {
  const names: string[] = [];
  const seen = new Set<string>();
  for (const line of output.split(/\r?\n/u)) {
    const name = line.trim();
    if (!name || name.toLowerCase().startsWith('hardware acceleration methods')) continue;
    if (!/^[a-z0-9_]+$/iu.test(name) || seen.has(name)) continue;
    names.push(name);
    seen.add(name);
  }
  return names;
}

export function resolveAvailableHwaccels(): Promise<string[]> {
  const cacheHit = cached !== null;
  if (!cached) {
    cached = (async () => {
      try {
        const { ffmpeg } = await resolveFfmpegBinaries();
        const result = spawnSync(ffmpeg, ['-hide_banner', '-hwaccels'], {
          windowsHide: true,
          encoding: 'utf8',
          timeout: 10_000,
          maxBuffer: 1024 * 1024,
        });
        if (result.error || result.status !== 0) return [];
        const output = `${result.stdout || ''}\n${result.stderr || ''}`;
        return output.trim().length > 0 ? parseHwaccels(output) : [];
      } catch {
        return [];
      }
    })();
  }

  return cached.then((hwaccels) => {
    const available = hwaccels.length > 0 ? hwaccels.join(',') : 'none';
    const selected = selectHwaccel(hwaccels);
    console.info(`[hwaccel] available: ${available} | selected: ${selected} (cache hit: ${cacheHit})`);
    return hwaccels;
  });
}

export function selectHwaccel(hwaccels: string[]): SelectedHwaccel {
  const available = new Set(hwaccels.map((name) => name.toLowerCase()));
  if (available.has('cuda')) return 'cuda';
  if (available.has('d3d11va')) return 'd3d11va';
  return 'none';
}
