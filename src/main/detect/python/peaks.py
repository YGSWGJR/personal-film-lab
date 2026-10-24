from __future__ import annotations

import math

import numpy as np

from params import DetectionParams


def detect_cut_frames(
    differences: list[float],
    features: list[dict[str, object]],
    params: DetectionParams,
) -> list[int]:
    if len(differences) == 0 or len(features) < 2:
        return []

    curve = np.asarray(differences, dtype=np.float64)
    threshold = float(
        curve.mean() + (1.6 - params.sensitivity * 1.5) * curve.std()
    )
    candidates: list[int] = []
    for index, value in enumerate(curve):
        left = curve[index - 1] if index > 0 else -math.inf
        right = curve[index + 1] if index + 1 < len(curve) else -math.inf
        prominence = value - max(left, right)
        strong_plateau = value > threshold + 0.05 and value >= left and value >= right
        isolated_peak = (
            value > threshold
            and value > left
            and value >= right
            and prominence >= 0.015
        )
        if strong_plateau or isolated_peak:
            candidates.append(index)

    min_gap_frames = max(1, math.ceil(params.min_shot_ms / params.interval_ms))
    separated: list[int] = []
    for candidate in candidates:
        if not separated or candidate - separated[-1] >= min_gap_frames:
            separated.append(candidate)
        elif curve[candidate] > curve[separated[-1]]:
            separated[-1] = candidate

    if not params.filter_transitions:
        return [index + 1 for index in separated]
    return [
        index + 1
        for index in separated
        if not is_transition_candidate(index, features)
    ]


def is_transition_candidate(boundary: int, features: list[dict[str, object]]) -> bool:
    brightness = np.asarray([float(feature["v"]) for feature in features], dtype=np.float64)
    neighborhood = brightness[max(0, boundary - 1) : min(len(brightness), boundary + 3)]
    if neighborhood.size and float(neighborhood.max()) > 0.9:
        return True

    fade_window = brightness[max(0, boundary - 3) : min(len(brightness), boundary + 4)]
    if fade_window.size < 5:
        return False
    steps = np.diff(fade_window)
    span = float(fade_window.max() - fade_window.min())
    monotonic_up = bool(np.all(steps >= -0.005))
    monotonic_down = bool(np.all(steps <= 0.005))
    gradual = float(np.max(np.abs(steps))) < 0.12
    return span > 0.12 and gradual and (monotonic_up or monotonic_down)
