from __future__ import annotations

import sys
import unittest
from pathlib import Path

import numpy as np


PYTHON_DIR = Path(__file__).resolve().parents[3] / "src" / "main" / "detect" / "python"
sys.path.insert(0, str(PYTHON_DIR))

from transnetv2_runtime import (  # noqa: E402
    FRAME_CHANNELS,
    FRAME_HEIGHT,
    FRAME_WIDTH,
    WINDOW_SIZE,
    frames_to_ms,
    predictions_to_scenes,
    stream_sliding_window_inference,
)


class RecordingSession:
    def __init__(self) -> None:
        self.inputs: list[np.ndarray] = []

    def get_inputs(self):
        return [type("Input", (), {"name": "input"})()]

    def get_outputs(self):
        return [
            type("Output", (), {"name": "single"})(),
            type("Output", (), {"name": "many"})(),
        ]

    def run(self, _names, feed):
        self.inputs.append(np.asarray(feed["input"]).copy())
        batch = np.asarray(feed["input"]).shape[0]
        return [
            np.zeros((batch, WINDOW_SIZE, 1), dtype=np.float32),
            np.zeros((batch, WINDOW_SIZE, 1), dtype=np.float32),
        ]


def frame(value: int) -> np.ndarray:
    return np.full((FRAME_HEIGHT, FRAME_WIDTH, FRAME_CHANNELS), value, dtype=np.uint8)


class TransNetV2RuntimeTests(unittest.TestCase):
    def test_predictions_to_scenes_uses_half_open_ranges(self) -> None:
        scenes = predictions_to_scenes([0.0, 0.8, 0.0, 0.0, 0.9], threshold=0.5)
        self.assertEqual(scenes, [[0, 2], [2, 5]])

    def test_predictions_to_scenes_handles_empty_and_no_cuts(self) -> None:
        self.assertEqual(predictions_to_scenes([]), [])
        self.assertEqual(predictions_to_scenes([0.0] * 7), [[0, 7]])

    def test_frames_to_ms_uses_normalized_25fps(self) -> None:
        self.assertEqual(frames_to_ms(0), 0)
        self.assertEqual(frames_to_ms(1), 40)
        self.assertEqual(frames_to_ms(50), 2000)

    def test_streamed_windows_match_official_padding(self) -> None:
        frames = [frame(index) for index in range(130)]
        session = RecordingSession()
        progress: list[float] = []

        single, many, total = stream_sliding_window_inference(
            iter(frames),
            session,
            expected_frames=len(frames),
            progress=progress.append,
        )

        self.assertEqual(total, 130)
        self.assertEqual(single.shape, (130,))
        self.assertEqual(many.shape, (130,))
        self.assertEqual(len(session.inputs), 3)
        self.assertEqual(session.inputs[0].shape, (1, 100, 27, 48, 3))

        # 第 0 窗：前 25 帧复制首帧，其余覆盖原片 0~74 帧。
        first = session.inputs[0][0, :, 0, 0, 0].astype(np.int32)
        expected_first = np.clip(np.arange(-25, 75), 0, 129)
        np.testing.assert_array_equal(first, expected_first)

        # 第 1 窗覆盖原片 25~124 帧。
        second = session.inputs[1][0, :, 0, 0, 0].astype(np.int32)
        np.testing.assert_array_equal(second, np.arange(25, 125))

        # 第 2 窗尾部复制末帧。
        third = session.inputs[2][0, :, 0, 0, 0].astype(np.int32)
        expected_third = np.clip(np.arange(75, 175), 0, 129)
        np.testing.assert_array_equal(third, expected_third)

        self.assertEqual(progress, sorted(progress))
        self.assertAlmostEqual(progress[-1], 1.0)

    def test_stream_rejects_empty_video(self) -> None:
        with self.assertRaisesRegex(RuntimeError, "没有输出任何帧"):
            stream_sliding_window_inference(iter(()), RecordingSession())


if __name__ == "__main__":
    unittest.main()
