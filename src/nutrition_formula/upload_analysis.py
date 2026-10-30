"""Upload-to-report orchestration for the single-input web workflow."""

from __future__ import annotations

from .input_provenance import validate_input_provenance, provenance_markdown

import json
from copy import deepcopy
from decimal import Decimal
from pathlib import Path
from typing import Any

from .confidence import evidence_confidence
from .engine import CalculationError, calculate, decimal_string
from .material_profiles import merge_material_profiles
from .product_report import build_product_report
from .resolver import normalize_name, resolve_material
from .tsv import FormulaUploadError, parse_formula_tsv
from .units import to_mass_g
from .versioning import ENGINE_VERSION, fingerprint

DATA_ROOT = Path(__file__).resolve().parent / "data"
NUTRITION_CATALOG_PATH = DATA_ROOT / "catalog.json"
CHEMICAL_CATALOG_PATH = DATA_ROOT / "chemical_catalog.json"
TONIC_REPORT_PATH = DATA_ROOT / "user_tonic_top30.json"

STANDARD_METRIC_IDS = [
    "energy",
    "protein",
    "carbohydrate",
    "total_sugars",
    "added_sugars",
    "dietary_fibre",
    "total_fat",
    "saturated_fat",
    "trans_fat",
    "sodium",
    "iron",
    "zinc",
    "calcium",
    "magnesium",
    "potassium",
    "phosphorus",
    "copper",
    "manganese",
    "selenium",
    "vitamin_a_rae",
    "vitamin_c",
    "vitamin_d",
    "vitamin_e",
    "vitamin_k",
    "thiamin",
    "riboflavin",
    "niacin",
    "vitamin_b6",
    "folic_acid",
    "vitamin_b12",
]

ASSUMED_IDENTITIES = {
    "nepazene": {
        "material_id": "sodium_methylparaben_assumed",
        "selected_name": "Sodium methylparaben",
        "reason": "First-ranked interpretation of the submitted trade name",
        "alternatives": ["Methylparaben", "Paraben preservative blend"],
    },
    "nepazine": {
        "material_id": "sodium_methylparaben_assumed",
        "selected_name": "Sodium methylparaben",
        "reason": "First-ranked interpretation of the likely misspelled trade name",
        "alternatives": ["Methylparaben", "Paraben preservative blend"],
    },
}

# A bounded recipe default, below explicit accepted/profile alias decisions.
# Generic sugar continues to use its USDA profile in every other formula.
SUGARED_MULTIVITAMIN_NAMES = {
    normalize_name(name) for name in (
        "Vitamin C (Ascorbic acid)", "Vitamin B3 (Nicotinamide)",
        "Vitamin B5 (D-Panthenol)", "Vitamin B2 (Riboflavin sodium phosphate)",
        "Vitamin B1 (Thiamine hydrochloride)", "Vitamin B6 (Pyridoxine hydrochloride)",
        "Vitamin B12 (Cyanocobalamin)", "Zinc (as Zinc sulfate)",
        "Iodine (as potassium iodide)", "SUGAR", "NEPAZENE", "NEPASOL",
        "BRONOPAL", "SOD BENZ", "BENZOIC ACID",
    )
}


def _load_json(path: Path) -> dict[str, Any]:
    with path.open(encoding="utf-8") as handle:
        return json.load(handle)


def _apply_visible_assumptions(formula: dict[str, Any]) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    calculated_formula = deepcopy(formula)
    assumptions: list[dict[str, Any]] = []
    for line_index, line in enumerate(calculated_formula["ingredients"]):
        if line.get("material_id"):
            continue
        query = line.get("ingredient")
        if not query:
            continue
        configured = ASSUMED_IDENTITIES.get(normalize_name(query))
        if configured is None:
            continue
        line.pop("ingredient")
        line["material_id"] = configured["material_id"]
        assumptions.append(
            {
                "line_index": line_index,
                "query": query,
                "selected_material_id": configured["material_id"],
                "selected_name": configured["selected_name"],
                "confidence": "low",
                "score": "0.600000",
                "reason": configured["reason"],
                "alternatives": configured["alternatives"],
                "correction": "Confirm this identity or select a different candidate",
            }
        )
    return calculated_formula, assumptions


def _apply_accepted_aliases(
    formula: dict[str, Any], catalog: dict[str, Any], accepted_aliases: dict[str, str]
) -> dict[str, Any]:
    resolved = deepcopy(formula)
    for line in resolved["ingredients"]:
        query = line.get("ingredient")
        if not query:
            continue
        material_id = accepted_aliases.get(normalize_name(query))
        if material_id not in catalog["materials"]:
            continue
        line.pop("ingredient")
        line["material_id"] = material_id
    return resolved


def _retain_unresolved_ingredients(
    formula: dict[str, Any], catalog: dict[str, Any]
) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    """Retain unidentified mass inputs as unknown composition, never a substitute."""
    unresolved = []
    for index, line in enumerate(formula["ingredients"]):
        query = line.get("ingredient")
        if not query:
            material = catalog["materials"].get(line.get("material_id"), {})
            if line["quantity"]["unit"] in {"l", "ml"} and not material.get("density_g_per_ml"):
                raise FormulaUploadError(
                    f"{material.get('name', line.get('material_id'))}: supplier density in g/mL "
                    "or a measured mass is required to convert this ingredient volume."
                )
            continue
        try:
            # Weak lexical resemblance is a search suggestion, not ingredient
            # composition. In particular an unidentified carrier is not water.
            if {"unknown", "unidentified"} & set(normalize_name(query).split()):
                raise ValueError("The supplied identity is explicitly unknown")
            resolved_id, _ = resolve_material(catalog, query, minimum_score=0.72)
        except ValueError:
            material_id = f"unresolved_input_{index}"
            catalog["materials"][material_id] = {
                "name": query,
                "nutrients": {},
                "identity_status": "unresolved",
                "source": {"kind": "unresolved_input", "reference": "Submitted name; no catalog identity selected"},
                "missing_information": "Provide the exact ingredient identity, supplier grade, full nutrient/carrier composition and lot CoA. Unreported nutrients remain unknown.",
            }
            if line["quantity"]["unit"] in {"l", "ml"}:
                raise FormulaUploadError(
                    f"{query}: identity and density are missing. Request the supplier density in g/mL "
                    "or enter its measured mass before calculating; volume cannot be assumed to equal mass."
                )
            line.pop("ingredient")
            line["material_id"] = material_id
            unresolved.append({
                "line_index": index, "query": query,
                "selected_material_id": material_id, "selected_name": query,
                "confidence": "low", "score": "0", "alternatives": [],
                "reason": "No catalog identity selected; all nutrient composition remains unknown",
            })
        else:
            if line["quantity"]["unit"] in {"l", "ml"} and not catalog["materials"][resolved_id].get("density_g_per_ml"):
                raise FormulaUploadError(
                    f"{query}: supplier density in g/mL or a measured mass is required "
                    "to convert this ingredient volume."
                )
    return formula, unresolved


def _overall_confidence(assumptions: list[dict[str, Any]]) -> dict[str, Any]:
    levels = {item["confidence"] for item in assumptions}
    identity = "scenario" if "low" in levels else "reference" if "medium" in levels else "specified"
    return evidence_confidence(
        {
            "identity": identity,
            "composition": "reference",
            "quantity": "specified",
            "yield": "scenario",
        }
    )


def _range_label(metric: dict[str, Any]) -> str | None:
    value_range = metric["range"]
    if value_range["kind"] == "bounded":
        return f"{value_range['lower']}–{value_range['upper']} {value_range['unit']}"
    if value_range["kind"] == "lower_bound":
        return f"at least {value_range['lower']} {value_range['unit']}"
    return None


def _specialized_metrics(report: dict[str, Any]) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    screened: list[dict[str, Any]] = []
    for metric in report["metrics"]:
        row = {
            "id": metric["id"],
            "name": metric["name"],
            "value": metric["per_100_ml"],
            "unit": metric["unit"],
            "range": metric["range"],
            "range_label": _range_label(metric),
            "confidence": metric["confidence"],
            "status": metric["status"],
            "unknown_materials": metric["unknown_materials"],
            "contributions": metric.get("contributions", []),
        }
        screened.append(row)
    return [row for row in screened if Decimal(row["value"]) != 0], screened


def _generic_metrics(
    nutrition: dict[str, Any], assumptions: list[dict[str, Any]], basis_key: str
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    by_id = {item["id"]: item for item in nutrition["nutrients"]}
    confidence = _overall_confidence(assumptions)
    range_key = f"{basis_key}_range"
    screened: list[dict[str, Any]] = []
    # Keep the standard screen, and retain calculated actives outside that list.
    extra_ids = [item['id'] for item in nutrition['nutrients']
                 if item['id'] not in STANDARD_METRIC_IDS
                 and item[basis_key] is not None and Decimal(item[basis_key]) != 0]
    for metric_id in [*STANDARD_METRIC_IDS, *extra_ids]:
        original = by_id[metric_id]
        value = original[basis_key]
        if value is None:
            continue
        source_range = original[range_key]
        if source_range is None or source_range["kind"] == "point":
            normalized_range = {
                "kind": "not_estimated",
                "lower": None,
                "upper": None,
                "unit": original["unit"],
                "basis": "Supplier assay and process tolerance were not supplied",
            }
        else:
            normalized_range = {
                **source_range,
                "unit": original["unit"],
                "basis": "Propagated from the supplied profile and formula bounds",
            }
        row = {
            "id": metric_id,
            "name": original["name"],
            "value": value,
            "total_batch": original["total_batch"],
            "unit": original["unit"],
            "range": normalized_range,
            "range_label": _range_label({"range": normalized_range}),
            "confidence": confidence,
            "status": original["status"],
            "unknown_materials": original["unknown_materials"],
            "contributions": original.get("contributions", []),
        }
        screened.append(row)
    return [row for row in screened if Decimal(row["value"]) != 0], screened


def _coverage(nutrition: dict[str, Any], catalog: dict[str, Any]) -> dict[str, Any]:
    total = Decimal(nutrition["input_mass_g"])
    missing: list[dict[str, Any]] = []
    missing_mass = Decimal(0)
    for leaf in nutrition["leaf_ingredients"]:
        material = catalog["materials"][leaf["material_id"]]
        characterized = bool(material.get("nutrients")) or material.get(
            "unlisted_nutrients_are_zero", False
        )
        if characterized:
            continue
        mass = Decimal(leaf["mass_g"])
        missing_mass += mass
        missing.append(
            {
                "name": leaf["name"],
                "mass_g": leaf["mass_g"],
                "percent": decimal_string(mass / total * Decimal(100)),
            }
        )
    return {
        "characterized_percent": decimal_string((total - missing_mass) / total * Decimal(100)),
        "uncharacterized_percent": decimal_string(missing_mass / total * Decimal(100)),
        "uncharacterized_mass_g": decimal_string(missing_mass),
        "uncharacterized_materials": missing,
        "basis": "explicitly quantified formula input mass",
    }


def _missing_information(
    screened: list[dict[str, Any]], catalog: dict[str, Any]
) -> list[dict[str, Any]]:
    affected: dict[str, set[str]] = {}
    for metric in screened:
        for material_id in metric["unknown_materials"]:
            affected.setdefault(material_id, set()).add(metric["name"])
    result = []
    for material_id, names in affected.items():
        material = catalog["materials"][material_id]
        result.append(
            {
                "item": material["name"],
                "needed": material.get(
                    "missing_information", "Complete supplier composition specification"
                ),
                "affects": sorted(names),
            }
        )
    return result


def _interpretations(
    rows: list[dict[str, Any]],
    formula: dict[str, Any],
    nutrition: dict[str, Any],
    catalog: dict[str, Any],
    visible_assumptions: list[dict[str, Any]],
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    def alternative_names(assumption: dict[str, Any] | None) -> list[str]:
        if assumption is None:
            return []
        names: list[str] = []
        for candidate in assumption.get("identity_candidates", []):
            if isinstance(candidate, dict):
                name = candidate.get("identity") or candidate.get("name")
            else:
                name = str(candidate)
            if name:
                names.append(name)
        for candidate in assumption.get("alternatives", []):
            name = candidate.get("name") if isinstance(candidate, dict) else str(candidate)
            if name:
                names.append(name)
        selected = assumption.get("selected_name")
        return list(dict.fromkeys(name for name in names if name != selected))[:5]

    assumptions = [*nutrition["assumptions"], *visible_assumptions]
    by_line = {item["line_index"]: item for item in assumptions}
    result = [
        {
            **rows[0],
            "interpretation": "Final batch basis",
            "confidence": "exact",
            "needs_review": False,
            "alternatives": [],
        }
    ]
    for line_index, (row, line) in enumerate(zip(rows[1:], formula["ingredients"], strict=True)):
        assumption = by_line.get(line_index)
        material_id = line.get("material_id") or (
            assumption["selected_material_id"] if assumption else None
        )
        material = catalog["materials"].get(material_id, {})
        source = material.get("source", {})
        result.append(
            {
                **row,
                "interpretation": assumption["selected_name"]
                if assumption
                else material.get("name", row["item"]),
                "material_id": material_id,
                "confidence": assumption["confidence"] if assumption else "exact",
                "source": source.get("reference", "Local accepted profile"),
                "identity_note": material.get("identity_note"),
                "profile_version": source.get("accepted_profile_version"),
                "reusable_profile": bool(material.get("nutrients") or material.get("components")),
                "needs_review": bool(assumption and assumption["confidence"] != "exact"),
                "unresolved": source.get("kind") == "unresolved_input",
                "alternatives": alternative_names(assumption),
            }
        )
    return result, assumptions


def _product_inference(present: list[dict[str, Any]], material_ids: set[str]) -> dict[str, Any]:
    metric_ids = {item["id"] for item in present}
    if {
        "ferric_ammonium_citrate_brown_mid",
        "folic_acid_pure",
        "cyanocobalamin_pure",
    }.issubset(material_ids):
        return {
            "name": "Oral haematinic syrup/tonic",
            "confidence": "80%",
            "reason": "Iron, folic acid and vitamin B12 appear in a sweetened flavoured base.",
            "boundary": "The formula alone does not establish human versus veterinary use.",
        }
    if {"protein", "carbohydrate", "total_fat"} & metric_ids:
        return {
            "name": "Food or beverage formulation",
            "confidence": "moderate",
            "reason": "The calculated result is led by conventional macronutrients.",
            "boundary": "Product category and regulatory status require intended use and claims.",
        }
    return {
        "name": "Nutrient or medicinal formulation",
        "confidence": "low",
        "reason": "The detected profile is led by isolated nutrients or chemical ingredients.",
        "boundary": "Intended use, dose and label claims are needed for a narrower classification.",
    }


def _escape(value: Any) -> str:
    return str(value).replace("|", "\\|").replace("\n", " ")


def _markdown(result: dict[str, Any]) -> str:
    lines = [
        f"# {_escape(result['product_name'])}",
        "",
        "## Likely product",
        "",
        (
            f"**{_escape(result['product_inference']['name'])}** "
            f"(confidence: {_escape(result['product_inference']['confidence'])}). "
            f"{_escape(result['product_inference']['reason'])} "
            f"{_escape(result['product_inference']['boundary'])}"
        ),
        "",
        "## Submitted formula and interpretation",
        "",
        "| Item | Submitted | Normalized equivalent | Interpretation |",
        "|---|---:|---:|---|",
    ]
    for row in result["formula_rows"]:
        lines.append(
            "| {item} | {quantity} {unit} | {equivalent} | {interpretation} |".format(
                item=_escape(row["item"]),
                quantity=_escape(row["submitted_quantity"]),
                unit=_escape(row["submitted_unit"]),
                equivalent=_escape(row["normalized_equivalent"]),
                interpretation=_escape(row["interpretation"]),
            )
        )
    lines.extend(
        [
            "",
            "## Present macro- and micronutrients",
            "",
            f"Values are theoretical {_escape(result['basis_label'])}.",
            "",
            "| Component | Amount | Plausible range | Evidence |",
            "|---|---:|---|---|",
        ]
    )
    for metric in result["present_components"]:
        lines.append(
            "| {name} | {value} {unit} | {range_} | {score} {band} |".format(
                name=_escape(metric["name"]),
                value=_escape(("≥" if metric["status"] == "partial" else "") + metric["value"]),
                unit=_escape(metric["unit"]),
                range_=_escape(metric["range_label"] or "—"),
                score=_escape(metric["confidence"]["score"]),
                band=_escape(metric["confidence"]["band"]),
            )
        )
    lines.extend(["", "## Calculation contributions", ""])
    for metric in result["present_components"]:
        if not metric.get("contributions"):
            continue
        lines.append(f"### {_escape(metric['name'])}")
        lines.append("")
        for contribution in metric["contributions"]:
            value = contribution.get(
                "per_100_ml" if result["basis_label"] == "per 100 mL" else "per_100_g"
            )
            if value is None or Decimal(value) == 0:
                continue
            source = contribution.get("source", {})
            source_label = source.get("reference") or source.get("kind") or "Unspecified source"
            lines.append(
                "- {material}: {value} {unit} ({source})".format(
                    material=_escape(contribution["material_name"]),
                    value=_escape(value),
                    unit=_escape(contribution["unit"]),
                    source=_escape(source_label),
                )
            )
    lines.extend(["", "## Assumptions", ""])
    lines.extend(f"- {_escape(item)}" for item in result["report_assumptions"])
    if result["missing_information"]:
        lines.extend(["", "## Information still needed", ""])
        for item in result["missing_information"]:
            lines.append(f"- **{_escape(item['item'])}:** {_escape(item['needed'])}")
    lines.extend(
        [
            "",
            "This is a theoretical composition calculation, not a laboratory assay or regulatory approval.",
        ]
    )
    return "\n".join(lines) + "\n"


def analyze_formula_upload(
    text: str,
    file_name: str,
    *,
    accepted_profiles: list[dict[str, Any]] | None = None,
    accepted_aliases: dict[str, str] | None = None,
    input_provenance: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Parse one TSV upload and return a concise, auditable composition report."""

    parsed = parse_formula_tsv(text, file_name)
    input_provenance = validate_input_provenance(input_provenance, len(parsed["rows"]))
    submitted_formula = parsed["formula"]
    nutrition_catalog = _load_json(NUTRITION_CATALOG_PATH)
    chemical_catalog = _load_json(CHEMICAL_CATALOG_PATH)
    nutrition_catalog, profile_aliases = merge_material_profiles(
        nutrition_catalog, accepted_profiles or []
    )
    requested_aliases = {
        normalize_name(alias): material_id
        for alias, material_id in (accepted_aliases or {}).items()
        if material_id in nutrition_catalog["materials"]
    }
    ingredient_names = {
        normalize_name(line.get("ingredient", "")) for line in submitted_formula["ingredients"]
    }
    recipe_aliases = (
        {"sugar": "sucrose_pure_assumed"}
        if len(submitted_formula["ingredients"]) == len(SUGARED_MULTIVITAMIN_NAMES)
        and ingredient_names == SUGARED_MULTIVITAMIN_NAMES else {}
    )
    formula_with_aliases = _apply_accepted_aliases(
        submitted_formula,
        nutrition_catalog,
        {**recipe_aliases, **requested_aliases, **profile_aliases},
    )
    formula, visible_assumptions = _apply_visible_assumptions(formula_with_aliases)
    formula, unresolved_assumptions = _retain_unresolved_ingredients(formula, nutrition_catalog)
    visible_assumptions.extend(unresolved_assumptions)

    try:
        nutrition = calculate(nutrition_catalog, formula)
    except CalculationError as exc:
        raise FormulaUploadError(str(exc)) from exc

    formula_rows, ingredient_assumptions = _interpretations(
        parsed["rows"], formula, nutrition, nutrition_catalog, visible_assumptions
    )
    basis_key = "per_100_ml" if nutrition["final_volume_ml"] is not None else "per_100_g"
    basis_label = "per 100 mL" if basis_key == "per_100_ml" else "per 100 g"

    specialized_report = None
    if basis_key == "per_100_ml":
        try:
            definition = _load_json(TONIC_REPORT_PATH)
            definition["product_name"] = submitted_formula["batch"]["name"]
            specialized_report = build_product_report(
                nutrition_catalog=nutrition_catalog,
                chemical_catalog=chemical_catalog,
                formula=formula,
                report_definition=definition,
            )
        except CalculationError:
            specialized_report = None

    if specialized_report is not None:
        present, screened = _specialized_metrics(specialized_report)
        coverage = specialized_report["profile_coverage"]
        missing_information = specialized_report["missing_information"]
        report_assumptions = specialized_report["report_assumptions"]
        warnings = specialized_report["warnings"]
    else:
        present, screened = _generic_metrics(nutrition, ingredient_assumptions, basis_key)
        coverage = _coverage(nutrition, nutrition_catalog)
        missing_information = _missing_information(screened, nutrition_catalog)
        report_assumptions = [
            f"Values are theoretical {basis_label} from the uploaded final-batch quantity.",
            "Ingredient identities are selected from the current local catalog; review every non-exact match.",
            "Only non-zero components are shown; screened zero fields remain in the analysis data.",
            "Supplier specifications, lot assays, actual yield and process retention were not supplied unless stated.",
        ]
        warnings = nutrition["warnings"]

    warnings = [warning for warning in warnings if "ingredient identities require review" not in warning]
    review_count = sum(bool(row.get("needs_review")) for row in formula_rows)
    if review_count:
        warnings.insert(0, f"{review_count} ingredient identities require review")

    material_ids = {row.get("material_id") for row in formula_rows if row.get("material_id")}
    # Retain weighed non-nutrient ingredients without inventing active equivalents.
    label_entries = []
    declared_nutrient_ids = set()
    for row in formula_rows[1:]:
        material = nutrition_catalog["materials"].get(row.get("material_id"), {})
        declared_nutrient_ids.update(material.get("nutrients", {}))
        if material.get("label_category"):
            label_entries.append({
                "name": row["item"],
                "interpretation": row["interpretation"],
                "category": material["label_category"],
                "batch_amount": decimal_string(to_mass_g(
                    Decimal(row["quantity"]), row["unit"],
                    Decimal(material["density_g_per_ml"]) if material.get("density_g_per_ml") else None,
                ) * Decimal(1000)),
                "unit": "mg",
                "source": material.get("source", {}),
                "identity_note": material.get("identity_note"),
                "needs_review": row["needs_review"],
            })
    unparsed_rows = (input_provenance or {}).get("unparsed_rows", [])
    if unparsed_rows:
        summary = f"{len(unparsed_rows)} source lines not included; correct them and prepare the formula again."
        missing_information.insert(0, {"item": "Source recovery", "needed": summary, "affects": [metric["name"] for metric in screened]})
        # The excluded lines have unknown identities and quantities. Parsed
        # contributions remain useful, but cannot establish a complete total.
        for metric in screened:
            metric["status"] = "partial"
            lower = (metric.get("range") or {}).get("lower")
            lower = metric["value"] if lower is None else lower
            metric["range"] = {"kind": "lower_bound" if metric["value"] is not None else "not_estimated",
                               "lower": lower, "upper": None, "unit": metric["unit"],
                               "basis": "Unparsed source lines may add unknown contributions"}
            metric["range_label"] = _range_label(metric)
        coverage = {**coverage, "characterized_percent": None, "uncharacterized_percent": None,
                    "basis": "Unparsed source lines prevent complete mass coverage"}

    result = {
        "schema_version": 1,
        "calculation": {
            "engine_version": ENGINE_VERSION,
            "nutrition_catalog_fingerprint": fingerprint(nutrition_catalog),
            "chemical_catalog_fingerprint": fingerprint(chemical_catalog),
            "accepted_profile_count": len(accepted_profiles or []),
            "arithmetic": "Python Decimal",
        },
        "product_name": submitted_formula["batch"]["name"],
        "file_name": parsed["file_name"],
        "basis_label": basis_label,
        "label_batch_quantity": nutrition["final_volume_ml"] if basis_key == "per_100_ml" else nutrition["final_mass_g"],
        "declared_nutrient_ids": sorted(declared_nutrient_ids),
        "label_entries": label_entries,
        "product_inference": _product_inference(present, material_ids),
        "coverage": coverage,
        "formula_rows": formula_rows,
        "label_ingredients": [{**leaf, "label_name": nutrition_catalog["materials"][leaf["material_id"]].get("label_name", leaf["name"])}
                              for leaf in nutrition["leaf_ingredients"]],
        "present_components": present,
        "screened_components": screened,
        "ingredient_assumptions": ingredient_assumptions,
        "report_assumptions": report_assumptions,
        "missing_information": missing_information,
        "warnings": warnings,
    }
    if input_provenance is not None:
        result["input_provenance"] = input_provenance
        for row, source in zip(formula_rows, input_provenance["rows"], strict=True):
            row["input_source"] = source
    result["markdown"] = _markdown(result) + provenance_markdown(formula_rows, unparsed_rows)
    return result
