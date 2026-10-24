from __future__ import annotations

import sys
import tempfile
import unittest
from collections import defaultdict
from dataclasses import dataclass
from pathlib import Path

import cv2


REPO_ROOT = Path(__file__).resolve().parents[3]
PYTHON_DIR = REPO_ROOT / "src" / "main" / "detect" / "python"
REPORT_PATH = REPO_ROOT / "docs" / "D1-回归-检测精度报告.md"
sys.path.insert(0, str(PYTHON_DIR))
sys.path.insert(0, str(REPO_ROOT))

from difference import difference_curve  # noqa: E402
from features import extract_features  # noqa: E402
from params import normalize_params  # noqa: E402
from peaks import detect_cut_frames  # noqa: E402

from tests.regression.detect.synthetic_scenes import RegressionCase, all_cases  # noqa: E402


TOLERANCE_FRAMES = 2
INTERVAL_MS = 200
OPTIONS = {
    "sensitivity": 0.62,
    "minShotSeconds": 0.5,
    "filterTransitions": False,
    "weights": {"s": 0.15, "c": 0.15, "h": 0.25, "hv": 0.2, "edge": 0.1, "grid": 0.15},
}


@dataclass(frozen=True)
class CaseMetrics:
    case: RegressionCase
    detected: list[int]
    tp: int
    fp: int
    fn: int
    precision: float
    recall: float
    f1: float


def match_detections(ground_truth: list[int], detected: list[int]) -> tuple[int, int, int]:
    used_detections: set[int] = set()
    true_positives = 0
    for truth in sorted(ground_truth):
        candidates = [
            (abs(value - truth), index)
            for index, value in enumerate(detected)
            if index not in used_detections and abs(value - truth) <= TOLERANCE_FRAMES
        ]
        if not candidates:
            continue
        _, matched_index = min(candidates)
        used_detections.add(matched_index)
        true_positives += 1
    false_positives = max(0, len(detected) - true_positives)
    false_negatives = max(0, len(ground_truth) - true_positives)
    return true_positives, false_positives, false_negatives


def safe_ratio(numerator: int, denominator: int, empty_value: float = 1.0) -> float:
    return numerator / denominator if denominator > 0 else empty_value


def make_metrics(case: RegressionCase, detected: list[int]) -> CaseMetrics:
    tp, fp, fn = match_detections(case.ground_truth, detected)
    precision = safe_ratio(tp, tp + fp)
    recall = safe_ratio(tp, tp + fn)
    f1 = safe_ratio(2 * precision * recall, precision + recall, 0.0)
    return CaseMetrics(case, detected, tp, fp, fn, precision, recall, f1)


def evaluate_rows() -> list[CaseMetrics]:
    params = normalize_params(OPTIONS, INTERVAL_MS)
    rows: list[CaseMetrics] = []
    with tempfile.TemporaryDirectory(prefix="d1-regression-") as temp_dir:
        root = Path(temp_dir)
        for case in all_cases():
            case_dir = root / case.name
            case_dir.mkdir(parents=True, exist_ok=True)
            paths = []
            for index, frame in enumerate(case.frames):
                frame_path = case_dir / f"frame-{index:04d}.png"
                if not cv2.imwrite(str(frame_path), frame):
                    raise RuntimeError(f"无法写入回归帧：{frame_path}")
                paths.append(str(frame_path))
            features = extract_features(paths)
            differences = difference_curve(features, params)
            detected = detect_cut_frames(differences, features, params)
            rows.append(make_metrics(case, detected))
    return rows


def format_metric(value: float) -> str:
    return f"{value:.3f}"


def build_report(rows: list[CaseMetrics]) -> str:
    lines = [
        "# D1 回归：5 类素材检测精度报告",
        "",
        "> 本报告由 `python -m unittest tests.regression.detect.eval_detect -v` 生成。",
        "> 评测直接复用生产 Python 检测模块，不启动 Electron、不写视频文件。",
        "",
        "## 评测口径",
        "",
        f"- 合成帧尺寸：320×180；帧序列长度 40～120。",
        f"- 采样参数：`intervalMs={INTERVAL_MS}`，`sensitivity={OPTIONS['sensitivity']}`，"
        f"`minShotSeconds={OPTIONS['minShotSeconds']}`，`filterTransitions=False`。",
        f"- 容差：检出帧与真值帧距离 ≤ {TOLERANCE_FRAMES} 帧视为命中，按距离从小到大贪心一一配对。",
        "- 标准指标定义：TP=命中的真值；FP=未匹配的检出；FN=未命中的真值。",
        "- precision=TP/(TP+FP)，recall=TP/(TP+FN)，F1=2PR/(P+R)。",
        "- 当分母为 0 时按 1.0 记（表示该用例没有需要检出的事件且没有误报）；P+R=0 时 F1 记 0。",
        "- flash 类真值为异常闪帧位置；本次按要求关闭转场过滤，评测的是事件候选检出能力，不代表生产模式会将这些闪帧输出为切点。",
        "- fade 类真值取渐变区间中点。",
        "",
        "## 逐用例结果",
        "",
        "| 用例 | 类型 | 说明 | 真值 | 检出 | TP | FP | FN | Precision | Recall | F1 |",
        "|---|---|---|---|---|---:|---:|---:|---:|---:|---:|",
    ]
    for row in rows:
        lines.append(
            "| {name} | {category} | {description} | {truth} | {detected} | {tp} | {fp} | {fn} | "
            "{precision} | {recall} | {f1} |".format(
                name=row.case.name,
                category=row.case.category,
                description=row.case.description,
                truth=row.case.ground_truth,
                detected=row.detected,
                tp=row.tp,
                fp=row.fp,
                fn=row.fn,
                precision=format_metric(row.precision),
                recall=format_metric(row.recall),
                f1=format_metric(row.f1),
            )
        )

    grouped: dict[str, list[CaseMetrics]] = defaultdict(list)
    for row in rows:
        grouped[row.case.category].append(row)

    lines.extend(
        [
            "",
            "## 分类汇总",
            "",
            "| 类型 | 用例数 | TP | FP | FN | Precision | Recall | F1 |",
            "|---|---:|---:|---:|---:|---:|---:|---:|",
        ]
    )
    for category in ("hardcut", "fade", "flash", "pan", "occlusion"):
        category_rows = grouped[category]
        tp = sum(row.tp for row in category_rows)
        fp = sum(row.fp for row in category_rows)
        fn = sum(row.fn for row in category_rows)
        precision = safe_ratio(tp, tp + fp)
        recall = safe_ratio(tp, tp + fn)
        f1 = safe_ratio(2 * precision * recall, precision + recall, 0.0)
        lines.append(
            f"| {category} | {len(category_rows)} | {tp} | {fp} | {fn} | "
            f"{format_metric(precision)} | {format_metric(recall)} | {format_metric(f1)} |"
        )

    tp = sum(row.tp for row in rows)
    fp = sum(row.fp for row in rows)
    fn = sum(row.fn for row in rows)
    precision = safe_ratio(tp, tp + fp)
    recall = safe_ratio(tp, tp + fn)
    f1 = safe_ratio(2 * precision * recall, precision + recall, 0.0)
    lines.extend(
        [
            "",
            "## 总体指标",
            "",
            f"- 样本数：{len(rows)}",
            f"- TP / FP / FN：{tp} / {fp} / {fn}",
            f"- Precision：{format_metric(precision)}",
            f"- Recall：{format_metric(recall)}",
            f"- F1：{format_metric(f1)}",
            "",
            "## 结论",
            "",
            "- 本任务只建立回归评测基建并如实记录当前算法表现，未修改任何检测算法。",
            "- 低 precision 或 recall 的类别应按用例明细排查对应特征、阈值或后处理环节，不能通过调整真值来修饰结果。",
            "- 摇镜与遮挡无切点用例用于观察误报；硬切、渐变、闪白用例用于观察漏检。",
        ]
    )
    return "\n".join(lines) + "\n"


def run_evaluation() -> tuple[list[CaseMetrics], str]:
    rows = evaluate_rows()
    report = build_report(rows)
    REPORT_PATH.parent.mkdir(parents=True, exist_ok=True)
    REPORT_PATH.write_text(report, encoding="utf-8")
    return rows, report


class DetectionRegressionTests(unittest.TestCase):
    def test_regression_metrics_report(self) -> None:
        rows, report = run_evaluation()
        self.assertGreaterEqual(len(rows), 15)
        self.assertEqual(len({row.case.category for row in rows}), 5)
        self.assertIn("## 分类汇总", report)
        self.assertIn("## 总体指标", report)
        self.assertTrue(REPORT_PATH.exists())
        print(report)


if __name__ == "__main__":
    unittest.main(verbosity=2)
