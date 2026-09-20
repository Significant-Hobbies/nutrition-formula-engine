"""Transparent evidence scoring and scenario-range validation."""

from __future__ import annotations

from decimal import Decimal
from typing import Any

from .engine import CalculationError, decimal_string
from .units import convert

EVIDENCE_LEVELS = {
    "verified": Decimal("1.00"),
    "official": Decimal("0.90"),
    "specified": Decimal("0.85"),
    "range": Decimal("0.75"),
    "reference": Decimal("0.70"),
    "scenario": Decimal("0.60"),
    "inferred": Decimal("0.40"),
    "unresolved": Decimal("0.10"),
}

WEIGHTS = {
    "identity": Decimal("0.35"),
    "composition": Decimal("0.35"),
    "quantity": Decimal("0.15"),
    "yield": Decimal("0.15"),
}


def evidence_confidence(evidence: dict[str, str]) -> dict[str, Any]:
    """Return a deterministic evidence-quality score, not a probability."""

    components: dict[str, str] = {}
    score = Decimal(0)
    for dimension in ("identity", "composition", "quantity", "yield"):
        level = evidence.get(dimension)
        if level not in EVIDENCE_LEVELS:
            raise CalculationError(
                f"confidence evidence {dimension!r} must be one of {', '.join(EVIDENCE_LEVELS)}"
            )
        value = EVIDENCE_LEVELS[level]
        components[dimension] = decimal_string(value)
        score += value * WEIGHTS[dimension]

    rounded = score.quantize(Decimal("0.01"))
    band = (
        "high" if rounded >= Decimal("0.85") else "medium" if rounded >= Decimal("0.65") else "low"
    )
    return {
        "score": decimal_string(rounded),
        "band": band,
        "meaning": "evidence quality; not a statistical probability",
        "components": components,
    }


def value_range(
    specification: dict[str, Any] | None,
    *,
    nominal: str | None,
    display_unit: str,
) -> dict[str, Any]:
    """Normalize a bounded scenario range or state that no range is estimable."""

    if specification is None:
        return {
            "kind": "not_estimated",
            "lower": None,
            "upper": None,
            "error_minus": None,
            "error_plus": None,
            "unit": display_unit,
            "basis": "Supplier assay, process tolerance, or measurement uncertainty is missing",
        }
    kind = specification["kind"]
    if kind not in {"bounded", "lower_bound"}:
        raise CalculationError(f"Unsupported range kind {kind!r}")
    source_unit = specification.get("unit", display_unit)

    def converted(key: str) -> Decimal | None:
        raw = specification.get(key)
        if raw is None:
            return None
        try:
            return convert(Decimal(str(raw)), source_unit, display_unit)
        except ValueError as exc:
            raise CalculationError(str(exc)) from exc

    lower = converted("lower")
    upper = converted("upper")
    nominal_value = Decimal(nominal) if nominal is not None else None
    if lower is None:
        raise CalculationError("A value range requires a lower bound")
    if kind == "bounded" and upper is None:
        raise CalculationError("A bounded value range requires an upper bound")
    if upper is not None and upper < lower:
        raise CalculationError("Value-range upper bound cannot be below its lower bound")
    if nominal_value is not None and (
        nominal_value < lower or (upper is not None and nominal_value > upper)
    ):
        raise CalculationError("Nominal value must fall inside its configured value range")
    return {
        "kind": kind,
        "lower": decimal_string(lower),
        "upper": decimal_string(upper) if upper is not None else None,
        "error_minus": decimal_string(nominal_value - lower) if nominal_value is not None else None,
        "error_plus": decimal_string(upper - nominal_value)
        if nominal_value is not None and upper is not None
        else None,
        "unit": display_unit,
        "basis": specification["basis"],
    }
