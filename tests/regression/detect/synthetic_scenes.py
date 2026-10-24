from __future__ import annotations

import math
from dataclasses import dataclass

import cv2
import numpy as np


WIDTH = 320
HEIGHT = 180


@dataclass(frozen=True)
class RegressionCase:
    name: str
    category: str
    description: str
    frames: list[np.ndarray]
    ground_truth: list[int]


def _textured_background(seed: int, width: int, height: int, label: str) -> np.ndarray:
    rng = np.random.default_rng(seed)
    x = np.arange(width, dtype=np.float32)[None, :]
    y = np.arange(height, dtype=np.float32)[:, None]
    base = rng.integers(20, 210, size=3, dtype=np.int32)
    image = np.empty((height, width, 3), dtype=np.float32)
    image[:, :, 0] = np.broadcast_to(base[0] + x * 0.18, (height, width))
    image[:, :, 1] = np.broadcast_to(base[1] + y * 0.32, (height, width))
    image[:, :, 2] = np.broadcast_to(base[2] + (x + y) * 0.08, (height, width))
    image = np.clip(image, 0, 255).astype(np.uint8)

    for _ in range(24):
        x0 = int(rng.integers(0, max(1, width - 24)))
        y0 = int(rng.integers(0, max(1, height - 20)))
        w = int(rng.integers(8, 48))
        h = int(rng.integers(6, 34))
        color = tuple(int(value) for value in rng.integers(0, 256, size=3))
        cv2.rectangle(image, (x0, y0), (min(width - 1, x0 + w), min(height - 1, y0 + h)), color, -1)

    for _ in range(8):
        center = (int(rng.integers(0, width)), int(rng.integers(0, height)))
        radius = int(rng.integers(5, 24))
        color = tuple(int(value) for value in rng.integers(0, 256, size=3))
        cv2.circle(image, center, radius, color, -1, lineType=cv2.LINE_AA)

    cv2.putText(
        image,
        label,
        (18, height - 18),
        cv2.FONT_HERSHEY_SIMPLEX,
        0.55,
        (245, 245, 245),
        2,
        cv2.LINE_AA,
    )
    cv2.putText(
        image,
        f"S{seed:02d}",
        (width - 72, 28),
        cv2.FONT_HERSHEY_SIMPLEX,
        0.45,
        (15, 15, 15),
        2,
        cv2.LINE_AA,
    )
    return image


def _scene_frame(seed: int, phase: int, label: str) -> np.ndarray:
    image = _textured_background(seed, WIDTH, HEIGHT, label)
    shift = int(round(math.sin(phase * 0.12) * 2))
    if shift:
        image = np.roll(image, shift, axis=1)
    rng = np.random.default_rng(seed * 100_003 + phase)
    noise = rng.normal(0, 0.7, image.shape)
    return np.clip(image.astype(np.float32) + noise, 0, 255).astype(np.uint8)


def hardcut_cases() -> list[RegressionCase]:
    specs = [
        ("hardcut-2", [("A", 20, 11), ("B", 20, 29)], "两场景单硬切"),
        ("hardcut-3", [("A", 14, 101), ("B", 16, 117), ("C", 18, 131)], "三场景双硬切"),
        ("hardcut-4", [("A", 11, 211), ("B", 12, 223), ("C", 13, 227), ("D", 14, 229)], "四场景三硬切"),
    ]
    cases: list[RegressionCase] = []
    for name, segments, description in specs:
        frames: list[np.ndarray] = []
        ground_truth: list[int] = []
        for label, count, seed in segments:
            if frames:
                ground_truth.append(len(frames))
            frames.extend(_scene_frame(seed, phase, label) for phase in range(count))
        cases.append(RegressionCase(name, "hardcut", description, frames, ground_truth))
    return cases


def fade_cases() -> list[RegressionCase]:
    specs = [(8, 18, 18, 301, 311), (10, 17, 19, 321, 331), (13, 16, 18, 341, 353)]
    cases: list[RegressionCase] = []
    for index, (blend_frames, a_frames, b_frames, seed_a, seed_b) in enumerate(specs, start=1):
        frames = [_scene_frame(seed_a, phase, "A") for phase in range(a_frames)]
        for blend_index in range(blend_frames):
            alpha = (blend_index + 1) / (blend_frames + 1)
            a = _scene_frame(seed_a, a_frames + blend_index, "A").astype(np.float32)
            b = _scene_frame(seed_b, blend_index, "B").astype(np.float32)
            frames.append(np.clip((1.0 - alpha) * a + alpha * b, 0, 255).astype(np.uint8))
        frames.extend(_scene_frame(seed_b, blend_frames + phase, "B") for phase in range(b_frames))
        midpoint = a_frames + round(blend_frames / 2)
        cases.append(
            RegressionCase(
                f"fade-{index}",
                "fade",
                f"{blend_frames}帧线性crossfade，真值取渐变中点",
                frames,
                [midpoint],
            )
        )
    return cases


def flash_cases() -> list[RegressionCase]:
    specs = [
        ("flash-2", 52, [12, 31], 401),
        ("flash-3", 60, [9, 26, 44], 409),
        ("flash-4", 68, [8, 23, 39, 55], 419),
    ]
    cases: list[RegressionCase] = []
    for name, frame_count, flash_positions, seed in specs:
        white = np.full((HEIGHT, WIDTH, 3), 255, dtype=np.uint8)
        frames = [
            white.copy() if index in flash_positions else _scene_frame(seed, index, "A")
            for index in range(frame_count)
        ]
        cases.append(RegressionCase(name, "flash", "正常画面中插入单帧全白", frames, list(flash_positions)))
    return cases


def _pan_background(seed: int) -> np.ndarray:
    width = WIDTH + 260
    image = _textured_background(seed, width, HEIGHT, "PAN")
    for x in range(20, width, 58):
        cv2.rectangle(image, (x, 30), (x + 22, 150), (35, 190, 225), -1)
    return image


def pan_cases() -> list[RegressionCase]:
    return [
        RegressionCase(
            f"pan-{index}",
            "pan",
            f"连续横移步长{step}px，无镜头切换",
            [
                _pan_background(seed)[:, offset : offset + WIDTH].copy()
                for offset in range(0, 261, step)
            ],
            [],
        )
        for index, (seed, step) in enumerate(((501, 4), (509, 6), (521, 5)), start=1)
    ]


def _occlusion_frame(seed: int, phase: int, box_x: int, label: str) -> np.ndarray:
    image = _scene_frame(seed, phase, label)
    cv2.rectangle(image, (box_x, 52), (box_x + 72, 148), (18, 18, 18), -1)
    cv2.circle(image, (box_x + 36, 92), 18, (50, 160, 220), -1, lineType=cv2.LINE_AA)
    return image


def occlusion_cases() -> list[RegressionCase]:
    cases: list[RegressionCase] = []
    for index, (seed, step) in enumerate(((601, 6), (613, 8), (631, 5)), start=1):
        frames = [
            _occlusion_frame(seed, phase, -70 + phase * step, "OCCL")
            for phase in range(40)
        ]
        cases.append(RegressionCase(f"occlusion-none-{index}", "occlusion", "遮挡物滑过同一画面", frames, []))

    seed_a, seed_b = 641, 653
    frames = []
    for phase in range(48):
        box_x = -60 + phase * 7
        if phase < 26:
            frames.append(_occlusion_frame(seed_a, phase, box_x, "A"))
        else:
            frames.append(_occlusion_frame(seed_b, phase - 26, box_x, "B"))
    cases.append(RegressionCase("occlusion-cut", "occlusion", "遮挡过程中切换到另一画面", frames, [26]))
    return cases


def all_cases() -> list[RegressionCase]:
    return [*hardcut_cases(), *fade_cases(), *flash_cases(), *pan_cases(), *occlusion_cases()]
