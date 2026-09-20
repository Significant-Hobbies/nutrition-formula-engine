"""Core formulation calculator.

The engine intentionally distinguishes an explicit zero from missing data. A
missing nutrient is reported as partial coverage instead of being silently
treated as absent.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from decimal import Decimal, InvalidOperation, getcontext
from typing import Any

from .resolver import resolve_material
from .units import convert, dimension, to_mass_g, to_volume_ml

getcontext().prec = 40


class CalculationError(ValueError):
    """Raised when a formula cannot be calculated without inventing data."""


def decimal(value: Any, field_name: str) -> Decimal:
    if isinstance(value, float):
        raise CalculationError(f"{field_name} must be a JSON string or integer, not a float")
    try:
        result = Decimal(str(value))
    except (InvalidOperation, ValueError) as exc:
        raise CalculationError(f"Invalid decimal for {field_name}: {value!r}") from exc
    if not result.is_finite():
        raise CalculationError(f"{field_name} must be finite")
    return result


def decimal_string(value: Decimal) -> str:
    if value == 0:
        return "0"
    return format(value.normalize(), "f")


@dataclass
class Accumulator:
    totals: dict[str, Decimal]
    lower_totals: dict[str, Decimal]
    upper_totals: dict[str, Decimal]
    covered_mass_g: dict[str, Decimal]
    unknown_materials: dict[str, set[str]]
    sources: dict[str, set[str]]
    contributions: dict[str, list[dict[str, Any]]]
    leaf_masses_g: dict[str, Decimal] = field(default_factory=dict)
    leaf_min_masses_g: dict[str, Decimal] = field(default_factory=dict)
    leaf_max_masses_g: dict[str, Decimal] = field(default_factory=dict)

    @classmethod
    def create(cls, nutrient_ids: list[str]) -> Accumulator:
        return cls(
            totals={nutrient_id: Decimal(0) for nutrient_id in nutrient_ids},
            lower_totals={nutrient_id: Decimal(0) for nutrient_id in nutrient_ids},
            upper_totals={nutrient_id: Decimal(0) for nutrient_id in nutrient_ids},
            covered_mass_g={nutrient_id: Decimal(0) for nutrient_id in nutrient_ids},
            unknown_materials={nutrient_id: set() for nutrient_id in nutrient_ids},
            sources={nutrient_id: set() for nutrient_id in nutrient_ids},
            contributions={nutrient_id: [] for nutrient_id in nutrient_ids},
        )


def _density(material: dict[str, Any], override: Any | None = None) -> Decimal | None:
    raw = override if override is not None else material.get("density_g_per_ml")
    if raw is None:
        return None
    value = decimal(raw, "density_g_per_ml")
    if value <= 0:
        raise CalculationError("density_g_per_ml must be greater than zero")
    return value


def _source_label(material: dict[str, Any]) -> str:
    source = material.get("source", {})
    return str(source.get("reference") or source.get("kind") or "unspecified")


def _source_record(material: dict[str, Any]) -> dict[str, Any]:
    source = material.get("source", {})
    return {
        key: source[key]
        for key in (
            "kind",
            "reference",
            "id",
            "url",
            "version",
            "retrieved_at",
        )
        if source.get(key) is not None
    }


def _validate_fraction_total(material_id: str, components: list[dict[str, Any]]) -> None:
    total = sum(
        (
            decimal(component["mass_fraction"], f"{material_id}.mass_fraction")
            for component in components
        ),
        Decimal(0),
    )
    if abs(total - Decimal(1)) > Decimal("0.000000001"):
        raise CalculationError(
            f"Components of {material_id!r} must total 1 by mass; received {decimal_string(total)}"
        )


def _add_material(
    *,
    material_id: str,
    mass_g: Decimal,
    min_mass_g: Decimal,
    max_mass_g: Decimal,
    catalog: dict[str, Any],
    accumulator: Accumulator,
    path: tuple[str, ...],
    line_index: int,
    input_material_id: str,
    input_material_name: str,
) -> None:
    materials = catalog["materials"]
    if material_id not in materials:
        raise CalculationError(f"Unknown material {material_id!r}")
    if material_id in path:
        cycle = " -> ".join((*path, material_id))
        raise CalculationError(f"Compound ingredient cycle detected: {cycle}")

    material = materials[material_id]
    components = material.get("components")
    nutrients = material.get("nutrients")
    if components and nutrients:
        raise CalculationError(
            f"Material {material_id!r} cannot define both nutrients and components in v1"
        )
    if components:
        _validate_fraction_total(material_id, components)
        for component in components:
            fraction = decimal(component["mass_fraction"], f"{material_id}.mass_fraction")
            if fraction < 0:
                raise CalculationError(f"Negative component fraction in {material_id!r}")
            _add_material(
                material_id=component["material_id"],
                mass_g=mass_g * fraction,
                min_mass_g=min_mass_g * fraction,
                max_mass_g=max_mass_g * fraction,
                catalog=catalog,
                accumulator=accumulator,
                path=(*path, material_id),
                line_index=line_index,
                input_material_id=input_material_id,
                input_material_name=input_material_name,
            )
        return

    accumulator.leaf_masses_g[material_id] = (
        accumulator.leaf_masses_g.get(material_id, Decimal(0)) + mass_g
    )
    accumulator.leaf_min_masses_g[material_id] = (
        accumulator.leaf_min_masses_g.get(material_id, Decimal(0)) + min_mass_g
    )
    accumulator.leaf_max_masses_g[material_id] = (
        accumulator.leaf_max_masses_g.get(material_id, Decimal(0)) + max_mass_g
    )
    nutrient_definitions = catalog["nutrients"]
    declared_zeros = set(material.get("declared_zero_nutrients", []))
    unlisted_are_zero = material.get("unlisted_nutrients_are_zero", False)
    profile = nutrients or {}
    basis = material.get("basis")
    if not basis:
        for nutrient_id in nutrient_definitions:
            accumulator.unknown_materials[nutrient_id].add(material_id)
        return

    basis_value = decimal(basis["value"], f"{material_id}.basis.value")
    basis_unit = basis["unit"]
    if basis_value <= 0:
        raise CalculationError(f"Material {material_id!r} basis must be greater than zero")
    try:
        if dimension(basis_unit) == "mass":
            ratio = mass_g / convert(basis_value, basis_unit, "g")
            min_ratio = min_mass_g / convert(basis_value, basis_unit, "g")
            max_ratio = max_mass_g / convert(basis_value, basis_unit, "g")
        elif dimension(basis_unit) == "volume":
            volume_ml = to_volume_ml(mass_g, "g", _density(material))
            min_volume_ml = to_volume_ml(min_mass_g, "g", _density(material))
            max_volume_ml = to_volume_ml(max_mass_g, "g", _density(material))
            ratio = volume_ml / convert(basis_value, basis_unit, "ml")
            min_ratio = min_volume_ml / convert(basis_value, basis_unit, "ml")
            max_ratio = max_volume_ml / convert(basis_value, basis_unit, "ml")
        else:
            raise CalculationError(f"Unsupported basis unit {basis_unit!r} for {material_id!r}")
    except ValueError as exc:
        raise CalculationError(str(exc)) from exc

    source_label = _source_label(material)
    for nutrient_id, definition in nutrient_definitions.items():
        if nutrient_id in profile:
            nutrient = profile[nutrient_id]
            nutrient_value = decimal(nutrient["value"], f"{material_id}.{nutrient_id}.value")
            nutrient_minimum = decimal(
                nutrient.get("minimum", nutrient["value"]),
                f"{material_id}.{nutrient_id}.minimum",
            )
            nutrient_maximum = decimal(
                nutrient.get("maximum", nutrient["value"]),
                f"{material_id}.{nutrient_id}.maximum",
            )
            if not nutrient_minimum <= nutrient_value <= nutrient_maximum:
                raise CalculationError(
                    f"{material_id}.{nutrient_id} requires minimum <= value <= maximum"
                )
            try:
                canonical_value = convert(nutrient_value, nutrient["unit"], definition["unit"])
                canonical_minimum = convert(nutrient_minimum, nutrient["unit"], definition["unit"])
                canonical_maximum = convert(nutrient_maximum, nutrient["unit"], definition["unit"])
            except ValueError as exc:
                raise CalculationError(
                    f"Invalid unit for {material_id}.{nutrient_id}: {exc}"
                ) from exc
            accumulator.totals[nutrient_id] += canonical_value * ratio
            accumulator.lower_totals[nutrient_id] += canonical_minimum * min_ratio
            accumulator.upper_totals[nutrient_id] += canonical_maximum * max_ratio
            accumulator.covered_mass_g[nutrient_id] += mass_g
            accumulator.sources[nutrient_id].add(source_label)
            accumulator.contributions[nutrient_id].append(
                {
                    "line_index": line_index,
                    "input_material_id": input_material_id,
                    "input_material_name": input_material_name,
                    "material_id": material_id,
                    "material_name": material["name"],
                    "material_path": [*path, material_id],
                    "input_mass_g": decimal_string(mass_g),
                    "minimum_input_mass_g": decimal_string(min_mass_g),
                    "maximum_input_mass_g": decimal_string(max_mass_g),
                    "profile_basis": {
                        "value": decimal_string(basis_value),
                        "unit": basis_unit,
                    },
                    "profile_value": decimal_string(nutrient_value),
                    "profile_minimum": decimal_string(nutrient_minimum),
                    "profile_maximum": decimal_string(nutrient_maximum),
                    "profile_unit": nutrient["unit"],
                    "total_batch": decimal_string(canonical_value * ratio),
                    "minimum_total_batch": decimal_string(canonical_minimum * min_ratio),
                    "maximum_total_batch": decimal_string(canonical_maximum * max_ratio),
                    "unit": definition["unit"],
                    "source": _source_record(material),
                }
            )
        elif nutrient_id in declared_zeros or unlisted_are_zero:
            accumulator.covered_mass_g[nutrient_id] += mass_g
            accumulator.sources[nutrient_id].add(source_label)
        else:
            accumulator.unknown_materials[nutrient_id].add(material_id)


def _quantity_values(quantity: dict[str, Any], field_name: str) -> tuple[Decimal, Decimal, Decimal]:
    value = decimal(quantity["value"], f"{field_name}.value")
    minimum = decimal(quantity.get("minimum", quantity["value"]), f"{field_name}.minimum")
    maximum = decimal(quantity.get("maximum", quantity["value"]), f"{field_name}.maximum")
    if minimum < 0:
        raise CalculationError(f"{field_name} cannot be negative")
    if not minimum <= value <= maximum:
        raise CalculationError(f"{field_name} requires minimum <= value <= maximum")
    return value, minimum, maximum


def _quantity_mass_range(
    quantity: dict[str, Any], material: dict[str, Any], field_name: str
) -> tuple[Decimal, Decimal, Decimal]:
    value, minimum, maximum = _quantity_values(quantity, field_name)
    try:
        density = _density(material, quantity.get("density_g_per_ml"))
        return (
            to_mass_g(value, quantity["unit"], density),
            to_mass_g(minimum, quantity["unit"], density),
            to_mass_g(maximum, quantity["unit"], density),
        )
    except ValueError as exc:
        raise CalculationError(str(exc)) from exc


def _final_dimensions(
    batch: dict[str, Any],
) -> tuple[
    Decimal | None,
    Decimal | None,
    Decimal | None,
    Decimal | None,
    Decimal | None,
    Decimal | None,
]:
    final_quantity = batch["final_quantity"]
    value, minimum, maximum = _quantity_values(final_quantity, "batch.final_quantity")
    if minimum <= 0:
        raise CalculationError("batch.final_quantity must be greater than zero")
    unit = final_quantity["unit"]
    density_value = batch.get("final_density_g_per_ml")
    density = decimal(density_value, "batch.final_density_g_per_ml") if density_value else None
    if density is not None and density <= 0:
        raise CalculationError("batch.final_density_g_per_ml must be greater than zero")
    if dimension(unit) == "mass":
        mass_g = convert(value, unit, "g")
        min_mass_g = convert(minimum, unit, "g")
        max_mass_g = convert(maximum, unit, "g")
        volume_ml = mass_g / density if density else None
        min_volume_ml = min_mass_g / density if density else None
        max_volume_ml = max_mass_g / density if density else None
        return mass_g, volume_ml, min_mass_g, max_mass_g, min_volume_ml, max_volume_ml
    if dimension(unit) == "volume":
        volume_ml = convert(value, unit, "ml")
        min_volume_ml = convert(minimum, unit, "ml")
        max_volume_ml = convert(maximum, unit, "ml")
        mass_g = volume_ml * density if density else None
        min_mass_g = min_volume_ml * density if density else None
        max_mass_g = max_volume_ml * density if density else None
        return mass_g, volume_ml, min_mass_g, max_mass_g, min_volume_ml, max_volume_ml
    raise CalculationError(f"Unsupported final quantity unit {unit!r}")


def _scaled(total: Decimal, numerator: Decimal | None, denominator: Decimal | None) -> str | None:
    if numerator is None or denominator is None:
        return None
    return decimal_string(total * numerator / denominator)


def _range_result(
    *,
    lower_total: Decimal,
    upper_total: Decimal,
    numerator: Decimal,
    denominator_minimum: Decimal | None,
    denominator_maximum: Decimal | None,
    complete: bool,
) -> dict[str, str | None] | None:
    if denominator_minimum is None or denominator_maximum is None:
        return None
    lower = lower_total * numerator / denominator_maximum
    upper = upper_total * numerator / denominator_minimum
    if not complete:
        return {"kind": "lower_bound", "lower": decimal_string(lower), "upper": None}
    if lower == upper:
        return {
            "kind": "point",
            "lower": decimal_string(lower),
            "upper": decimal_string(upper),
        }
    return {
        "kind": "bounded",
        "lower": decimal_string(lower),
        "upper": decimal_string(upper),
    }


def calculate(catalog: dict[str, Any], formula: dict[str, Any]) -> dict[str, Any]:
    """Calculate a formula and return a JSON-serializable result."""

    if catalog.get("schema_version") != 1 or formula.get("schema_version") != 1:
        raise CalculationError("Only schema_version 1 is supported")
    nutrient_ids = list(catalog.get("nutrients", {}))
    if not nutrient_ids:
        raise CalculationError("Catalog must define at least one nutrient")
    accumulator = Accumulator.create(nutrient_ids)
    total_input_mass_g = Decimal(0)
    min_input_mass_g = Decimal(0)
    max_input_mass_g = Decimal(0)
    assumptions: list[dict[str, Any]] = []

    for index, line in enumerate(formula.get("ingredients", [])):
        material_id = line.get("material_id")
        if material_id is None:
            query = line.get("ingredient")
            if not query:
                raise CalculationError(
                    f"ingredients[{index}] requires either material_id or ingredient"
                )
            try:
                material_id, assumption = resolve_material(catalog, query)
            except ValueError as exc:
                raise CalculationError(str(exc)) from exc
            assumption["line_index"] = index
            assumptions.append(assumption)
        material = catalog.get("materials", {}).get(material_id)
        if material is None:
            raise CalculationError(f"Unknown material {material_id!r}")
        mass_g, min_mass_g, max_mass_g = _quantity_mass_range(
            line["quantity"], material, f"ingredients[{index}].quantity"
        )
        total_input_mass_g += mass_g
        min_input_mass_g += min_mass_g
        max_input_mass_g += max_mass_g
        _add_material(
            material_id=material_id,
            mass_g=mass_g,
            min_mass_g=min_mass_g,
            max_mass_g=max_mass_g,
            catalog=catalog,
            accumulator=accumulator,
            path=(),
            line_index=index,
            input_material_id=material_id,
            input_material_name=material["name"],
        )
    if total_input_mass_g <= 0:
        raise CalculationError("Formula must contain a positive ingredient quantity")

    batch = formula["batch"]
    (
        final_mass_g,
        final_volume_ml,
        min_final_mass_g,
        max_final_mass_g,
        min_final_volume_ml,
        max_final_volume_ml,
    ) = _final_dimensions(batch)
    retention = formula.get("nutrient_retention", {})
    warnings: list[str] = []
    low_confidence = [item for item in assumptions if item["confidence"] == "low"]
    if low_confidence:
        warnings.append(
            f"{len(low_confidence)} ingredient match(es) have low confidence; review assumptions"
        )
    if final_mass_g is None:
        warnings.append("Per-100-g and mass-yield values are unavailable without final density")
    elif final_mass_g > total_input_mass_g * Decimal("1.02"):
        warnings.append(
            "Final mass is more than 2% above total input mass; verify added process water or density"
        )
    elif final_mass_g < total_input_mass_g * Decimal("0.98"):
        warnings.append(
            "Final mass is more than 2% below total input mass; verify process loss or evaporation"
        )

    serving_mass_g: Decimal | None = None
    serving_volume_ml: Decimal | None = None
    serving = formula.get("serving")
    if serving:
        serving_value = decimal(serving["value"], "serving.value")
        try:
            if dimension(serving["unit"]) == "mass":
                serving_mass_g = convert(serving_value, serving["unit"], "g")
                if batch.get("final_density_g_per_ml"):
                    serving_volume_ml = serving_mass_g / decimal(
                        batch["final_density_g_per_ml"], "batch.final_density_g_per_ml"
                    )
            elif dimension(serving["unit"]) == "volume":
                serving_volume_ml = convert(serving_value, serving["unit"], "ml")
                if batch.get("final_density_g_per_ml"):
                    serving_mass_g = serving_volume_ml * decimal(
                        batch["final_density_g_per_ml"], "batch.final_density_g_per_ml"
                    )
        except ValueError as exc:
            raise CalculationError(str(exc)) from exc

    nutrient_results: list[dict[str, Any]] = []
    for nutrient_id, definition in catalog["nutrients"].items():
        factor = decimal(retention.get(nutrient_id, "1"), f"retention.{nutrient_id}")
        if factor < 0:
            raise CalculationError(f"Retention factor for {nutrient_id!r} cannot be negative")
        total = accumulator.totals[nutrient_id] * factor
        lower_total = accumulator.lower_totals[nutrient_id] * factor
        upper_total = accumulator.upper_totals[nutrient_id] * factor
        covered = min(accumulator.covered_mass_g[nutrient_id], total_input_mass_g)
        coverage_percent = covered / total_input_mass_g * Decimal(100)
        complete = abs(covered - total_input_mass_g) <= Decimal("0.000001")
        contributions = []
        for contribution in accumulator.contributions[nutrient_id]:
            contribution_total = Decimal(contribution["total_batch"]) * factor
            contribution_lower = Decimal(contribution["minimum_total_batch"]) * factor
            contribution_upper = Decimal(contribution["maximum_total_batch"]) * factor
            contributions.append(
                {
                    **contribution,
                    "total_batch": decimal_string(contribution_total),
                    "minimum_total_batch": decimal_string(contribution_lower),
                    "maximum_total_batch": decimal_string(contribution_upper),
                    "per_100_g": _scaled(contribution_total, Decimal(100), final_mass_g),
                    "per_100_ml": _scaled(contribution_total, Decimal(100), final_volume_ml),
                    "per_serving": _scaled(contribution_total, serving_mass_g, final_mass_g)
                    if final_mass_g is not None
                    else _scaled(contribution_total, serving_volume_ml, final_volume_ml),
                    "retention_factor": decimal_string(factor),
                }
            )
        reconciled_total = sum(
            (Decimal(item["total_batch"]) for item in contributions), Decimal(0)
        )
        if reconciled_total != total:
            raise CalculationError(
                f"Contribution ledger for {nutrient_id!r} does not reconcile to its total"
            )
        nutrient_results.append(
            {
                "id": nutrient_id,
                "name": definition["name"],
                "class": definition["class"],
                "unit": definition["unit"],
                "formula": definition.get("formula"),
                "identifier": definition.get("identifier"),
                "total_batch": decimal_string(total),
                "total_batch_range": {
                    "kind": "bounded"
                    if complete and lower_total != upper_total
                    else "point"
                    if complete
                    else "lower_bound",
                    "lower": decimal_string(lower_total),
                    "upper": decimal_string(upper_total) if complete else None,
                },
                "per_100_g": _scaled(total, Decimal(100), final_mass_g),
                "per_100_ml": _scaled(total, Decimal(100), final_volume_ml),
                "per_100_g_range": _range_result(
                    lower_total=lower_total,
                    upper_total=upper_total,
                    numerator=Decimal(100),
                    denominator_minimum=min_final_mass_g,
                    denominator_maximum=max_final_mass_g,
                    complete=complete,
                ),
                "per_100_ml_range": _range_result(
                    lower_total=lower_total,
                    upper_total=upper_total,
                    numerator=Decimal(100),
                    denominator_minimum=min_final_volume_ml,
                    denominator_maximum=max_final_volume_ml,
                    complete=complete,
                ),
                "per_serving": _scaled(total, serving_mass_g, final_mass_g)
                if final_mass_g is not None
                else _scaled(total, serving_volume_ml, final_volume_ml),
                "coverage_percent": decimal_string(coverage_percent),
                "status": "complete" if complete else "partial",
                "unknown_materials": sorted(accumulator.unknown_materials[nutrient_id]),
                "sources": sorted(accumulator.sources[nutrient_id]),
                "retention_factor": decimal_string(factor),
                "contributions": contributions,
            }
        )

    leaf_ingredients = []
    for material_id, mass_g in sorted(
        accumulator.leaf_masses_g.items(), key=lambda item: (-item[1], item[0])
    ):
        leaf_ingredients.append(
            {
                "material_id": material_id,
                "name": catalog["materials"][material_id]["name"],
                "mass_g": decimal_string(mass_g),
                "minimum_mass_g": decimal_string(accumulator.leaf_min_masses_g[material_id]),
                "maximum_mass_g": decimal_string(accumulator.leaf_max_masses_g[material_id]),
                "input_mass_percent": decimal_string(mass_g / total_input_mass_g * Decimal(100)),
            }
        )

    return {
        "schema_version": 1,
        "formula_name": batch["name"],
        "calculation_type": catalog.get("calculation_type", "theoretical_from_supplied_profiles"),
        "report_type": catalog.get("report_type", "nutrition"),
        "item_label": catalog.get("item_label", "Nutrient"),
        "input_mass_g": decimal_string(total_input_mass_g),
        "minimum_input_mass_g": decimal_string(min_input_mass_g),
        "maximum_input_mass_g": decimal_string(max_input_mass_g),
        "final_mass_g": decimal_string(final_mass_g) if final_mass_g is not None else None,
        "final_volume_ml": decimal_string(final_volume_ml) if final_volume_ml is not None else None,
        "mass_yield_percent": decimal_string(final_mass_g / total_input_mass_g * Decimal(100))
        if final_mass_g is not None
        else None,
        "serving": serving,
        "assumptions": assumptions,
        "leaf_ingredients": leaf_ingredients,
        "nutrients": nutrient_results,
        "warnings": warnings,
    }
