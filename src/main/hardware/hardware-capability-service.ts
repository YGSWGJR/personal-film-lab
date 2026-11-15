import { statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import os from 'node:os';
import type {
  HardwareCapabilityReport,
  HardwareCapabilityState,
  HardwareGpuInfo,
  HardwarePythonInfo,
  Settings,
} from '../../shared/types';
import { resolveActiveProvider } from '../ai/provider';
import type { LocalVisionService } from '../ai/local-vision-service';
import type { MediaService } from '../media/media-service';
import {
  embeddedPythonExecutable,
  probePythonEnvironment,
  resolvePythonExecutable,
  resolveTransnetModelPath,
} from '../detect/detect-service';
import { resolveFfmpegBinaries } from '../media/ffmpeg-binaries';
import { hasInternetConnection } from './internet-connection';

/**
 * S42/Z04：硬件能力扫描服务。
 * 启动后首次 status() 自动扫描并缓存 60 秒；手动重扫（force）用于驱动 / 模型 / 运行时
 * 变化后的刷新，无需重启应用。五类状态（满足 / 显存不足 / 模型缺失 / 运行时缺失 / 断网）
 * 都给出结构化原因与修复指引；本地与云端两条标签能力线分开报告，二者都不可用时 UI 明确阻塞，
 * 不静默上云。GPU 复用 MediaService 的 nvidia-smi 链路，Python 复用 DetectService 的
 * 环境探测，网络状态读取 Windows Network List Manager。
 */

/** 本地 Qwen3-VL（W4A8 8B）可运行的最低空闲显存（MiB） */
const QWEN_MIN_FREE_VRAM_MB = 6000;
/** status() 的缓存有效期；手动重扫走 force 不受此限制 */
const CACHE_TTL_MS = 60_000;

export interface HardwareCapabilityDeps {
  getLocalVision: () => LocalVisionService | null;
  getMedia: () => MediaService | null;
  getSettings: () => Settings | null;
}

export class HardwareCapabilityService {
  private cached: HardwareCapabilityReport | null = null;
  private scanning: Promise<HardwareCapabilityReport> | null = null;

  constructor(private readonly deps: HardwareCapabilityDeps) {}

  /** 读取报告：缓存未过期直接返回；无缓存自动扫描一次 */
  async getStatus(): Promise<HardwareCapabilityReport> {
    if (this.cached && Date.now() - Date.parse(this.cached.scannedAt) < CACHE_TTL_MS) {
      return this.cached;
    }
    return this.scan({ force: false });
  }

  /** 手动/自动扫描。并发调用共享同一次扫描 */
  async scan(options: { force?: boolean }): Promise<HardwareCapabilityReport> {
    if (!options.force && this.cached) return this.cached;
    if (this.scanning) return this.scanning;
    this.scanning = this.performScan().finally(() => {
      this.scanning = null;
    });
    this.cached = await this.scanning;
    return this.cached;
  }

  private async performScan(): Promise<HardwareCapabilityReport> {
    const startedAt = Date.now();
    const gpu = await this.queryGpuViaMediaService();
    const python = probePythonInfo();
    const transnetModel = inspectModelFile(resolveTransnetModelPath());
    const qwen = this.inspectQwen();
    const network = { online: await hasInternetConnection(), checkedAt: new Date().toISOString() };
    let ffmpegOk = false;
    let ffmpegError: string | null = null;
    try {
      const binaries = await resolveFfmpegBinaries();
      ffmpegOk = Boolean(binaries.ffmpeg);
    } catch (error) {
      ffmpegError = (error as Error).message;
    }
    const report: HardwareCapabilityReport = {
      scannedAt: new Date().toISOString(),
      durationMs: Date.now() - startedAt,
      ram: {
        totalMb: Math.round(os.totalmem() / (1024 * 1024)),
        freeMb: Math.round(os.freemem() / (1024 * 1024)),
      },
      gpu,
      python,
      models: { transnetv2: transnetModel, qwen: qwen.model },
      network,
      capabilities: {
        boundaryHybrid: this.boundaryHybridState(python, transnetModel.present, ffmpegOk, ffmpegError),
        boundaryOpencv: this.boundaryOpencvState(python),
        labelsLocal: this.labelsLocalState(qwen, gpu),
        labelsCloud: this.labelsCloudState(network.online),
      },
    };
    console.info(
      `[hardware] scanned in ${report.durationMs}ms: hybrid=${report.capabilities.boundaryHybrid.status}` +
        ` opencv=${report.capabilities.boundaryOpencv.status}` +
        ` labelsLocal=${report.capabilities.labelsLocal.status}` +
        ` labelsCloud=${report.capabilities.labelsCloud.status} online=${network.online}`,
    );
    return report;
  }

  private boundaryHybridState(
    python: HardwarePythonInfo,
    modelPresent: boolean,
    ffmpegOk: boolean,
    ffmpegError: string | null,
  ): HardwareCapabilityState {
    if (!python.path || !python.version || !python.packages.numpy || !python.packages.opencv) {
      return runtimeMissing('Python/OpenCV/NumPy 检测运行时不可用，无法执行镜头切分', python.error);
    }
    // onnxruntime 仅对内置运行时可预检；外置 Python 在运行期由 S39 链路自动回退并告警
    if (python.embedded && !python.packages.onnxRuntime) {
      return runtimeMissing('内置 Python 缺少 ONNX Runtime，TransNetV2 模型无法推理', null);
    }
    if (!modelPresent) {
      return {
        status: 'model-missing',
        reason: 'TransNetV2 模型文件缺失，镜头切分会回退 OpenCV 备用',
        fix: '重新安装本软件，或按安装说明补齐 transnetv2.onnx 模型文件',
      };
    }
    if (!ffmpegOk) {
      return {
        status: 'runtime-missing',
        reason: `FFmpeg 不可用，TransNetV2 无法流式读帧${ffmpegError ? `：${ffmpegError}` : ''}`,
        fix: '确认安装目录内 FFmpeg 完整，或重新安装本软件',
      };
    }
    return {
      status: 'ready',
      reason: `TransNetV2 + OpenCV 就绪（${python.embedded ? '内置' : '系统'} Python ${python.version}）`,
      fix: null,
    };
  }

  private boundaryOpencvState(python: HardwarePythonInfo): HardwareCapabilityState {
    if (!python.path || !python.version) {
      return runtimeMissing('Python 运行时不可用，OpenCV 切分无法运行', python.error);
    }
    if (!python.packages.opencv || !python.packages.numpy) {
      return runtimeMissing('OpenCV/NumPy 依赖缺失，离线备用切分不可用', python.error);
    }
    return {
      status: 'ready',
      reason: `OpenCV 备用切分就绪（${python.embedded ? '内置' : '系统'} Python ${python.version}）`,
      fix: null,
    };
  }

  private labelsLocalState(
    qwen: { model: { path: string | null; present: boolean; sizeBytes: number | null }; runtimeMissing: boolean },
    gpu: HardwareGpuInfo,
  ): HardwareCapabilityState {
    if (!qwen.model.present) {
      return qwen.runtimeMissing
        ? runtimeMissing('本地 Qwen3-VL 运行环境缺失（Python 运行时或推理脚本不存在）', null)
        : {
            status: 'model-missing',
            reason: 'Qwen3-VL 模型文件缺失，本地标签识别不可用',
            fix: '按安装说明放置 local-ai 资源包（qwen3vl_8b_w4a8.safetensors），或重新安装',
          };
    }
    if (gpu.source === 'none' || gpu.vramFreeMb === null) {
      return {
        status: 'vram-insufficient',
        reason: '未检测到可查询显存的 NVIDIA GPU，无法确认本地模型可运行',
        fix: '安装 NVIDIA 驱动后重扫；或改用 OpenCV 离线切分',
      };
    }
    if (gpu.vramFreeMb < QWEN_MIN_FREE_VRAM_MB) {
      return {
        status: 'vram-insufficient',
        reason: `空闲显存 ${gpu.vramFreeMb}MB 低于本地模型所需约 ${QWEN_MIN_FREE_VRAM_MB}MB`,
        fix: '关闭占用显存的程序（游戏 / 其他推理任务）后重扫，或改用云端标签识别',
      };
    }
    return {
      status: 'ready',
      reason: `本地 Qwen3-VL 就绪（空闲显存 ${gpu.vramFreeMb}MB）`,
      fix: null,
    };
  }

  private labelsCloudState(online: boolean): HardwareCapabilityState {
    const settings = this.deps.getSettings();
    if (settings?.ai?.enabled === false) {
      return { status: 'disabled', reason: '云端/远程识别已在设置中关闭', fix: null };
    }
    const active = resolveActiveProvider(settings?.ai);
    const baseUrl = active?.baseUrl ?? settings?.ai?.baseUrl ?? '';
    const hasKey = Boolean(active?.apiKey ?? settings?.ai?.apiKey);
    if (!baseUrl.trim() || !hasKey) {
      return {
        status: 'unconfigured',
        reason: '尚未配置云端供应商（需要 API 端点与 API Key）',
        fix: '在设置的 AI 供应商页配置 OpenAI 兼容端点与 Key',
      };
    }
    if (!online) {
      return {
        status: 'offline',
        reason: '设备当前离线，云端标签识别不可用（不会发起任何上传）',
        fix: '恢复网络连接后重扫',
      };
    }
    if (settings?.recognition?.cloudLabelsAck !== true) {
      return {
        status: 'privacy-ack-required',
        reason: '云端标签识别会上传镜头代表帧；需要在设置中确认隐私提示后才能启用',
        fix: '在设置的「标签识别策略」中阅读并确认隐私提示',
      };
    }
    return { status: 'ready', reason: `云端标签识别可用（${active?.name || '已配置供应商'}）`, fix: null };
  }

  private inspectQwen(): {
    model: { path: string | null; present: boolean; sizeBytes: number | null };
    runtimeMissing: boolean;
  } {
    const localVision = this.deps.getLocalVision();
    if (!localVision) {
      return { model: { path: null, present: false, sizeBytes: null }, runtimeMissing: true };
    }
    const status = localVision.getStatus();
    const modelPath = status.modelPath;
    if (status.available && modelPath) {
      const inspected = inspectModelFile(modelPath);
      return { model: inspected, runtimeMissing: false };
    }
    // 模型文件单独缺失 → model-missing；Python/脚本缺失 → runtime-missing
    const modelPresent = modelPath ? filePresent(modelPath) : false;
    const pythonMissing = !status.pythonPath || !filePresent(status.pythonPath);
    return {
      model: {
        path: modelPath,
        present: modelPresent,
        sizeBytes: modelPath && modelPresent ? statSync(modelPath).size : null,
      },
      runtimeMissing: pythonMissing || !modelPresent,
    };
  }

  /** 复用 MediaService 的 nvidia-smi 链路读取显存；不可用时 source=none */
  private async queryGpuViaMediaService(): Promise<HardwareGpuInfo> {
    const media = this.deps.getMedia();
    if (!media) {
      return gpuUnavailable('媒体服务尚未初始化');
    }
    try {
      const status = await media.getGpuStatus();
      if (!status.available || status.memoryTotalMiB === null) {
        return gpuUnavailable(status.updatedAt ? 'nvidia-smi 不可用或未检测到 NVIDIA GPU' : null);
      }
      const used = status.memoryUsedMiB ?? 0;
      return {
        name: null,
        driver: null,
        vramTotalMb: status.memoryTotalMiB,
        vramUsedMb: used,
        vramFreeMb: Math.max(0, status.memoryTotalMiB - used),
        source: 'nvidia-smi',
        error: null,
      };
    } catch (error) {
      return gpuUnavailable(`无法读取 GPU 信息：${(error as Error).message}`);
    }
  }
}

function gpuUnavailable(error: string | null): HardwareGpuInfo {
  return {
    name: null,
    driver: null,
    vramTotalMb: null,
    vramUsedMb: null,
    vramFreeMb: null,
    source: 'none',
    error,
  };
}

function runtimeMissing(reason: string, detail: string | null): HardwareCapabilityState {
  return {
    status: 'runtime-missing',
    reason: detail ? `${reason}（${detail}）` : reason,
    fix: '内置 Python 缺失时重新安装本软件；外置 Python 时安装 3.12+ 并 pip 安装依赖',
  };
}

function filePresent(path: string): boolean {
  try {
    return statSync(path).isFile() && statSync(path).size > 0;
  } catch {
    return false;
  }
}

function inspectModelFile(path: string): { path: string; present: boolean; sizeBytes: number | null } {
  try {
    const stat = statSync(path);
    return { path, present: stat.isFile() && stat.size > 0, sizeBytes: stat.size };
  } catch {
    return { path, present: false, sizeBytes: null };
  }
}

/** 复用 DetectService 的环境探测（版本 + cv2/numpy）；onnxruntime 对内置运行时做文件系统校验 */
function probePythonInfo(): HardwarePythonInfo {
  const check = probePythonEnvironment(resolvePythonExecutable());
  const pythonPath = check.pythonPath;
  const embedded =
    pythonPath !== null &&
    embeddedPythonExecutable() !== null &&
    pythonPath === embeddedPythonExecutable();
  return {
    path: pythonPath,
    version: check.pythonVersion,
    embedded,
    packages: {
      opencv: check.ok,
      numpy: check.ok,
      onnxRuntime: pythonPath !== null && embedded ? embeddedOnnxRuntimePresent(pythonPath) : false,
    },
    error: check.error ? `${check.error.message}。${check.error.guide}` : null,
  };
}

/** 内置 Python 的 onnxruntime 目录校验（Lib/site-packages/onnxruntime） */
function embeddedOnnxRuntimePresent(pythonPath: string): boolean {
  try {
    return filePresent(join(dirname(pythonPath), 'Lib', 'site-packages', 'onnxruntime', '__init__.py'));
  } catch {
    return false;
  }
}

/** 供 smoke 门控快捷断言使用：四条能力线 + 网络的状态摘要 */
export function summarizeCapabilityStatuses(
  report: HardwareCapabilityReport,
): Record<string, string> {
  return {
    boundaryHybrid: report.capabilities.boundaryHybrid.status,
    boundaryOpencv: report.capabilities.boundaryOpencv.status,
    labelsLocal: report.capabilities.labelsLocal.status,
    labelsCloud: report.capabilities.labelsCloud.status,
    network: report.network.online ? 'ready' : 'offline',
  };
}
