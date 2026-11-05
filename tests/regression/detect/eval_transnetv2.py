from __future__ import annotations

import argparse
import ctypes
import hashlib
import json
import os
import subprocess
import sys
import tempfile
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import cv2
import numpy as np


REPO_ROOT = Path(__file__).resolve().parents[3]
PYTHON_DIR = REPO_ROOT / "src" / "main" / "detect" / "python"
for path in (str(PYTHON_DIR), str(REPO_ROOT)):
    if path not in sys.path:
        sys.path.insert(0, path)

from boundary_fusion import fuse_boundaries  # noqa: E402
from difference import difference_curve  # noqa: E402
from features import extract_features  # noqa: E402
from params import normalize_params  # noqa: E402
from peaks import detect_cut_frames  # noqa: E402
from transnetv2_runtime import detect_video  # noqa: E402

from tests.regression.detect.synthetic_scenes import (  # noqa: E402
    HEIGHT,
    WIDTH,
    _pan_background,
    _scene_frame,
)


FPS = 25
INTERVAL_MS = 500
MIN_SHOT_MS = 500
OPENCV_OPTIONS = {
    "sensitivity": 0.62,
    "minShotSeconds": MIN_SHOT_MS / 1000.0,
    "filterTransitions": True,
    "weights": {"s": 0.3, "c": 0.3, "h": 0.4},
}


@dataclass(frozen=True)
class BenchmarkCase:
    name: str
    category: str
    video_path: Path
    ground_truth_cuts_ms: list[float]
    tolerance_ms: float
    source: str
    notes: str


@dataclass(frozen=True)
class EngineResult:
    name: str
    cuts_ms: list[float]
    elapsed_ms: float
    details: dict[str, Any]


def _safe_ratio(numerator: float, denominator: float, empty_value: float = 1.0) -> float:
    return numerator / denominator if denominator > 0 else empty_value


def match_cuts(
    ground_truth: list[float],
    detected: list[float],
    tolerance_ms: float,
) -> tuple[int, int, int, list[float]]:
    used: set[int] = set()
    errors: list[float] = []
    for truth in sorted(ground_truth):
        candidates = [
            (abs(value - truth), index)
            for index, value in enumerate(detected)
            if index not in used and abs(value - truth) <= tolerance_ms
        ]
        if not candidates:
            continue
        error, index = min(candidates)
        used.add(index)
        errors.append(error)
    tp = len(errors)
    return tp, max(0, len(detected) - tp), max(0, len(ground_truth) - tp), errors


def metrics(
    ground_truth: list[float],
    detected: list[float],
    tolerance_ms: float,
) -> dict[str, Any]:
    tp, fp, fn, errors = match_cuts(ground_truth, detected, tolerance_ms)
    precision = _safe_ratio(tp, tp + fp)
    recall = _safe_ratio(tp, tp + fn)
    f1 = _safe_ratio(2 * precision * recall, precision + recall, 0.0) if precision + recall else 0.0
    return {
        "tp": tp,
        "fp": fp,
        "fn": fn,
        "precision": round(precision, 4),
        "recall": round(recall, 4),
        "f1": round(f1, 4),
        "meanErrorMs": round(float(np.mean(errors)), 2) if errors else None,
        "maxErrorMs": round(float(np.max(errors)), 2) if errors else None,
    }


def process_peak_memory_mb() -> float | None:
    if os.name == "nt":
        class ProcessMemoryCounters(ctypes.Structure):
            _fields_ = [
                ("cb", ctypes.c_ulong),
                ("PageFaultCount", ctypes.c_ulong),
                ("PeakWorkingSetSize", ctypes.c_size_t),
                ("WorkingSetSize", ctypes.c_size_t),
                ("QuotaPeakPagedPoolUsage", ctypes.c_size_t),
                ("QuotaPagedPoolUsage", ctypes.c_size_t),
                ("QuotaPeakNonPagedPoolUsage", ctypes.c_size_t),
                ("QuotaNonPagedPoolUsage", ctypes.c_size_t),
                ("PagefileUsage", ctypes.c_size_t),
                ("PeakPagefileUsage", ctypes.c_size_t),
            ]

        counters = ProcessMemoryCounters()
        counters.cb = ctypes.sizeof(ProcessMemoryCounters)
        kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
        psapi = ctypes.WinDLL("psapi", use_last_error=True)
        kernel32.GetCurrentProcess.restype = ctypes.c_void_p
        psapi.GetProcessMemoryInfo.argtypes = [
            ctypes.c_void_p,
            ctypes.POINTER(ProcessMemoryCounters),
            ctypes.c_ulong,
        ]
        if psapi.GetProcessMemoryInfo(
            kernel32.GetCurrentProcess(),
            ctypes.byref(counters),
            counters.cb,
        ):
            return round(counters.PeakWorkingSetSize / (1024 * 1024), 2)
        return None
    try:
        import resource

        return round(resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1024, 2)
    except (ImportError, AttributeError):
        return None


def probe_duration_ms(video_path: Path, ffmpeg_path: Path) -> int:
    ffprobe = ffmpeg_path.with_name("ffprobe.exe" if os.name == "nt" else "ffprobe")
    process = subprocess.run(
        [
            str(ffprobe),
            "-v",
            "error",
            "-show_entries",
            "format=duration",
            "-of",
            "default=noprint_wrappers=1:nokey=1",
            str(video_path),
        ],
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=30,
    )
    if process.returncode != 0:
        raise RuntimeError(f"ffprobe 失败：{process.stderr.strip()}")
    return max(1, round(float(process.stdout.strip()) * 1000))


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        while True:
            chunk = handle.read(1024 * 1024)
            if not chunk:
                break
            digest.update(chunk)
    return digest.hexdigest().upper()


def write_video(path: Path, frames: list[np.ndarray], fps: int = FPS) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    writer = cv2.VideoWriter(str(path), cv2.VideoWriter_fourcc(*"mp4v"), fps, (WIDTH, HEIGHT))
    if not writer.isOpened():
        raise RuntimeError(f"无法创建视频：{path}")
    try:
        for frame in frames:
            if frame.shape[:2] != (HEIGHT, WIDTH):
                frame = cv2.resize(frame, (WIDTH, HEIGHT), interpolation=cv2.INTER_AREA)
            writer.write(frame)
    finally:
        writer.release()


def build_synthetic_cases(root: Path) -> list[BenchmarkCase]:
    root.mkdir(parents=True, exist_ok=True)

    hardcut_frames: list[np.ndarray] = []
    hardcut_truth: list[float] = []
    for index, seed in enumerate((1101, 1117, 1129, 1151, 1163, 1181)):
        if hardcut_frames:
            hardcut_truth.append(len(hardcut_frames) / FPS * 1000)
        hardcut_frames.extend(_scene_frame(seed, phase, chr(65 + index)) for phase in range(50))
    hardcut_path = root / "synthetic-hardcut-6seg.mp4"
    write_video(hardcut_path, hardcut_frames)

    fade_frames = [_scene_frame(1201, phase, "A") for phase in range(75)]
    for blend_index in range(25):
        alpha = (blend_index + 1) / 26
        left = _scene_frame(1201, 75 + blend_index, "A").astype(np.float32)
        right = _scene_frame(1213, blend_index, "B").astype(np.float32)
        fade_frames.append(np.clip(left * (1.0 - alpha) + right * alpha, 0, 255).astype(np.uint8))
    fade_frames.extend(_scene_frame(1213, 25 + phase, "B") for phase in range(75))
    fade_path = root / "synthetic-crossfade-1s.mp4"
    write_video(fade_path, fade_frames)

    flash_frames = [_scene_frame(1229, phase, "FLASH") for phase in range(150)]
    flash_frames[75] = np.full((HEIGHT, WIDTH, 3), 255, dtype=np.uint8)
    flash_path = root / "synthetic-flash-no-cut.mp4"
    write_video(flash_path, flash_frames)

    pan_background = _pan_background(1237)
    pan_path = root / "synthetic-pan-no-cut.mp4"
    write_video(
        pan_path,
        [
            pan_background[:, offset : offset + WIDTH].copy()
            for offset in range(0, 261, 2)
        ],
    )

    return [
        BenchmarkCase(
            "synthetic-hardcut-6seg",
            "hardcut",
            hardcut_path,
            hardcut_truth,
            80,
            "generated",
            "6 个 2 秒场景，5 个硬切",
        ),
        BenchmarkCase(
            "synthetic-crossfade-1s",
            "crossfade",
            fade_path,
            [(75 + 12) * 1000 / FPS],
            500,
            "generated",
            "1 秒线性交叉叠化，真值取过渡中点",
        ),
        BenchmarkCase(
            "synthetic-flash-no-cut",
            "flash",
            flash_path,
            [],
            80,
            "generated",
            "同一场景第 76 帧插入单帧全白，不应生成切点",
        ),
        BenchmarkCase(
            "synthetic-pan-no-cut",
            "pan",
            pan_path,
            [],
            80,
            "generated",
            "连续横移，不应生成切点",
        ),
    ]


def run_opencv(
    video_path: Path,
    duration_ms: int,
    ffmpeg_path: Path,
    interval_ms: int = INTERVAL_MS,
) -> EngineResult:
    started = time.perf_counter()
    with tempfile.TemporaryDirectory(prefix="s39-opencv-") as temp_dir:
        frame_dir = Path(temp_dir)
        process = subprocess.run(
            [
                str(ffmpeg_path),
                "-hide_banner",
                "-loglevel",
                "error",
                "-i",
                str(video_path),
                "-vf",
                f"fps={1000 / interval_ms:g},scale=320:-2",
                "-q:v",
                "3",
                str(frame_dir / "frame-%05d.jpg"),
            ],
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=300,
        )
        if process.returncode != 0:
            raise RuntimeError(f"OpenCV 抽帧失败：{process.stderr.strip()}")
        frame_paths = [str(path) for path in sorted(frame_dir.glob("frame-*.jpg"))]
        if not frame_paths:
            return EngineResult("opencv", [], (time.perf_counter() - started) * 1000, {
                "error": "no frames",
                "frameCount": 0,
            })
        params = normalize_params(OPENCV_OPTIONS, interval_ms)
        features = extract_features(frame_paths)
        differences = difference_curve(features, params)
        cut_frames = detect_cut_frames(differences, features, params)
        cuts = [float(frame * interval_ms) for frame in cut_frames]
    return EngineResult(
        "opencv",
        cuts,
        (time.perf_counter() - started) * 1000,
        {"frameCount": len(frame_paths), "intervalMs": interval_ms, "durationMs": duration_ms},
    )


def run_transnetv2(
    video_path: Path,
    duration_ms: int,
    ffmpeg_path: Path,
    model_path: Path,
) -> EngineResult:
    started = time.perf_counter()
    result = detect_video(
        str(video_path),
        str(ffmpeg_path),
        str(model_path),
        duration_ms=duration_ms,
    )
    fps = float(result["fps"])
    raw_cuts = [
        scene[0] * 1000.0 / fps
        for scene in result["scenes"][1:]
    ]
    fused = fuse_boundaries(raw_cuts, [], duration_ms, min_shot_ms=MIN_SHOT_MS)
    elapsed = (time.perf_counter() - started) * 1000
    return EngineResult(
        "transnetv2",
        [float(cut) for cut in fused["cuts"]],
        elapsed,
        {
            "frameCount": result["framesTotal"],
            "fps": fps,
            "provider": result["provider"],
            "modelSha256": result["modelSha256"],
            "rawCutCount": len(raw_cuts),
            "rawCutsMs": [round(cut, 2) for cut in raw_cuts],
            "filteredCutCount": len(fused["cuts"]),
        },
    )


def hybrid_result(
    opencv: EngineResult,
    model: EngineResult,
    duration_ms: int,
) -> EngineResult:
    started = time.perf_counter()
    fused = fuse_boundaries(
        [float(cut) for cut in model.details.get("rawCutsMs", model.cuts_ms)],
        opencv.cuts_ms,
        duration_ms,
        min_shot_ms=MIN_SHOT_MS,
        merge_tolerance_ms=max(250.0, INTERVAL_MS / 2),
    )
    fusion_ms = (time.perf_counter() - started) * 1000
    return EngineResult(
        "hybrid",
        [float(cut) for cut in fused["cuts"]],
        opencv.elapsed_ms + model.elapsed_ms + fusion_ms,
        {
            "opencvElapsedMs": round(opencv.elapsed_ms, 2),
            "modelElapsedMs": round(model.elapsed_ms, 2),
            "fusionElapsedMs": round(fusion_ms, 3),
            "diagnostics": fused["diagnostics"],
        },
    )


def evaluate_case(
    case: BenchmarkCase,
    ffmpeg_path: Path,
    model_path: Path,
) -> dict[str, Any]:
    duration_ms = probe_duration_ms(case.video_path, ffmpeg_path)
    started = time.perf_counter()
    opencv = run_opencv(case.video_path, duration_ms, ffmpeg_path)
    model = run_transnetv2(case.video_path, duration_ms, ffmpeg_path, model_path)
    hybrid = hybrid_result(opencv, model, duration_ms)
    total_ms = (time.perf_counter() - started) * 1000
    engines = {
        result.name: {
            "cutsMs": [round(cut, 2) for cut in result.cuts_ms],
            "elapsedMs": round(result.elapsed_ms, 2),
            "metrics": metrics(case.ground_truth_cuts_ms, result.cuts_ms, case.tolerance_ms),
            "details": result.details,
        }
        for result in (opencv, model, hybrid)
    }
    return {
        "name": case.name,
        "category": case.category,
        "videoPath": str(case.video_path),
        "videoSha256": sha256_file(case.video_path),
        "source": case.source,
        "notes": case.notes,
        "durationMs": duration_ms,
        "groundTruthCutsMs": case.ground_truth_cuts_ms,
        "toleranceMs": case.tolerance_ms,
        "totalElapsedMs": round(total_ms, 2),
        "engines": engines,
    }


def summarize(cases: list[dict[str, Any]]) -> dict[str, Any]:
    summary: dict[str, Any] = {}
    for engine in ("opencv", "transnetv2", "hybrid"):
        tp = sum(case["engines"][engine]["metrics"]["tp"] for case in cases)
        fp = sum(case["engines"][engine]["metrics"]["fp"] for case in cases)
        fn = sum(case["engines"][engine]["metrics"]["fn"] for case in cases)
        precision = _safe_ratio(tp, tp + fp)
        recall = _safe_ratio(tp, tp + fn)
        f1 = _safe_ratio(2 * precision * recall, precision + recall, 0.0) if precision + recall else 0.0
        summary[engine] = {
            "tp": tp,
            "fp": fp,
            "fn": fn,
            "precision": round(precision, 4),
            "recall": round(recall, 4),
            "f1": round(f1, 4),
            "totalElapsedMs": round(
                sum(case["engines"][engine]["elapsedMs"] for case in cases),
                2,
            ),
        }
    return summary


def build_conclusion(summary: dict[str, Any], cases: list[dict[str, Any]]) -> str:
    ordered = "；".join(
        f"{engine} precision={summary[engine]['precision']:.3f}、"
        f"recall={summary[engine]['recall']:.3f}、F1={summary[engine]['f1']:.3f}"
        for engine in ("opencv", "transnetv2", "hybrid")
    )
    lines = [f"全部用例汇总：{ordered}。"]
    real_cases = [case for case in cases if case["category"].startswith("real")]
    for case in real_cases:
        real = []
        for engine in ("opencv", "transnetv2", "hybrid"):
            metrics_row = case["engines"][engine]["metrics"]
            real.append(
                f"{engine} {metrics_row['tp']}/{metrics_row['fp']}/{metrics_row['fn']}"
                f"（F1={metrics_row['f1']:.3f}）"
            )
        lines.append(
            f"真实样片 `{case['name']}`：真值 {len(case['groundTruthCutsMs'])} 个，"
            + "；".join(real)
            + "。"
        )
    lines.append("真实素材结论仅适用于本次人工标注样片，不代表所有影视、动画或直播素材。")
    return "\n\n".join(lines)


def render_markdown(payload: dict[str, Any]) -> str:
    lines = [
        "# S39-7 TransNetV2 模型输出与真实视频验证",
        "",
        f"> 生成时间：{payload['generatedAt']}",
        f"> 模型：TransNetV2 ONNX，SHA-256 `{payload['modelSha256']}`",
        f"> OpenCV 参数：`intervalMs={INTERVAL_MS}`，`minShotMs={MIN_SHOT_MS}`；TransNetV2 固定 25fps。",
        f"> 进程峰值工作集：`{payload['processPeakMemoryMb']}` MB。",
        "",
        "## 评测口径",
        "",
        "- 硬切合成片和真实片使用 `80～250ms` 的逐用例容差；1 秒渐变使用 `500ms` 容差。",
        "- 每个真值只与一个最近检出匹配，未匹配检出计 FP，未匹配真值计 FN。",
        "- 真实片的淡入/淡出按过渡中点作为切点；片尾字幕不计入镜头学习样本。",
        "- TransNetV2 的原始切点先应用生产最短镜头规则，再参与指标计算。",
        "",
        "## 总体指标",
        "",
        "| 引擎 | TP | FP | FN | Precision | Recall | F1 | 累计耗时 ms |",
        "|---|---:|---:|---:|---:|---:|---:|---:|",
    ]
    for engine in ("opencv", "transnetv2", "hybrid"):
        row = payload["summary"][engine]
        lines.append(
            f"| {engine} | {row['tp']} | {row['fp']} | {row['fn']} | "
            f"{row['precision']:.3f} | {row['recall']:.3f} | {row['f1']:.3f} | "
            f"{row['totalElapsedMs']:.1f} |"
        )

    lines.extend(
        [
            "",
            "## 逐用例结果",
            "",
            "| 用例 | 类型 | 真值数 | OpenCV TP/FP/FN | TransNetV2 TP/FP/FN | Hybrid TP/FP/FN |",
            "|---|---|---:|---|---|---|",
        ]
    )
    for case in payload["cases"]:
        cells = []
        for engine in ("opencv", "transnetv2", "hybrid"):
            m = case["engines"][engine]["metrics"]
            cells.append(f"{m['tp']}/{m['fp']}/{m['fn']}")
        lines.append(
            f"| {case['name']} | {case['category']} | {len(case['groundTruthCutsMs'])} | "
            f"{cells[0]} | {cells[1]} | {cells[2]} |"
        )

    lines.extend(["", "## 切点明细", ""])
    for case in payload["cases"]:
        lines.extend(
            [
                f"### {case['name']}",
                "",
                f"- 来源：{case['source']}",
                f"- 说明：{case['notes']}",
                f"- 真值：`{case['groundTruthCutsMs']}` ms，容差 `{case['toleranceMs']}` ms",
            ]
        )
        for engine in ("opencv", "transnetv2", "hybrid"):
            result = case["engines"][engine]
            m = result["metrics"]
            realtime_ratio = result["elapsedMs"] / max(1, case["durationMs"])
            lines.append(
                f"- {engine}：cut={result['cutsMs']}，P/R/F1="
                f"{m['precision']:.3f}/{m['recall']:.3f}/{m['f1']:.3f}，"
                f"meanErr={m['meanErrorMs']} ms，耗时={result['elapsedMs']:.1f} ms，"
                f"耗时/片长={realtime_ratio:.3f}"
            )
        model_details = case["engines"]["transnetv2"]["details"]
        lines.append(
            f"- TransNetV2 输出：{model_details.get('frameCount')} 帧，"
            f"provider=`{model_details.get('provider')}`，"
            f"raw/filtered cuts={model_details.get('rawCutCount')}/{model_details.get('filteredCutCount')}"
        )
        lines.append("")

    lines.extend(
        [
            "## 结论",
            "",
            payload["conclusion"],
            "",
            "> 真实素材只代表本次公开样片，不代表所有影视、动画、直播或屏幕录制。",
            "",
            "## 限制",
            "",
            "- 人工真值由公开样片的逐帧接触表确定，存在人工判断误差。",
            "- OpenCV 指标使用产品当前 500ms 抽帧配置，因此其边界时间天然受采样量化影响。",
            "- 本报告只验证公开样片与合成场景，不构成通用片库准确率承诺。",
        ]
    )
    return "\n".join(lines) + "\n"


def parse_real_truth(raw: str) -> list[float]:
    if not raw.strip():
        return []
    return [float(value.strip()) for value in raw.split(",") if value.strip()]


def main() -> int:
    parser = argparse.ArgumentParser(description="S39-7 TransNetV2 / OpenCV / hybrid 回归")
    parser.add_argument("--output-dir", required=True)
    parser.add_argument("--ffmpeg", default=str(REPO_ROOT / "resources" / "ffmpeg" / "ffmpeg.exe"))
    parser.add_argument("--model", default=str(REPO_ROOT / "resources" / "transnetv2" / "models" / "transnetv2.onnx"))
    parser.add_argument("--real-video")
    parser.add_argument("--real-name", default="real-sample")
    parser.add_argument("--real-category", default="real")
    parser.add_argument("--real-truth-ms", default="")
    parser.add_argument("--real-tolerance-ms", type=float, default=100.0)
    parser.add_argument("--real-source", default="")
    parser.add_argument("--real-notes", default="")
    parser.add_argument("--conclusion", default="")
    parser.add_argument("--skip-synthetic", action="store_true")
    args = parser.parse_args()

    output_dir = Path(args.output_dir).resolve()
    output_dir.mkdir(parents=True, exist_ok=True)
    ffmpeg_path = Path(args.ffmpeg).resolve()
    model_path = Path(args.model).resolve()
    if not ffmpeg_path.is_file():
        raise FileNotFoundError(ffmpeg_path)
    if not model_path.is_file():
        raise FileNotFoundError(model_path)

    cases = [] if args.skip_synthetic else build_synthetic_cases(output_dir / "media")
    if args.real_video:
        real_video = Path(args.real_video).resolve()
        if not real_video.is_file():
            raise FileNotFoundError(real_video)
        cases.append(
            BenchmarkCase(
                args.real_name,
                args.real_category,
                real_video,
                parse_real_truth(args.real_truth_ms),
                args.real_tolerance_ms,
                args.real_source,
                args.real_notes,
            )
        )
    if not cases:
        raise ValueError("没有可评测素材")

    results = [evaluate_case(case, ffmpeg_path, model_path) for case in cases]
    model_sha = sha256_file(model_path)
    summary = summarize(results)
    payload = {
        "generatedAt": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
        "model": "TransNetV2",
        "modelPath": str(model_path),
        "modelSha256": model_sha,
        "processPeakMemoryMb": process_peak_memory_mb(),
        "configuration": {
            "opencvIntervalMs": INTERVAL_MS,
            "minShotMs": MIN_SHOT_MS,
            "transnetFps": FPS,
        },
        "summary": summary,
        "cases": results,
        "conclusion": args.conclusion or build_conclusion(summary, results),
    }
    json_path = output_dir / "benchmark.json"
    markdown_path = output_dir / "benchmark.md"
    json_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    markdown_path.write_text(render_markdown(payload), encoding="utf-8")
    print(json.dumps({
        "ok": True,
        "json": str(json_path),
        "markdown": str(markdown_path),
        "summary": summary,
    }, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
