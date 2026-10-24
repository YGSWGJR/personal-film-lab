from __future__ import annotations

import sys
import unittest
from pathlib import Path

import numpy as np


PYTHON_DIR = Path(__file__).resolve().parents[3] / "src" / "main" / "scope" / "python"
sys.path.insert(0, str(PYTHON_DIR))

from histogram import analyze_histogram  # noqa: E402
from parade import analyze_parade  # noqa: E402
from waveform import analyze_waveform  # noqa: E402


def solid(red: float, green: float, blue: float, size: int = 24) -> np.ndarray:
    image = np.zeros((size, size, 3), dtype=np.float32)
    image[:, :, 0] = red
    image[:, :, 1] = green
    image[:, :, 2] = blue
    return image


def luma(rgb: np.ndarray) -> np.ndarray:
    return 0.299 * rgb[:, :, 0] + 0.587 * rgb[:, :, 1] + 0.114 * rgb[:, :, 2]


class ScopeAnalyzerTests(unittest.TestCase):
    def test_histogram_black_and_white_extremes(self) -> None:
        black = analyze_histogram(solid(0, 0, 0))
        white = analyze_histogram(solid(1, 1, 1))
        self.assertEqual(black["y"][0], 1.0)
        self.assertEqual(black["r"][0], 1.0)
        self.assertEqual(white["y"][-1], 1.0)
        self.assertEqual(white["b"][-1], 1.0)

    def test_red_channel_peaks(self) -> None:
        red = solid(1, 0, 0)
        histogram = analyze_histogram(red)
        self.assertEqual(histogram["r"][-1], 1.0)
        self.assertEqual(histogram["g"][0], 1.0)
        self.assertEqual(histogram["b"][0], 1.0)

    def test_waveform_and_parade_dimensions(self) -> None:
        gradient = np.tile(np.linspace(0, 1, 32, dtype=np.float32), (16, 1))
        image = np.dstack([gradient, gradient[::-1], gradient * 0.5])
        waveform = analyze_waveform(luma(image))
        parade = analyze_parade(image)
        self.assertEqual(len(waveform), 128)
        self.assertEqual(len(parade["r"]), 128)
        self.assertTrue(all(0 <= point["min"] <= point["max"] <= 1 for point in waveform))

if __name__ == "__main__":
    unittest.main()
