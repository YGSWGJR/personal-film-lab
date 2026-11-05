from __future__ import annotations

import math

"""边界融合器（S39-4）：纯函数、可独立单测，不加载模型、不读文件。

合并规则：
1. TransNetV2 切点为主；模型无结果时完全回退 OpenCV（fallbackUsed=True）。
2. OpenCV 切点距任一模型切点 <= mergeToleranceMs 时丢弃。
3. 补充切点数量超过 maxSupplementaryRatio * 模型切点数时，按确定性规则
   （距最近模型切点更远者优先、时间早者优先）截断，避免 OpenCV 淹没模型结果。
4. 过滤距片头/片尾或相邻切点小于 minShotMs 的边界（同冲突时优先保留模型切点）。
5. 去重后严格升序；从 0 到 durationMs 生成全覆盖、无缝无叠镜头。
"""

DEFAULT_MERGE_TOLERANCE_MS = 250.0
DEFAULT_MAX_SUPPLEMENTARY_RATIO = 0.5


class BoundaryFusionError(ValueError):
    pass


def fuse_boundaries(
    model_cuts_ms: list[float],
    opencv_cuts_ms: list[float],
    duration_ms: float,
    *,
    min_shot_ms: float = 1000.0,
    merge_tolerance_ms: float | None = None,
    max_supplementary_ratio: float = DEFAULT_MAX_SUPPLEMENTARY_RATIO,
) -> dict:
    if not _is_finite(duration_ms) or duration_ms <= 0:
        raise BoundaryFusionError(f"视频时长无效：{duration_ms!r}，无法生成全覆盖镜头")
    if not _is_finite(min_shot_ms) or min_shot_ms < 0:
        raise BoundaryFusionError(f"minShotMs 无效：{min_shot_ms!r}")
    if merge_tolerance_ms is None:
        merge_tolerance_ms = max(DEFAULT_MERGE_TOLERANCE_MS, min_shot_ms / 2.0)
    if not _is_finite(merge_tolerance_ms) or merge_tolerance_ms < 0:
        raise BoundaryFusionError(f"mergeToleranceMs 无效：{merge_tolerance_ms!r}")

    model = _sanitize_cuts(model_cuts_ms, duration_ms)
    opencv = _sanitize_cuts(opencv_cuts_ms, duration_ms)
    opencv_total = len(opencv_cuts_ms)
    model_total = len(model_cuts_ms)

    fallback_used = len(model) == 0
    if fallback_used:
        kept = list(opencv)
        discarded = opencv_total
        model_only: list[float] = []
        supplements: list[float] = []
    else:
        supplements = [
            cut for cut in opencv
            if all(abs(cut - model_cut) > merge_tolerance_ms for model_cut in model)
        ]
        discarded = opencv_total - len(supplements)
        cap = max(1, math.ceil(max_supplementary_ratio * len(model)))
        if len(supplements) > cap:
            supplements.sort(
                key=lambda cut: (
                    -min(abs(cut - model_cut) for model_cut in model),
                    cut,
                )
            )
            supplements = sorted(supplements[:cap])
        kept = sorted(set(model) | set(supplements))
        model_only = list(model)
        kept, additional_discarded = _drop_discarded(kept, supplements, min_shot_ms, duration_ms)
        discarded += additional_discarded

    cuts = kept
    shots = _cuts_to_shots(cuts, duration_ms)
    return {
        "shots": shots,
        "cuts": cuts,
        "diagnostics": {
            "modelCutCount": model_total,
            "opencvCutCount": opencv_total,
            "mergedCutCount": len(cuts),
            "modelOnlyCount": len(model_only),
            "opencvSupplementCount": len(supplements),
            "discardedCount": discarded,
            "fallbackUsed": fallback_used,
            "mode": "opencv-fallback" if fallback_used else "hybrid",
        },
    }


def _drop_discarded(
    kept: list[float],
    supplements: list[float],
    min_shot_ms: float,
    duration_ms: float,
) -> tuple[list[float], int]:
    """过滤产生过短镜头的边界；同冲突时先弃补充切点，再弃模型切点。"""
    if min_shot_ms <= 0 or not kept:
        return kept, 0

    supplement_set = set(supplements)
    remaining = list(kept)
    dropped = 0
    while True:
        violating = _first_violating(remaining, min_shot_ms, duration_ms)
        if violating is None:
            return remaining, dropped
        pair = violating
        # 只能删切点本身（片头 0 / 片尾 duration 是锚点，不可删）。
        candidates = [cut for cut in pair if cut in supplement_set]
        if not candidates:
            candidates = [cut for cut in pair if cut in remaining]
        if not candidates:
            # 过短区间夹在锚点与锚点之间（理论不可达），放弃过滤防止死循环。
            return remaining, dropped
        target = min(candidates)
        remaining.remove(target)
        dropped += 1


def _first_violating(
    cuts: list[float],
    min_shot_ms: float,
    duration_ms: float,
) -> tuple[float, ...] | None:
    if not cuts:
        return None
    anchors = [0.0, *cuts, duration_ms]
    for index in range(len(anchors) - 1):
        if anchors[index + 1] - anchors[index] < min_shot_ms:
            return (anchors[index], anchors[index + 1])
    return None


def _cuts_to_shots(cuts: list[float], duration_ms: float) -> list[list[int]]:
    shots: list[list[int]] = []
    start = 0
    for cut in cuts:
        end = int(round(cut))
        if end <= start:
            continue
        shots.append([start, end])
        start = end
    if duration_ms > start:
        shots.append([start, int(round(duration_ms))])
    elif shots and duration_ms > shots[-1][0]:
        shots[-1][1] = int(round(duration_ms))
    return shots


def _sanitize_cuts(cuts: list[float], duration_ms: float) -> list[float]:
    cleaned: list[float] = []
    for cut in cuts:
        value = float(cut)
        if not _is_finite(value) or value <= 0 or value >= duration_ms:
            continue
        cleaned.append(value)
    cleaned = sorted(set(cleaned))
    strictly: list[float] = []
    for cut in cleaned:
        if not strictly or cut > strictly[-1]:
            strictly.append(cut)
    return strictly


def _is_finite(value: object) -> bool:
    try:
        return float(value) == float(value) and float(value) not in (float("inf"), float("-inf"))
    except (TypeError, ValueError):
        return False
