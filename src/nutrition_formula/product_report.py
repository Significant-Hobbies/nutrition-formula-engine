"""Build a product-specific priority report from nutrition and chemical results."""

from __future__ import annotations

from decimal import Decimal
from typing import Any

from .confidence import evidence_confidence, value_range
from .engine import CalculationError, calculate, decimal_string
from .units import convert


def _by_id(result: dict[str, Any]) -> dict[str, dict[str, Any]]:
    return {item["id"]: item for item in result["nutrients"]}


def _convert_value(value: str | None, from_unit: str, to_unit: str) -> str | None:
    if value is None:
        return None
    try:
        return decimal_string(convert(Decimal(value), from_unit, to_unit))
    except ValueError as exc:
        raise CalculationError(str(exc)) from exc


def _contributions(
    original: dict[str, Any], display_unit: str
) -> list[dict[str, Any]]:
    converted = []
    for contribution in original.get("contributions", []):
        converted.append(
            {
                **contribution,
                "unit": display_unit,
                "total_batch": _convert_value(
                    contribution["total_batch"], original["unit"], display_unit
                ),
                "minimum_total_batch": _convert_value(
                    contribution["minimum_total_batch"], original["unit"], display_unit
                ),
                "maximum_total_batch": _convert_value(
                    contribution["maximum_total_batch"], original["unit"], display_unit
                ),
                "per_100_g": _convert_value(
                    contribution["per_100_g"], original["unit"], display_unit
                ),
                "per_100_ml": _convert_value(
                    contribution["per_100_ml"], original["unit"], display_unit
                ),
                "per_serving": _convert_value(
                    contribution["per_serving"], original["unit"], display_unit
                ),
            }
        )
    return converted


def _ingredient_assumptions(*results: dict[str, Any]) -> list[dict[str, Any]]:
    merged: dict[str, dict[str, Any]] = {}
    for result in results:
        report_type = result["report_type"]
        for item in result["assumptions"]:
            query = item["query"]
            target = merged.setdefault(
                query,
                {
                    "query": query,
                    "selected_identity": item["selected_name"],
                    "confidence": item["confidence"],
                    "notes": [],
                    "identity_candidates": item.get("identity_candidates", []),
                    "correction": item["correction"],
                },
            )
            if report_type == "chemical":
                target["selected_identity"] = item["selected_name"]
                target["identity_candidates"] = item.get("identity_candidates", [])
                target["correction"] = item["correction"]
            if item["confidence"] == "low":
                target["confidence"] = "low"
            note = item.get("identity_note")
            if note:
                labelled_note = f"{report_type}: {note}"
                if labelled_note not in target["notes"]:
                    target["notes"].append(labelled_note)
    return list(merged.values())


def _source_range(original: dict[str, Any], specification: dict[str, Any]) -> dict[str, Any] | None:
    configured = specification.get("range")
    if configured is not None:
        return configured
    calculated = original.get("per_100_ml_range")
    if not calculated or calculated["kind"] == "point":
        return None
    return {
        **calculated,
        "unit": original["unit"],
        "basis": "Propagated from ingredient quantity, assay, and unresolved-profile bounds",
    }


def _missing_information(
    metrics: list[dict[str, Any]],
    catalogs: dict[str, dict[str, Any]],
    report_definition: dict[str, Any],
) -> list[dict[str, Any]]:
    missing: dict[tuple[str, str], dict[str, Any]] = {}
    for metric in metrics:
        for material_id in metric["unknown_materials"]:
            key = (metric["source_report"], material_id)
            material = catalogs[metric["source_report"]]["materials"][material_id]
            entry = missing.setdefault(
                key,
                {
                    "id": material_id,
                    "item": material["name"],
                    "needed": material.get(
                        "missing_information", "Complete supplier composition specification"
                    ),
                    "affects": [],
                },
            )
            entry["affects"].append(metric["name"])
    result = list(missing.values())
    result.extend(report_definition.get("required_information", []))
    return result


def _profile_coverage(
    nutrition: dict[str, Any],
    nutrition_catalog: dict[str, Any],
    report_definition: dict[str, Any],
) -> dict[str, Any]:
    """Summarize wholly uncharacterized input mass without calling it accuracy."""

    total_input_mass = Decimal(nutrition["input_mass_g"])
    uncharacterized: list[dict[str, Any]] = []
    uncharacterized_mass = Decimal(0)
    for leaf in nutrition["leaf_ingredients"]:
        material = nutrition_catalog["materials"][leaf["material_id"]]
        has_profile = bool(material.get("nutrients")) or material.get(
            "unlisted_nutrients_are_zero", False
        )
        if has_profile:
            continue
        mass = Decimal(leaf["mass_g"])
        uncharacterized_mass += mass
        uncharacterized.append(
            {
                "id": leaf["material_id"],
                "name": leaf["name"],
                "mass_g": decimal_string(mass),
                "input_mass_percent": decimal_string(mass / total_input_mass * Decimal(100)),
                "needed": material.get(
                    "missing_information", "Complete supplier composition specification"
                ),
            }
        )
    characterized_mass = total_input_mass - uncharacterized_mass
    return {
        "basis": report_definition.get(
            "coverage_basis", "explicitly quantified formula input mass"
        ),
        "total_input_mass_g": decimal_string(total_input_mass),
        "characterized_mass_g": decimal_string(characterized_mass),
        "uncharacterized_mass_g": decimal_string(uncharacterized_mass),
        "characterized_percent": decimal_string(
            characterized_mass / total_input_mass * Decimal(100)
        ),
        "uncharacterized_percent": decimal_string(
            uncharacterized_mass / total_input_mass * Decimal(100)
        ),
        "uncharacterized_materials": uncharacterized,
        "meaning": "profile coverage; not product accuracy or regulatory confidence",
    }


def build_product_report(
    *,
    nutrition_catalog: dict[str, Any],
    chemical_catalog: dict[str, Any],
    formula: dict[str, Any],
    report_definition: dict[str, Any],
) -> dict[str, Any]:
    """Calculate and select the configured product metrics in a stable order."""

    nutrition = calculate(nutrition_catalog, formula)
    chemical = calculate(chemical_catalog, formula)
    results = {"nutrition": nutrition, "chemical": chemical}
    indexes = {source: _by_id(result) for source, result in results.items()}

    metrics = report_definition.get("metrics", [])
    confidence_profiles = report_definition.get("confidence_profiles", {})
    required_count = int(report_definition.get("required_metric_count", 20))
    if len(metrics) != required_count:
        raise CalculationError(
            f"Product report requires exactly {required_count} metrics; received {len(metrics)}"
        )

    selected: list[dict[str, Any]] = []
    seen: set[tuple[str, str]] = set()
    for rank, specification in enumerate(metrics, start=1):
        source = specification["source"]
        metric_id = specification["id"]
        key = (source, metric_id)
        if key in seen:
            raise CalculationError(f"Duplicate product metric {source}.{metric_id}")
        seen.add(key)
        if source not in indexes or metric_id not in indexes[source]:
            raise CalculationError(f"Unknown product metric {source}.{metric_id}")
        original = indexes[source][metric_id]
        display_unit = specification.get("display_unit", original["unit"])
        per_100_ml = _convert_value(original["per_100_ml"], original["unit"], display_unit)
        profile_name = specification.get("confidence_profile")
        if profile_name not in confidence_profiles:
            raise CalculationError(f"Unknown confidence profile {profile_name!r}")
        selected.append(
            {
                "rank": rank,
                "id": metric_id,
                "name": specification.get("name", original["name"]),
                "group": specification["group"],
                "formula": original.get("formula"),
                "source_report": source,
                "unit": display_unit,
                "total_batch": _convert_value(
                    original["total_batch"], original["unit"], display_unit
                ),
                "per_100_ml": per_100_ml,
                "per_serving": _convert_value(
                    original["per_serving"], original["unit"], display_unit
                ),
                "status": specification.get("status_override", original["status"]),
                "unknown_materials": original["unknown_materials"],
                "confidence": evidence_confidence(confidence_profiles[profile_name]),
                "range": value_range(
                    _source_range(original, specification),
                    nominal=per_100_ml,
                    display_unit=display_unit,
                ),
                "contributions": _contributions(original, display_unit),
            }
        )

    ingredient_assumptions = _ingredient_assumptions(nutrition, chemical)
    warnings = [
        warning
        for warning in dict.fromkeys([*nutrition["warnings"], *chemical["warnings"]])
        if "ingredient match(es)" not in warning
    ]
    review_count = sum(item["confidence"] == "low" for item in ingredient_assumptions)
    if review_count:
        warnings.insert(0, f"{review_count} ingredient identities require review")
    return {
        "schema_version": 1,
        "report_type": "product_priority",
        "product_name": report_definition.get("product_name", formula["batch"]["name"]),
        "formula_name": formula["batch"]["name"],
        "final_volume_ml": chemical["final_volume_ml"],
        "serving": formula.get("serving"),
        "required_metric_count": required_count,
        "display_zero_metrics": report_definition.get("display_zero_metrics", True),
        "metrics": selected,
        "profile_coverage": _profile_coverage(
            nutrition, nutrition_catalog, report_definition
        ),
        "missing_information": _missing_information(
            selected,
            {"nutrition": nutrition_catalog, "chemical": chemical_catalog},
            report_definition,
        ),
        "report_assumptions": report_definition.get("assumptions", []),
        "ingredient_assumptions": ingredient_assumptions,
        "warnings": warnings,
    }
