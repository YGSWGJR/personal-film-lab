from __future__ import annotations

import numpy as np

from difference import bhattacharyya_distance


def _average_feature(
    features: list[dict[str, object]], start: int, end: int
) -> dict[str, object]:
    segment = features[start:end]
    return {
        "s": float(np.mean([float(item["s"]) for item in segment])),
        "c": float(np.mean([float(item["c"]) for item in segment])),
        "v": float(np.mean([float(item["v"]) for item in segment])),
        "h": np.mean(
            np.asarray([item["h"] for item in segment], dtype=np.float32), axis=0
        ).tolist(),
    }


def cluster_scenes(
    shot_ranges: list[dict[str, int]],
    features: list[dict[str, object]],
    threshold: float = 0.15,
) -> list[dict[str, int]]:
    if not shot_ranges:
        return []

    scenes: list[dict[str, int]] = []
    current_start, current_end = shot_ranges[0]["startFrame"], shot_ranges[0]["endFrame"]
    current_feature = _average_feature(features, current_start, current_end)

    for shot in shot_ranges[1:]:
        next_feature = _average_feature(features, shot["startFrame"], shot["endFrame"])
        if bhattacharyya_distance(current_feature["h"], next_feature["h"]) < threshold:
            current_end = shot["endFrame"]
            current_feature = _average_feature(features, current_start, current_end)
        else:
            scenes.append({"startFrame": current_start, "endFrame": current_end})
            current_start, current_end = shot["startFrame"], shot["endFrame"]
            current_feature = next_feature

    scenes.append({"startFrame": current_start, "endFrame": current_end})
    return scenes
