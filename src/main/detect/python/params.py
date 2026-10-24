from __future__ import annotations

from dataclasses import dataclass
from typing import Any


DEFAULT_OPTIONS: dict[str, Any] = {
    "sensitivity": 0.62,
    "minShotSeconds": 0.5,
    "filterTransitions": True,
    "weights": {"s": 0.3, "c": 0.3, "h": 0.4},
}


@dataclass(frozen=True)
class DetectionParams:
    sensitivity: float
    min_shot_ms: int
    filter_transitions: bool
    weight_s: float
    weight_c: float
    weight_h: float
    interval_ms: int


def normalize_params(raw: dict[str, Any] | None, interval_ms: int) -> DetectionParams:
    options = {**DEFAULT_OPTIONS, **(raw or {})}
    weights = {**DEFAULT_OPTIONS["weights"], **(options.get("weights") or {})}

    sensitivity = float(options["sensitivity"])
    min_shot_seconds = float(options["minShotSeconds"])
    weight_s = max(0.0, float(weights["s"]))
    weight_c = max(0.0, float(weights["c"]))
    weight_h = max(0.0, float(weights["h"]))

    if not 0.0 <= sensitivity <= 1.0:
        raise ValueError("sensitivity 必须在 0~1 之间")
    if min_shot_seconds <= 0:
        raise ValueError("minShotSeconds 必须大于 0")
    if interval_ms < 50:
        raise ValueError("intervalMs 不能小于 50")
    if weight_s + weight_c + weight_h <= 0:
        raise ValueError("weights.s/c/h 之和必须大于 0")

    total = weight_s + weight_c + weight_h
    return DetectionParams(
        sensitivity=sensitivity,
        min_shot_ms=max(1, round(min_shot_seconds * 1000)),
        filter_transitions=bool(options["filterTransitions"]),
        weight_s=weight_s / total,
        weight_c=weight_c / total,
        weight_h=weight_h / total,
        interval_ms=interval_ms,
    )
