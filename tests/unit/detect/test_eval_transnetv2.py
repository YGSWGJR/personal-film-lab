from __future__ import annotations

import sys
import unittest
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[3]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from tests.regression.detect.eval_transnetv2 import match_cuts, metrics  # noqa: E402


class EvaluationMetricTests(unittest.TestCase):
    def test_empty_truth_and_detection_are_perfect(self) -> None:
        result = metrics([], [], 100.0)
        self.assertEqual(result["tp"], 0)
        self.assertEqual(result["fp"], 0)
        self.assertEqual(result["fn"], 0)
        self.assertEqual(result["f1"], 1.0)

    def test_nearest_detection_is_matched_once(self) -> None:
        tp, fp, fn, errors = match_cuts([1000, 2000], [1040, 1980, 2500], 100)
        self.assertEqual((tp, fp, fn), (2, 1, 0))
        self.assertEqual(errors, [40.0, 20.0])

    def test_detection_outside_tolerance_counts_as_miss_and_false_positive(self) -> None:
        result = metrics([1000], [1201], 200)
        self.assertEqual(result["tp"], 0)
        self.assertEqual(result["fp"], 1)
        self.assertEqual(result["fn"], 1)
        self.assertEqual(result["f1"], 0.0)


if __name__ == "__main__":
    unittest.main()
