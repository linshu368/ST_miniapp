#!/usr/bin/env python3
"""Validate the Android/iOS page and API P95 planning declaration."""

from __future__ import annotations

import math


SCHEMA_VERSION = 1
ALLOWED_MODES = {"pending", "required", "not_applicable"}


class MobilePerformanceGateError(ValueError):
    """Raised when a task has not completed its mobile performance review."""


def _non_empty_string(value: object) -> bool:
    return isinstance(value, str) and bool(value.strip())


def _validate_scope_list(gate: dict, field: str) -> list[str]:
    value = gate.get(field)
    if not isinstance(value, list):
        raise MobilePerformanceGateError(f"mobile_performance.{field} 必须是数组")
    if any(not _non_empty_string(item) for item in value):
        raise MobilePerformanceGateError(
            f"mobile_performance.{field} 只能包含非空字符串"
        )
    if len(value) != len(set(value)):
        raise MobilePerformanceGateError(f"mobile_performance.{field} 存在重复项")
    return value


def _positive_number(value: object) -> bool:
    return (
        isinstance(value, (int, float))
        and not isinstance(value, bool)
        and math.isfinite(value)
        and value > 0
    )


def _validate_metric_block(
    gate: dict,
    block_name: str,
    fields: tuple[str, str],
    *,
    affected: bool,
) -> None:
    block = gate.get(block_name)
    if not isinstance(block, dict):
        raise MobilePerformanceGateError(
            f"mobile_performance.{block_name} 必须是对象"
        )

    baseline_field, target_field = fields
    baseline = block.get(baseline_field)
    target = block.get(target_field)
    prefix = f"mobile_performance.{block_name}"

    if affected:
        if baseline is not None and not _positive_number(baseline):
            raise MobilePerformanceGateError(
                f"{prefix}.{baseline_field} 必须为正数或 null；无样本时用 null 并在 notes 说明"
            )
        if not _positive_number(target):
            raise MobilePerformanceGateError(
                f"{prefix}.{target_field} 必须为大于 0 的毫秒目标"
            )
        return

    if baseline is not None or target is not None:
        raise MobilePerformanceGateError(
            f"{prefix} 在对应影响范围为空时，基线和目标都必须为 null，并在 notes 说明不适用原因"
        )


def validate_mobile_performance(task_data: dict) -> dict | None:
    """Validate a task's mobile performance gate.

    Tasks created before this gate do not contain ``meta.mobile_performance``
    and remain startable. Presence of the field opts the task into the v1
    contract, which prevents newly created tasks from bypassing the review.
    """

    meta = task_data.get("meta")
    if not isinstance(meta, dict) or "mobile_performance" not in meta:
        return None

    gate = meta.get("mobile_performance")
    if not isinstance(gate, dict) or gate.get("schema_version") != SCHEMA_VERSION:
        raise MobilePerformanceGateError(
            "task.json 缺少有效 meta.mobile_performance(schema_version=1)"
        )

    mode = gate.get("mode")
    if mode not in ALLOWED_MODES:
        raise MobilePerformanceGateError(
            "mobile_performance.mode 非法；必须为 pending/required/not_applicable"
        )
    if mode == "pending":
        raise MobilePerformanceGateError(
            "mobile_performance 仍为 pending；规划完成后必须声明 required 或 not_applicable"
        )
    if mode == "not_applicable":
        if not _non_empty_string(gate.get("reason")):
            raise MobilePerformanceGateError(
                "mobile_performance.not_applicable 必须填写具体 reason"
            )
        return gate

    pages = _validate_scope_list(gate, "pages")
    apis = _validate_scope_list(gate, "apis")
    if not pages and not apis:
        raise MobilePerformanceGateError(
            "mobile_performance.required 的 pages 与 apis 不能同时为空"
        )

    page_fields = ("page_p95_baseline_ms", "page_p95_target_ms")
    _validate_metric_block(gate, "android", page_fields, affected=bool(pages))
    _validate_metric_block(gate, "ios", page_fields, affected=bool(pages))
    _validate_metric_block(
        gate,
        "api",
        ("p95_baseline_ms", "p95_target_ms"),
        affected=bool(apis),
    )

    measurement = gate.get("measurement")
    if not isinstance(measurement, dict):
        raise MobilePerformanceGateError(
            "mobile_performance.measurement 必须是对象"
        )
    for field in ("source", "window"):
        if not _non_empty_string(measurement.get(field)):
            raise MobilePerformanceGateError(
                f"mobile_performance.measurement.{field} 必须填写"
            )
    if not _non_empty_string(gate.get("notes")):
        raise MobilePerformanceGateError(
            "mobile_performance.notes 必须说明双端差异、无样本/低样本、null 字段及验证办法"
        )

    return gate
