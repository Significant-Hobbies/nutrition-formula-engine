"""Command-line interface for the local nutrient engine."""

from __future__ import annotations

import argparse
import json
import sys
from decimal import Decimal
from pathlib import Path
from typing import Any

from .engine import CalculationError, calculate
from .product_report import build_product_report
from .resolver import search_materials


def _display(value: str | None) -> str:
    if value is None:
        return "—"
    number = Decimal(value)
    if number == 0:
        return "0"
    rendered = format(number, ".6g")
    if "e" not in rendered.lower() and "." in rendered:
        rendered = rendered.rstrip("0").rstrip(".")
    return rendered


def _load_json(path: Path) -> dict[str, Any]:
    with path.open(encoding="utf-8") as handle:
        return json.load(handle)


def _markdown(result: dict[str, Any]) -> str:
    lines = [
        f"# {result['formula_name']}",
        "",
        f"Calculation: `{result['calculation_type']}`",
        f"Input mass: {result['input_mass_g']} g",
        f"Final mass: {result['final_mass_g'] or 'unavailable'} g",
        f"Final volume: {result['final_volume_ml'] or 'unavailable'} mL",
        "",
    ]
    chemical_report = result["report_type"] == "chemical"
    if chemical_report:
        lines.extend(
            [
                "| Component | Formula | Class | Total batch | Per 100 mL | Unit | Coverage |",
                "|---|---|---|---:|---:|---|---:|",
            ]
        )
    else:
        lines.extend(
            [
                "| Nutrient | Class | Per 100 g | Per 100 mL | Per serving | Unit | Coverage |",
                "|---|---|---:|---:|---:|---|---:|",
            ]
        )
    for nutrient in result["nutrients"]:
        if chemical_report:
            lines.append(
                "| {name} | {formula} | {class_} | {total} | {per_100_ml} | "
                "{unit} | {coverage}% |".format(
                    name=nutrient["name"],
                    formula=nutrient["formula"] or "—",
                    class_=nutrient["class"],
                    total=_display(nutrient["total_batch"]),
                    per_100_ml=_display(nutrient["per_100_ml"]),
                    unit=nutrient["unit"],
                    coverage=_display(nutrient["coverage_percent"]),
                )
            )
        else:
            lines.append(
                "| {name} | {class_} | {per_100_g} | {per_100_ml} | {per_serving} | "
                "{unit} | {coverage}% |".format(
                    name=nutrient["name"],
                    class_=nutrient["class"],
                    per_100_g=_display(nutrient["per_100_g"]),
                    per_100_ml=_display(nutrient["per_100_ml"]),
                    per_serving=_display(nutrient["per_serving"]),
                    unit=nutrient["unit"],
                    coverage=_display(nutrient["coverage_percent"]),
                )
            )
    if result["warnings"]:
        lines.extend(["", "## Warnings", ""])
        lines.extend(f"- {warning}" for warning in result["warnings"])
    if result["assumptions"]:
        lines.extend(["", "## Ingredient match assumptions", ""])
        for assumption in result["assumptions"]:
            identity_note = (
                f" Identity: {assumption['identity_note']}." if assumption["identity_note"] else ""
            )
            lines.append(
                f"- `{assumption['query']}` → **{assumption['selected_name']}** "
                f"({assumption['confidence']}, score {assumption['score']}). "
                f"Correction: `{assumption['correction']}`.{identity_note}"
            )
    partial = [n for n in result["nutrients"] if n["status"] == "partial"]
    if partial:
        lines.extend(["", "## Incomplete nutrient coverage", ""])
        for nutrient in partial:
            materials = ", ".join(nutrient["unknown_materials"])
            lines.append(f"- {nutrient['name']}: missing from {materials}")
    return "\n".join(lines) + "\n"


def _markdown_product(result: dict[str, Any]) -> str:
    coverage = result["profile_coverage"]
    lines = [
        f"# {result['product_name']} — composition report",
        "",
        "## What is known and unknown",
        "",
        (
            "- **Usable nutrient-profile coverage:** "
            f"{_display(coverage['characterized_percent'])}% of {coverage['basis']}."
        ),
        (
            "- **Uncharacterized:** "
            f"{_display(coverage['uncharacterized_percent'])}% "
            f"({_display(coverage['uncharacterized_mass_g'])} g)."
        ),
    ]
    for material in coverage["uncharacterized_materials"]:
        lines.append(
            "  - {name}: {mass} g ({percent}% of the coverage basis).".format(
                name=material["name"],
                mass=_display(material["mass_g"]),
                percent=_display(material["input_mass_percent"]),
            )
        )
    lines.extend(
        [
            (
                "- Coverage describes available ingredient profiles; it is not product "
                "accuracy, a laboratory result, or a regulatory confidence level."
            ),
            "",
            "## Final result",
            "",
        "| # | Component | Per 100 mL | Plausible range | Evidence confidence | Status |",
        "|---:|---|---:|---|---|---|",
        ]
    )
    displayed_metrics = [
        metric
        for metric in result["metrics"]
        if result["display_zero_metrics"] or metric["per_100_ml"] != "0"
    ]
    for display_rank, metric in enumerate(displayed_metrics, start=1):
        status = metric["status"]
        if status == "partial":
            status = "calculated from characterized inputs"
        value_range = metric["range"]
        if value_range["kind"] == "bounded":
            range_display = (
                f"{_display(value_range['lower'])}–{_display(value_range['upper'])} "
                f"{value_range['unit']}"
            )
        elif value_range["kind"] == "lower_bound":
            range_display = "uncharacterized material may contribute"
        else:
            range_display = "not estimable"
        confidence = metric["confidence"]
        value = f"{_display(metric['per_100_ml'])} {metric['unit']}"
        if metric["per_100_ml"] == "0" and value_range["kind"] == "lower_bound":
            value = "Not established"
            range_display = "no identified contribution"
            status = "uncharacterized material may contribute"
        lines.append(
            "| {rank} | {name} | {value} | {range_} | {score} ({band}) | {status} |".format(
                rank=display_rank,
                name=metric["name"],
                value=value,
                range_=range_display,
                score=confidence["score"],
                band=confidence["band"],
                status=status,
            )
        )
    if result["missing_information"]:
        lines.extend(["", "## Missing information", ""])
        for item in result["missing_information"]:
            affects = ", ".join(item.get("affects", []))
            impact = f" Affects: {affects}." if affects else ""
            lines.append(f"- **{item['item']}** — {item['needed']}.{impact}")
    lines.extend(["", "## Report assumptions", ""])
    lines.extend(f"- {assumption}" for assumption in result["report_assumptions"])
    lines.extend(["", "## Ingredient identity assumptions", ""])
    for assumption in result["ingredient_assumptions"]:
        notes = "; ".join(assumption["notes"]) or "No additional identity note"
        lines.append(
            f"- `{assumption['query']}` → **{assumption['selected_identity']}** "
            f"({assumption['confidence']} confidence). {notes}. "
            f"Correction: `{assumption['correction']}`."
        )
    if result["warnings"]:
        lines.extend(["", "## Warnings", ""])
        lines.extend(f"- {warning}" for warning in result["warnings"])
    return "\n".join(lines) + "\n"


def _load_product_report(path: Path) -> dict[str, Any]:
    definition = _load_json(path)
    base = path.parent
    formula = _load_json((base / definition["formula"]).resolve())
    nutrition_catalog = _load_json((base / definition["nutrition_catalog"]).resolve())
    chemical_catalog = _load_json((base / definition["chemical_catalog"]).resolve())
    return build_product_report(
        nutrition_catalog=nutrition_catalog,
        chemical_catalog=chemical_catalog,
        formula=formula,
        report_definition=definition,
    )


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Calculate nutrients from a batch formula")
    parser.add_argument("--catalog", type=Path)
    action = parser.add_mutually_exclusive_group(required=True)
    action.add_argument("--formula", type=Path)
    action.add_argument("--search")
    action.add_argument("--product-report", type=Path)
    parser.add_argument("--format", choices=("json", "markdown"), default="markdown")
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        if args.product_report:
            result = _load_product_report(args.product_report)
            if args.format == "json":
                print(json.dumps(result, indent=2, ensure_ascii=False))
            else:
                print(_markdown_product(result), end="")
            return 0
        if args.catalog is None:
            raise CalculationError("--catalog is required with --formula or --search")
        catalog = _load_json(args.catalog)
        if args.search:
            matches = search_materials(catalog, args.search)
            if args.format == "json":
                print(json.dumps(matches, indent=2, ensure_ascii=False))
            else:
                for match in matches:
                    print(
                        f"{match['score']:.3f}  {match['material_id']}  "
                        f"{match['name']}  (matched {match['matched_term']!r})"
                    )
            return 0
        result = calculate(catalog, _load_json(args.formula))
    except (CalculationError, KeyError, json.JSONDecodeError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2
    if args.format == "json":
        print(json.dumps(result, indent=2, ensure_ascii=False))
    else:
        print(_markdown(result), end="")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
