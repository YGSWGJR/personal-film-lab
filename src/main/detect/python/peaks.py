from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Literal

import numpy as np

from difference import bhattacharyya_distance, frame_difference
from params import DetectionParams


@dataclass(frozen=True)
class CandidateDecision:
    index: int
    amplitude: float
    status: Literal["cut", "weak", "transition", "jitter"]
    reason: str


def detect_cut_frames(
    differences: list[float],
    features: list[dict[str, object]],
    params: DetectionParams,
) -> list[int]:
    return [
        decision.index + 1
        for decision in analyze_cut_candidates(differences, features, params)
        if decision.status == "cut"
    ]


def analyze_cut_candidates(
    differences: list[float],
    features: list[dict[str, object]],
    params: DetectionParams,
) -> list[CandidateDecision]:
    if len(differences) == 0 or len(features) < 2:
        return []

    curve = np.asarray(differences, dtype=np.float64)
    min_gap_frames = max(1, math.ceil(params.min_shot_ms / params.interval_ms))
    high_q = 0.70 + 0.20 * params.sensitivity
    high_threshold = float(np.percentile(curve, high_q * 100))
    abs_floor = 0.05 + 0.05 * params.sensitivity
    high_threshold = max(high_threshold, abs_floor)
    low_threshold = high_threshold * 0.5

    local_peaks: list[int] = []
    prominences: dict[int, float] = {}
    for index, value in enumerate(curve):
        left = curve[index - 1] if index > 0 else -math.inf
        right = curve[index + 1] if index + 1 < len(curve) else -math.inf
        if value >= left and value >= right:
            local_peaks.append(index)
            prominences[index] = float(value - max(left, right)) if math.isfinite(max(left, right)) else float(value)

    seeds = [index for index in local_peaks if curve[index] > high_threshold]
    candidates = _merge_hysteresis_clusters(
        curve,
        seeds,
        local_peaks,
        low_threshold,
        min_gap_frames,
    )

    for index in local_peaks:
        value = float(curve[index])
        if value > high_threshold and prominences[index] >= 0.015:
            candidates.append(index)
    candidates = sorted(set(candidates))

    separated: list[int] = []
    for candidate in candidates:
        if not separated or candidate - separated[-1] >= min_gap_frames:
            separated.append(candidate)
        elif curve[candidate] > curve[separated[-1]]:
            separated[-1] = candidate

    decisions: list[CandidateDecision] = []
    for index in separated:
        d_direct, _ = confirm_cut(index, features, params, low_threshold, float(curve[index]))
        if d_direct < low_threshold:
            decisions.append(CandidateDecision(index, float(curve[index]), "weak", "weak_difference"))
            continue

        transition = transition_kind(index, features)
        if transition is not None:
            decisions.append(
                CandidateDecision(
                    index,
                    float(curve[index]),
                    "transition" if params.filter_transitions else "cut",
                    transition,
                )
            )
        elif _is_brief_excursion(index, features, params, low_threshold):
            decisions.append(CandidateDecision(index, float(curve[index]), "jitter", "brief_excursion"))
        else:
            decisions.append(CandidateDecision(index, float(curve[index]), "cut", transition or "strong"))

    return _filter_jitter_clusters(decisions, min_gap_frames)


def confirm_cut(
    index: int,
    features: list[dict[str, object]],
    params: DetectionParams,
    low_threshold: float = 0.0,
    fallback_difference: float = 0.0,
) -> tuple[float, float]:
    if len(features) < 2:
        return 0.0, 0.0
    before = max(0, index - 1)
    after = min(len(features) - 1, index + 1)
    difference_keys = ("s", "c", "h", "hv", "edge", "grid")
    if not any(
        key in features[before] or key in features[after]
        for key in difference_keys
    ):
        return fallback_difference, fallback_difference
    d_local = frame_difference(features[index], features[after], params)
    d_before = frame_difference(features[before], features[index], params)
    d_direct = max(d_before, d_local)
    return d_direct, d_local


def _filter_jitter_clusters(
    decisions: list[CandidateDecision],
    min_gap_frames: int,
) -> list[CandidateDecision]:
    radius = max(1, math.ceil(min_gap_frames / 2))
    cut_decisions = [decision for decision in decisions if decision.status == "cut"]
    rejected: set[int] = set()

    position = 0
    while position < len(cut_decisions):
        group = [cut_decisions[position]]
        following = position + 1
        while (
            following < len(cut_decisions)
            and cut_decisions[following].index - group[-1].index <= radius
        ):
            group.append(cut_decisions[following])
            following += 1

        if len(group) >= 2:
            amplitudes = [decision.amplitude for decision in group]
            strongest = max(amplitudes)
            if strongest > 0 and (strongest - min(amplitudes)) / strongest < 0.20:
                keeper = max(group, key=lambda decision: (decision.amplitude, -decision.index))
                rejected.update(decision.index for decision in group if decision.index != keeper.index)
        position = following

    return [
        CandidateDecision(decision.index, decision.amplitude, "jitter", "jitter_cluster")
        if decision.index in rejected
        else decision
        for decision in decisions
    ]


def _is_brief_excursion(
    index: int,
    features: list[dict[str, object]],
    params: DetectionParams,
    low_threshold: float,
) -> bool:
    for center in (index, index + 1):
        if center <= 0 or center + 1 >= len(features):
            continue
        first = frame_difference(features[center - 1], features[center], params)
        second = frame_difference(features[center], features[center + 1], params)
        outer = frame_difference(features[center - 1], features[center + 1], params)
        if first >= low_threshold and second >= low_threshold and outer < low_threshold * 0.75:
            return True
    return False


def _merge_hysteresis_clusters(
    curve: np.ndarray,
    seeds: list[int],
    local_peaks: list[int],
    low_threshold: float,
    min_gap_frames: int,
) -> list[int]:
    if not seeds:
        return []

    peak_set = set(local_peaks)
    merged: list[int] = []
    consumed: set[int] = set()
    for seed in seeds:
        if seed in consumed:
            continue
        cluster = {seed}

        cursor = seed
        while True:
            previous = next((index for index in range(cursor - 1, -1, -1) if index in peak_set), None)
            if (
                previous is None
                or cursor - previous >= min_gap_frames
                or curve[previous] <= low_threshold
            ):
                break
            cluster.add(previous)
            cursor = previous

        cursor = seed
        while True:
            following = next(
                (index for index in range(cursor + 1, len(curve)) if index in peak_set),
                None,
            )
            if (
                following is None
                or following - cursor >= min_gap_frames
                or curve[following] <= low_threshold
            ):
                break
            cluster.add(following)
            cursor = following

        consumed.update(cluster)
        strongest = max(cluster, key=lambda index: (float(curve[index]), -index))
        merged.append(strongest)
    return merged


def is_transition_candidate(boundary: int, features: list[dict[str, object]]) -> bool:
    return transition_kind(boundary, features) is not None


def transition_kind(boundary: int, features: list[dict[str, object]]) -> str | None:
    brightness = np.asarray([float(feature["v"]) for feature in features], dtype=np.float64)
    neighborhood = brightness[max(0, boundary - 1) : min(len(brightness), boundary + 3)]
    fade_window = brightness[max(0, boundary - 3) : min(len(brightness), boundary + 4)]
    if fade_window.size >= 5:
        steps = np.diff(fade_window)
        span = float(fade_window.max() - fade_window.min())
        monotonic_up = bool(np.all(steps >= -0.005))
        monotonic_down = bool(np.all(steps <= 0.005))
        gradual = float(np.max(np.abs(steps))) < 0.12
        if span > 0.12 and gradual and (monotonic_up or monotonic_down):
            return "fade"

    if _is_flash_candidate(boundary, features):
        return "flash"
    if neighborhood.size and float(neighborhood.min()) < 0.08:
        return "black"
    return None


def _is_flash_candidate(boundary: int, features: list[dict[str, object]]) -> bool:
    left = features[boundary]
    right = features[min(len(features) - 1, boundary + 1)]
    left_v = float(left["v"])
    right_v = float(right["v"])
    hue_distance = _feature_hue_distance(left, right)
    if left_v > 0.8 and right_v > 0.8 and hue_distance < 0.1:
        return True

    window = features[max(0, boundary - 1) : min(len(features), boundary + 3)]
    for offset, feature in enumerate(window):
        if float(feature["v"]) <= 0.9:
            continue
        position = max(0, boundary - 1) + offset
        before = features[position - 1] if position > 0 else None
        after = features[position + 1] if position + 1 < len(features) else None
        if before is None or after is None:
            continue
        if (
            float(before["v"]) < 0.8
            or float(after["v"]) < 0.8
        ) and _feature_hue_distance(before, after) < 0.1:
            return True
    return False


def _feature_hue_distance(
    left: dict[str, object],
    right: dict[str, object],
) -> float:
    if "h" not in left or "h" not in right:
        return 0.0
    return bhattacharyya_distance(
        left["h"],  # type: ignore[arg-type]
        right["h"],  # type: ignore[arg-type]
    )
