from __future__ import annotations

import sys
import unittest
from pathlib import Path

PYTHON_DIR = Path(__file__).resolve().parents[3] / "src" / "main" / "detect" / "python"
sys.path.insert(0, str(PYTHON_DIR))

from boundary_fusion import BoundaryFusionError, fuse_boundaries  # noqa: E402


def shots(result):
    return result["shots"]


def diag(result):
    return result["diagnostics"]


class FuseBoundariesTests(unittest.TestCase):
    def test_same_position_keeps_model_only(self):
        result = fuse_boundaries([5000.0], [5010.0], 20_000.0, min_shot_ms=1000.0, merge_tolerance_ms=250.0)
        self.assertEqual(shots(result), [[0, 5000], [5000, 20000]])
        self.assertEqual(diag(result)["mergedCutCount"], 1)
        self.assertEqual(diag(result)["opencvSupplementCount"], 0)
        self.assertEqual(diag(result)["discardedCount"], 1)
        self.assertFalse(diag(result)["fallbackUsed"])

    def test_far_opencv_cut_is_supplement(self):
        result = fuse_boundaries([5000.0], [12000.0], 20_000.0, min_shot_ms=1000.0, merge_tolerance_ms=250.0)
        self.assertEqual(shots(result), [[0, 5000], [5000, 12000], [12000, 20000]])
        self.assertEqual(diag(result)["modelOnlyCount"], 1)
        self.assertEqual(diag(result)["opencvSupplementCount"], 1)
        self.assertEqual(diag(result)["mode"], "hybrid")

    def test_min_shot_filters_short_segments(self):
        result = fuse_boundaries([1000.0, 5000.0, 19_500.0], [], 20_000.0, min_shot_ms=2000.0)
        # 1000 距片头 1000 < 2000，19500 距片尾 500 < 2000，均被过滤
        self.assertEqual(shots(result), [[0, 5000], [5000, 20000]])
        self.assertEqual(diag(result)["mergedCutCount"], 1)

    def test_model_empty_falls_back_to_opencv(self):
        result = fuse_boundaries([], [4000.0, 9000.0], 20_000.0, min_shot_ms=1000.0)
        self.assertEqual(shots(result), [[0, 4000], [4000, 9000], [9000, 20000]])
        self.assertTrue(diag(result)["fallbackUsed"])
        self.assertEqual(diag(result)["mode"], "opencv-fallback")
        self.assertEqual(diag(result)["modelCutCount"], 0)
        self.assertEqual(diag(result)["mergedCutCount"], 2)

    def test_full_coverage_head_tail(self):
        result = fuse_boundaries([10_000.0], [], 20_000.0, min_shot_ms=1000.0)
        all_shots = shots(result)
        self.assertEqual(all_shots[0][0], 0)
        self.assertEqual(all_shots[-1][1], 20_000)
        for previous, current in zip(all_shots, all_shots[1:]):
            self.assertEqual(previous[1], current[0])
            self.assertLess(previous[0], previous[1])

    def test_near_cluster_keeps_strongest_deterministically(self):
        # 三个近邻补充切点超过上限（ratio 0.5 * 1 模型切点 = 0），全部截断
        result = fuse_boundaries(
            [10_000.0],
            [10_010.0, 10_020.0, 10_030.0],
            20_000.0,
            min_shot_ms=0.0,
            merge_tolerance_ms=250.0,
            max_supplementary_ratio=0.5,
        )
        self.assertEqual(diag(result)["opencvSupplementCount"], 0)
        self.assertEqual(diag(result)["discardedCount"], 3)
        self.assertEqual(shots(result), [[0, 10_000], [10_000, 20_000]])

    def test_supplement_cap_keeps_farthest_first(self):
        # cap = 0.5 * 2 = 1；三个候选保留距模型切点最远者
        result = fuse_boundaries(
            [5000.0, 15_000.0],
            [5100.0, 9800.0, 9900.0],
            20_000.0,
            min_shot_ms=1000.0,
            merge_tolerance_ms=250.0,
            max_supplementary_ratio=0.5,
        )
        self.assertEqual(diag(result)["opencvSupplementCount"], 1)
        kept_cuts = result["cuts"]
        # 9800 距最近模型切点 4800，9900 距 4900；保留更远者
        self.assertIn(9900.0, kept_cuts)
        self.assertNotIn(9800.0, kept_cuts)

    def test_zero_duration_rejected(self):
        with self.assertRaises(BoundaryFusionError):
            fuse_boundaries([1000.0], [], 0.0)
        with self.assertRaises(BoundaryFusionError):
            fuse_boundaries([], [], -5.0)

    def test_no_cuts_single_full_shot(self):
        result = fuse_boundaries([], [], 20_000.0)
        self.assertEqual(shots(result), [[0, 20_000]])
        self.assertEqual(diag(result)["mergedCutCount"], 0)
        self.assertTrue(diag(result)["fallbackUsed"])

    def test_cuts_deduped_and_sorted(self):
        result = fuse_boundaries([7000.0, 3000.0, 7000.0], [], 20_000.0, min_shot_ms=1000.0)
        self.assertEqual(result["cuts"], [3000.0, 7000.0])
        self.assertEqual(diag(result)["mergedCutCount"], 2)


if __name__ == "__main__":
    unittest.main()
