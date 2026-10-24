from __future__ import annotations

import sys
import unittest
from pathlib import Path

import numpy as np


PYTHON_DIR = Path(__file__).resolve().parents[3] / "src" / "main" / "scope" / "python"
sys.path.insert(0, str(PYTHON_DIR))

from cie import analyze_cie, rgb_to_xy  # noqa: E402
from histogram import analyze_histogram  # noqa: E402
from parade import analyze_parade  # noqa: E402
from vectorscope import analyze_vectorscope  # noqa: E402
from waveform import analyze_waveform  # noqa: E402


def solid(red: float, green: float, blue: float, size: int = 24) -> np.ndarray:
    image = np.zeros((size, size, 3), dtype=np.float32)
    image[:, :, 0] = red
    image[:, :, 1] = green
    image[:, :, 2] = blue
    return image


def luma(rgb: np.ndarray) -> np.ndarray:
    return 0.299 * rgb[:, :, 0] + 0.587 * rgb[:, :, 1] + 0.114 * rgb[:, :, 2]


def point_in_triangle(point: dict[str, float], triangle: list[dict[str, float]]) -> bool:
    (ax, ay), (bx, by), (cx, cy) = [(item["x"], item["y"]) for item in triangle[:3]]
    denominator = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy)
    if abs(denominator) < 1e-12:
        return False
    x = point["x"]
    y = point["y"]
    a = ((by - cy) * (x - cx) + (cx - bx) * (y - cy)) / denominator
    b = ((cy - ay) * (x - cx) + (ax - cx) * (y - cy)) / denominator
    c = 1 - a - b
    return min(a, b, c) >= -0.015


class ScopeAnalyzerTests(unittest.TestCase):
    def test_histogram_black_and_white_extremes(self) -> None:
        black = analyze_histogram(solid(0, 0, 0))
        white = analyze_histogram(solid(1, 1, 1))
        self.assertEqual(black["y"][0], 1.0)
        self.assertEqual(black["r"][0], 1.0)
        self.assertEqual(white["y"][-1], 1.0)
        self.assertEqual(white["b"][-1], 1.0)

    def test_red_channel_and_vectorscope_red_region(self) -> None:
        red = solid(1, 0, 0)
        histogram = analyze_histogram(red)
        vectorscope = analyze_vectorscope(red)
        self.assertEqual(histogram["r"][-1], 1.0)
        self.assertEqual(histogram["g"][0], 1.0)
        self.assertEqual(histogram["b"][0], 1.0)
        dominant = max(vectorscope, key=lambda point: point["w"])
        self.assertGreater(dominant["u"], 0.75)
        self.assertLess(dominant["v"], 0.5)

    def test_waveform_and_parade_dimensions(self) -> None:
        gradient = np.tile(np.linspace(0, 1, 32, dtype=np.float32), (16, 1))
        image = np.dstack([gradient, gradient[::-1], gradient * 0.5])
        waveform = analyze_waveform(luma(image))
        parade = analyze_parade(image)
        self.assertEqual(len(waveform), 128)
        self.assertEqual(len(parade["r"]), 128)
        self.assertTrue(all(0 <= point["min"] <= point["max"] <= 1 for point in waveform))

    def test_cie_white_is_near_d65_and_primaries_stay_in_gamut(self) -> None:
        white = analyze_cie(solid(1, 1, 1))
        dominant = max(white["points"], key=lambda point: point["w"])
        self.assertAlmostEqual(dominant["x"], 0.3127, delta=0.012)
        self.assertAlmostEqual(dominant["y"], 0.3290, delta=0.012)

        triangle = white["gamut"][:3]
        for rgb in (solid(1, 0, 0), solid(0, 1, 0), solid(0, 0, 1), solid(1, 1, 1)):
            x_values, y_values = rgb_to_xy(rgb)
            self.assertGreater(x_values.size, 0)
            self.assertTrue(all(0 <= value <= 0.8 for value in x_values))
            self.assertTrue(all(0 <= value <= 0.9 for value in y_values))
        self.assertEqual(len(triangle), 3)

        rng = np.random.default_rng(20)
        colors = rng.random((16, 16, 3), dtype=np.float32)
        analysis = analyze_cie(colors)
        self.assertGreater(len(analysis["points"]), 0)
        self.assertTrue(all(point_in_triangle(point, triangle) for point in analysis["points"]))


if __name__ == "__main__":
    unittest.main()
