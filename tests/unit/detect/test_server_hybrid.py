from __future__ import annotations

import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import cv2
import numpy as np


PYTHON_DIR = Path(__file__).resolve().parents[3] / "src" / "main" / "detect" / "python"
sys.path.insert(0, str(PYTHON_DIR))

import server  # noqa: E402


def write_frames(directory: Path, values: list[int]) -> list[str]:
    paths: list[str] = []
    for index, value in enumerate(values):
        path = directory / f"frame-{index:03d}.png"
        image = np.full((90, 160, 3), value, dtype=np.uint8)
        cv2.imwrite(str(path), image)
        paths.append(str(path))
    return paths


def opencv_result() -> dict:
    feature = {
        "s": 0.2,
        "c": 0.2,
        "v": 0.2,
        "h": [1.0] + [0.0] * 31,
        "hv": [1.0] + [0.0] * 31,
        "edge": 0.1,
        "grid": [0.2] * 9,
    }
    return {
        "intervalMs": 100,
        "features": [feature.copy() for _ in range(10)],
        "cutFrames": [5],
        "shotRanges": [
            {"startFrame": 0, "endFrame": 5},
            {"startFrame": 5, "endFrame": 10},
        ],
        "sceneRanges": [{"startFrame": 0, "endFrame": 10}],
    }


def model_result() -> dict:
    return {
        "scenes": [[0, 12], [12, 25]],
        "framesTotal": 25,
        "fps": 25.0,
        "model": "TransNetV2",
        "modelSha256": "test",
        "provider": "CPUExecutionProvider",
        "singleFramePredictions": [],
        "allFramePredictions": [],
    }


class HybridServerTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory()
        self.frames = write_frames(
            Path(self.temp_dir.name),
            [0, 0, 0, 0, 0, 255, 255, 255, 255, 255],
        )
        self.base_params = {
            "frames": self.frames,
            "intervalMs": 100,
            "durationMs": 1000,
            "options": {"sensitivity": 0.62, "minShotSeconds": 0.2},
        }

    def tearDown(self) -> None:
        self.temp_dir.cleanup()

    def test_opencv_mode_remains_default_and_compatible(self) -> None:
        with mock.patch.object(server, "notify_progress"):
            result = server.analyze(dict(self.base_params))
        self.assertEqual(result["intervalMs"], 100)
        self.assertGreaterEqual(len(result["shotRanges"]), 1)
        self.assertEqual(result["shotRanges"][0]["startFrame"], 0)
        self.assertEqual(result["shotRanges"][-1]["endFrame"], len(self.frames))

    def test_hybrid_returns_millisecond_ranges_and_diagnostics(self) -> None:
        progress: list[int] = []
        params = {
            **self.base_params,
            "mode": "hybrid",
            "videoPath": "video.mp4",
            "ffmpegPath": "ffmpeg.exe",
            "transnetModelPath": "model.onnx",
        }
        with (
            mock.patch.object(server, "_run_opencv", return_value=(opencv_result(), None)),
            mock.patch("transnetv2_runtime.detect_video", return_value=model_result()),
            mock.patch.object(server, "notify_progress", side_effect=progress.append),
        ):
            result = server.analyze(params)

        self.assertEqual(result["intervalMs"], 1)
        self.assertEqual(result["shotRanges"][0], {"startFrame": 0, "endFrame": 480})
        self.assertEqual(result["shotRanges"][-1]["endFrame"], 1000)
        self.assertEqual(result["diagnostics"]["mode"], "hybrid")
        self.assertFalse(result["diagnostics"]["fallbackUsed"])
        self.assertEqual(progress, sorted(progress))
        self.assertGreaterEqual(progress[-1], 90)

    def test_hybrid_falls_back_to_opencv_when_model_fails(self) -> None:
        params = {
            **self.base_params,
            "mode": "hybrid",
            "videoPath": "video.mp4",
            "ffmpegPath": "ffmpeg.exe",
            "transnetModelPath": "model.onnx",
        }
        with (
            mock.patch.object(server, "_run_opencv", return_value=(opencv_result(), None)),
            mock.patch("transnetv2_runtime.detect_video", side_effect=RuntimeError("model broken")),
        ):
            result = server.analyze(params)

        self.assertTrue(result["diagnostics"]["fallbackUsed"])
        self.assertTrue(result["diagnostics"]["modelFailed"])
        self.assertEqual(result["diagnostics"]["mode"], "opencv-fallback")
        self.assertIn("已回退 OpenCV", result["warning"])
        self.assertEqual(result["shotRanges"][-1]["endFrame"], 1000)

    def test_transnetv2_mode_ignores_opencv_supplement_on_success(self) -> None:
        params = {
            **self.base_params,
            "mode": "transnetv2",
            "videoPath": "video.mp4",
            "ffmpegPath": "ffmpeg.exe",
            "transnetModelPath": "model.onnx",
        }
        with (
            mock.patch.object(server, "_run_opencv", return_value=(opencv_result(), None)),
            mock.patch("transnetv2_runtime.detect_video", return_value=model_result()),
        ):
            result = server.analyze(params)

        self.assertEqual(result["diagnostics"]["mode"], "transnetv2")
        self.assertEqual(result["diagnostics"]["opencvCutCount"], 1)
        self.assertEqual(result["diagnostics"]["opencvSupplementCount"], 0)
        self.assertFalse(result["diagnostics"]["fallbackUsed"])
        self.assertEqual(result["shotRanges"][0], {"startFrame": 0, "endFrame": 480})

    def test_hybrid_reports_when_both_engines_fail(self) -> None:
        params = {
            **self.base_params,
            "mode": "hybrid",
            "videoPath": "video.mp4",
            "ffmpegPath": "ffmpeg.exe",
            "transnetModelPath": "model.onnx",
        }
        with (
            mock.patch.object(server, "_run_opencv", return_value=(None, RuntimeError("opencv broken"))),
            mock.patch("transnetv2_runtime.detect_video", side_effect=RuntimeError("model broken")),
        ):
            with self.assertRaisesRegex(ValueError, "双引擎均失败"):
                server.analyze(params)

    def test_invalid_mode_is_rejected(self) -> None:
        with self.assertRaisesRegex(ValueError, "不支持的镜头检测模式"):
            server.analyze({**self.base_params, "mode": "unknown"})

    def test_json_rpc_handle_serializes_result(self) -> None:
        sent: list[dict] = []
        with (
            mock.patch.object(server, "analyze", return_value={"ok": True}),
            mock.patch.object(server, "send", side_effect=sent.append),
        ):
            server.handle({"jsonrpc": "2.0", "id": 7, "method": "analyze", "params": {}})

        self.assertEqual(sent[0]["id"], 7)
        self.assertEqual(sent[0]["result"], {"ok": True})
        self.assertNotIn("error", sent[0])


if __name__ == "__main__":
    unittest.main()
