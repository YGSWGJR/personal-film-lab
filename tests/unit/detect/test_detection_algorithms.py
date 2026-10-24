from __future__ import annotations

import sys
import tempfile
import unittest
from pathlib import Path

import cv2
import numpy as np


PYTHON_DIR = Path(__file__).resolve().parents[3] / "src" / "main" / "detect" / "python"
sys.path.insert(0, str(PYTHON_DIR))

from difference import difference_curve  # noqa: E402
from features import extract_features  # noqa: E402
from params import normalize_params  # noqa: E402
from peaks import detect_cut_frames  # noqa: E402


def write_frames(directory: Path, frames: list[np.ndarray]) -> list[str]:
    paths: list[str] = []
    for index, image in enumerate(frames):
        path = directory / f"frame-{index:03d}.png"
        cv2.imwrite(str(path), image)
        paths.append(str(path))
    return paths


def detect(paths: list[str], *, filter_transitions: bool, interval_ms: int = 100) -> list[int]:
    params = normalize_params(
        {
            "sensitivity": 0.62,
            "minShotSeconds": 0.2,
            "filterTransitions": filter_transitions,
            "weights": {"s": 0.3, "c": 0.3, "h": 0.4},
        },
        interval_ms,
    )
    features = extract_features(paths)
    curve = difference_curve(features, params)
    return detect_cut_frames(curve, features, params)


class DetectionAlgorithmTests(unittest.TestCase):
    def test_black_then_white_has_one_cut(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            black = np.zeros((90, 160, 3), dtype=np.uint8)
            white = np.full((90, 160, 3), 255, dtype=np.uint8)
            paths = write_frames(Path(temp_dir), [black] * 5 + [white] * 5)
            self.assertEqual(detect(paths, filter_transitions=False), [5])

    def test_flat_color_gradient_has_no_cut(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            frames = [
                np.full((90, 160, 3), 18 + index * 20, dtype=np.uint8)
                for index in range(10)
            ]
            paths = write_frames(Path(temp_dir), frames)
            self.assertEqual(detect(paths, filter_transitions=False), [])

    def test_flash_white_is_filtered(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            black = np.zeros((90, 160, 3), dtype=np.uint8)
            white = np.full((90, 160, 3), 255, dtype=np.uint8)
            paths = write_frames(Path(temp_dir), [black] * 5 + [white] + [black] * 4)
            self.assertEqual(detect(paths, filter_transitions=True), [])

    def test_flash_white_survives_when_transition_filtering_disabled(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            black = np.zeros((90, 160, 3), dtype=np.uint8)
            white = np.full((90, 160, 3), 255, dtype=np.uint8)
            paths = write_frames(Path(temp_dir), [black] * 5 + [white] + [black] * 4)
            # 关闭转场过滤时保留单帧闪白，供后续人工复核。
            self.assertGreater(len(detect(paths, filter_transitions=False)), 0)


if __name__ == "__main__":
    unittest.main()
