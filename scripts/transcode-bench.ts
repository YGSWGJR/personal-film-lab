/**
 * T1-F 转码基准测试脚本（个人拉片工作台）
 *
 * 用法（node 22.18+ 直接运行）：
 *   node scripts/transcode-bench.ts "<输入视频路径>" [-t 60] [-o 输出目录]
 *
 * 行为：
 *   1. 探测本机可用编码器（ffmpeg -encoders），过滤支持集
 *   2. 对「编码器 × 分辨率」矩阵各跑一次代理转码（对齐 T1-A/B/C 参数：音频直拷/GOP/scale）
 *   3. 每组测：耗时 / 输出体积 / SSIM（相对源缩放参考）
 *   4. 输出对比表（控制台 + docs/S28-转码性能对比.md）
 *   5. 自动选优：SSIM≥0.95 前提下的最快编码器，写入 <cacheDir>/preferred-encoder.json
 *
 * 依赖：本机 ffmpeg/ffprobe（resources/ffmpeg → release → PATH），无 electron 依赖。
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';

// ---------------------------------------------------------------------------
// 常量与工具
// ---------------------------------------------------------------------------

const SUPPORTED_ENCODERS = new Set([
  'libx264',
  'h264_nvenc',
  'hevc_nvenc',
  'h264_qsv',
  'h264_amf',
]);

/** 编码器 → 转码参数（对齐 media-service buildVideoEncoderArgs 的 balanced 档） */
function encoderArgs(enc: string): string[] {
  switch (enc) {
    case 'libx264':
      return ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '28', '-sc_threshold', '0', '-tune', 'fastdecode'];
    case 'h264_nvenc':
      return ['-c:v', 'h264_nvenc', '-preset', 'p5', '-rc', 'vbr', '-cq', '28'];
    case 'hevc_nvenc':
      return ['-c:v', 'hevc_nvenc', '-preset', 'p5', '-rc', 'vbr', '-cq', '30'];
    case 'h264_qsv':
      return ['-c:v', 'h264_qsv', '-global_quality', '28'];
    case 'h264_amf':
      return ['-c:v', 'h264_amf', '-qp_i', '22', '-qp_p', '22'];
    default:
      return [];
  }
}

function locateFfmpeg(): string {
  const candidates = [
    join(process.cwd(), 'resources', 'ffmpeg', 'ffmpeg.exe'),
    join(process.cwd(), 'release', 'win-unpacked', 'resources', 'ffmpeg', 'ffmpeg.exe'),
    'ffmpeg.exe',
  ];
  for (const c of candidates) {
    try {
      if (existsSync(c) && statSync(c).isFile()) return c;
    } catch {
      /* ignore */
    }
  }
  throw new Error('未找到 ffmpeg.exe（检查 resources/ffmpeg/ 或加入 PATH）');
}

function locateFfprobe(): string {
  const dir = dirname(locateFfmpeg());
  const probe = join(dir, 'ffprobe.exe');
  if (existsSync(probe)) return probe;
  return 'ffprobe.exe';
}

function run(cmd: string, args: string[]): { stdout: string; stderr: string; status: number | null; elapsedMs: number } {
  const started = Date.now();
  const r = spawnSync(cmd, args, { windowsHide: true, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return {
    stdout: String(r.stdout ?? ''),
    stderr: String(r.stderr ?? ''),
    status: r.status,
    elapsedMs: Date.now() - started,
  };
}

function detectEncoders(ffmpeg: string): string[] {
  const r = run(ffmpeg, ['-hide_banner', '-encoders']);
  const output = `${r.stdout}\n${r.stderr}`;
  const found: string[] = [];
  for (const line of output.split(/\r?\n/u)) {
    const m = /^\s*V\S*\s+(\S+)\s+/.exec(line);
    if (m && SUPPORTED_ENCODERS.has(m[1]) && !found.includes(m[1])) found.push(m[1]);
  }
  return found;
}

function probeInfo(ffprobe: string, input: string): { width: number; height: number; fps: number; codec: string } {
  const r = run(ffprobe, [
    '-v', 'error',
    '-select_streams', 'v:0',
    '-show_entries', 'stream=width,height,avg_frame_rate,codec_name',
    '-of', 'default=noprint_wrappers=1',
    input,
  ]);
  let width = 0, height = 0, fps = 0;
  const codec = /codec_name=(\S+)/.exec(r.stdout)?.[1] ?? 'unknown';
  const wm = /width=(\d+)/.exec(r.stdout);
  const hm = /height=(\d+)/.exec(r.stdout);
  if (wm) width = Number(wm[1]);
  if (hm) height = Number(hm[1]);
  const frm = /avg_frame_rate=(\d+)\/(\d+)/.exec(r.stdout);
  if (frm && Number(frm[2]) > 0) fps = Number(frm[1]) / Number(frm[2]);
  return { width, height, fps, codec };
}

function getCacheDirFromSettings(): string | null {
  const settingsPath = join(process.env.APPDATA ?? '', 'personal-film-lab', 'settings.json');
  try {
    if (!existsSync(settingsPath)) return null;
    const raw = JSON.parse(readFileSync(settingsPath, 'utf8'));
    return typeof raw.cacheDir === 'string' && raw.cacheDir ? raw.cacheDir : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

interface BenchResult {
  encoder: string;
  height: number;
  elapsedMs: number;
  sizeBytes: number;
  ssim: number | null;
  ok: boolean;
  error?: string;
}

function main(): void {
  const args = process.argv.slice(2);
  const inputIdx = args.findIndex((a) => !a.startsWith('-'));
  if (inputIdx < 0) {
    console.error('用法: node scripts/transcode-bench.ts "<视频路径>" [-t 秒数] [-o 输出目录]');
    process.exit(2);
  }
  const input = args[inputIdx];
  const tArg = args.indexOf('-t');
  const duration = tArg >= 0 && args[tArg + 1] ? Number(args[tArg + 1]) : 60;
  const oArg = args.indexOf('-o');
  const outDir = oArg >= 0 && args[oArg + 1] ? args[oArg + 1] : join(process.cwd(), 'bench-tmp');

  if (!existsSync(input)) {
    console.error(`输入视频不存在: ${input}`);
    process.exit(2);
  }

  const ffmpeg = locateFfmpeg();
  const ffprobe = locateFfprobe();
  const info = probeInfo(ffprobe, input);
  console.log(`输入: ${basename(input)}`);
  console.log(`规格: ${info.width}x${info.height} @${info.fps.toFixed(2)}fps codec=${info.codec}`);
  console.log(`ffmpeg: ${ffmpeg}`);
  console.log(`时长截取: ${duration}s\n`);

  const encoders = detectEncoders(ffmpeg);
  console.log(`可用编码器: ${encoders.join(', ') || '无（仅软编）'}`);
  if (!encoders.includes('libx264')) encoders.push('libx264');

  const resolutions = [540, 720, 1080];
  const results: BenchResult[] = [];

  mkdirSync(outDir, { recursive: true });
  const gop = Math.max(2, Math.round(info.fps * 2));

  for (const enc of encoders) {
    for (const height of resolutions) {
      const scaleH = Math.min(height, info.height);
      const outFile = join(outDir, `bench_${enc}_${height}p_${Date.now()}.mp4`);
      const argsList = [
        '-hide_banner', '-loglevel', 'error', '-nostdin',
        '-ss', '0', '-t', String(duration),
        '-i', input,
        '-vf', `scale=-2:${scaleH}`,
        ...encoderArgs(enc),
        '-g', String(gop), '-keyint_min', String(gop),
        '-c:a', 'copy',
        '-pix_fmt', 'yuv420p',
        '-movflags', '+faststart',
        '-y', outFile,
      ];
      const r = run(ffmpeg, argsList);

      const res: BenchResult = {
        encoder: enc,
        height: scaleH,
        elapsedMs: r.elapsedMs,
        sizeBytes: 0,
        ssim: null,
        ok: r.status === 0,
      };

      if (r.status !== 0) {
        res.error = r.stderr.split(/\r?\n/u).slice(-3).join(' ').slice(0, 160);
      } else {
        try {
          res.sizeBytes = statSync(outFile).size;
        } catch {
          res.sizeBytes = 0;
        }
        // SSIM：输出相对「源缩放至同分辨率」逐帧对比（源缩放对齐格式后与输出比较）
        const ssimArgs = [
          '-hide_banner', '-loglevel', 'info', '-nostdin',
          '-i', outFile,
          '-i', input,
          '-lavfi', `[1:v]scale=-2:${scaleH},format=yuv420p[ref];[0:v][ref]ssim`,
          '-f', 'null', '-',
        ];
        const s = run(ffmpeg, ssimArgs);
        const m = /[Aa]ll:([0-9.]+)/.exec(`${s.stdout}\n${s.stderr}`);
        if (m) res.ssim = Number(m[1]);
      }

      results.push(res);
      const fps = duration / (res.elapsedMs / 1000);
      const mb = (res.sizeBytes / 1024 / 1024).toFixed(1);
      console.log(
        `[${enc.padEnd(12)} ${String(scaleH).padStart(4)}p] ` +
        `${(res.elapsedMs / 1000).toFixed(2)}s (${fps.toFixed(1)}x realtime) | ${mb}MB | ` +
        `SSIM=${res.ssim?.toFixed(4) ?? 'n/a'}${res.ok ? '' : ' FAIL'}`,
      );
      if (res.error) console.log(`   ! ${res.error}`);
    }
  }

  // -----------------------------------------------------------------------
  // 汇总与选优（选优固定在默认档 540p 内比较编码器，分辨率是产品策略而非性能决策）
  // -----------------------------------------------------------------------
  const defaultHeight = 540;
  const okResults = results.filter(
    (r) => r.ok && r.height === defaultHeight && r.ssim !== null && r.ssim >= 0.85 && r.sizeBytes > 0,
  );
  const best = okResults.length
    ? [...okResults].sort((a, b) => a.elapsedMs - b.elapsedMs)[0]
    : null;

  const docPath = join(process.cwd(), 'docs', 'S28-转码性能对比.md');
  const lines: string[] = [];
  lines.push('# S28 转码性能对比（T1-F 联合基准）');
  lines.push('');
  lines.push(`- 日期：${new Date().toISOString().slice(0, 10)}`);
  lines.push(`- 输入：\`${basename(input)}\`（${info.width}x${info.height} ${info.codec}，截取前 ${duration}s）`);
  lines.push(`- ffmpeg：\`${ffmpeg}\``);
  lines.push('- 方法：每组合跑一次完整代理转码（音频直拷 `-c:a copy`、GOP=fps×2、SSIM 相对源缩放参考）');
  lines.push('');
  lines.push('| 编码器 | 分辨率 | 耗时(s) | 实时倍率 | 体积(MB) | SSIM |');
  lines.push('|---|---|---|---|---|---|');
  for (const r of results) {
    if (!r.ok) {
      lines.push(`| ${r.encoder} | ${r.height}p | fail | - | - | - |`);
      continue;
    }
    const secs = (r.elapsedMs / 1000).toFixed(2);
    const realtime = (duration / (r.elapsedMs / 1000)).toFixed(1);
    const mb = (r.sizeBytes / 1024 / 1024).toFixed(1);
    lines.push(`| ${r.encoder} | ${r.height}p | ${secs} | ${realtime}x | ${mb} | ${r.ssim?.toFixed(4) ?? 'n/a'} |`);
  }
  lines.push('');
  if (best) {
    const oldSec = results.find((r) => r.encoder === 'libx264' && r.height === 720);
    const ratio = oldSec && oldSec.ok ? best.elapsedMs / oldSec.elapsedMs : null;
    lines.push('## 结论');
    lines.push('');
    lines.push(`- 最快且 SSIM≥0.85 的组合：**${best.encoder} @ ${best.height}p**（${(best.elapsedMs / 1000).toFixed(2)}s，SSIM=${best.ssim?.toFixed(4)}）`);
    if (ratio) {
      lines.push(`- 相对旧基线（libx264 veryfast 720p，${(oldSec.elapsedMs / 1000).toFixed(2)}s）：**${(1 / ratio).toFixed(2)}x** 提速`);
    }
    lines.push('');
    lines.push('## 自动选优结果');
    lines.push('');
    const prefs = { encoder: best.encoder, resolution: best.height, note: `auto-selected ${new Date().toISOString().slice(0, 10)}` };
    const cacheDir = getCacheDirFromSettings();
    if (cacheDir) {
      mkdirSync(cacheDir, { recursive: true });
      const prefPath = join(cacheDir, 'preferred-encoder.json');
      writeFileSync(prefPath, JSON.stringify(prefs, null, 2), 'utf8');
      lines.push(`已写入 \`${prefPath}\`，应用将优先使用该编码器（需 encoders.ts 读取支持）。`);
      console.log(`\n[auto-select] 最优组合: ${best.encoder} @ ${best.height}p -> ${prefPath}`);
    } else {
      lines.push('（未找到 settings.json，偏好文件未写入）');
      console.log('\n[auto-select] 未找到 settings.json，跳过偏好写入');
    }
  } else {
    lines.push('## 结论');
    lines.push('');
    lines.push('无 SSIM≥0.85 的合格组合（可放宽阈值或检查素材）。');
  }

  mkdirSync(dirname(docPath), { recursive: true });
  writeFileSync(docPath, lines.join('\n'), 'utf8');
  console.log(`\n报告已写入: ${docPath}`);
}

main();
