from __future__ import annotations

import copy
import json
import unittest
from decimal import Decimal
from pathlib import Path

from nutrition_formula.engine import CalculationError, calculate

ROOT = Path(__file__).resolve().parents[1]


def load_json(path: Path) -> dict:
    with path.open(encoding="utf-8") as handle:
        return json.load(handle)


def nutrient(result: dict, nutrient_id: str) -> dict:
    return next(item for item in result["nutrients"] if item["id"] == nutrient_id)


class EnginePropertyTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.catalog = load_json(ROOT / "src/nutrition_formula/data/catalog.json")
        cls.base = load_json(ROOT / "examples/formulas/electrolyte_beverage_1000l.json")

    def test_equivalent_mass_units_produce_identical_results(self) -> None:
        alternate = copy.deepcopy(self.base)
        alternate["ingredients"][1]["quantity"] = {"value": "55000", "unit": "g"}
        self.assertEqual(calculate(self.catalog, self.base), calculate(self.catalog, alternate))

    def test_ingredient_order_does_not_change_numerical_outputs(self) -> None:
        alternate = copy.deepcopy(self.base)
        alternate["ingredients"].reverse()
        original = calculate(self.catalog, self.base)
        reordered = calculate(self.catalog, alternate)
        self.assertEqual(original["input_mass_g"], reordered["input_mass_g"])
        for nutrient_id in self.catalog["nutrients"]:
            first = nutrient(original, nutrient_id)
            second = nutrient(reordered, nutrient_id)
            for field in (
                "total_batch",
                "total_batch_range",
                "per_100_g",
                "per_100_ml",
                "per_100_g_range",
                "per_100_ml_range",
                "per_serving",
                "coverage_percent",
                "status",
            ):
                self.assertEqual(first[field], second[field], (nutrient_id, field))

    def test_splitting_an_ingredient_line_preserves_totals(self) -> None:
        alternate = copy.deepcopy(self.base)
        sugar = alternate["ingredients"].pop(1)
        alternate["ingredients"].extend(
            [
                {**sugar, "quantity": {"value": "20", "unit": "kg"}},
                {**sugar, "quantity": {"value": "35", "unit": "kg"}},
            ]
        )
        original = calculate(self.catalog, self.base)
        split = calculate(self.catalog, alternate)
        for nutrient_id in self.catalog["nutrients"]:
            self.assertEqual(
                nutrient(original, nutrient_id)["total_batch"],
                nutrient(split, nutrient_id)["total_batch"],
            )

    def test_scaling_batch_and_all_inputs_preserves_concentration(self) -> None:
        alternate = copy.deepcopy(self.base)
        alternate["batch"]["final_quantity"]["value"] = "2000"
        for line in alternate["ingredients"]:
            line["quantity"]["value"] = str(Decimal(line["quantity"]["value"]) * 2)
        original = calculate(self.catalog, self.base)
        scaled = calculate(self.catalog, alternate)
        for nutrient_id in self.catalog["nutrients"]:
            first = nutrient(original, nutrient_id)
            second = nutrient(scaled, nutrient_id)
            self.assertEqual(first["per_100_ml"], second["per_100_ml"])
            self.assertEqual(Decimal(first["total_batch"]) * 2, Decimal(second["total_batch"]))

    def test_mass_and_volume_final_yields_are_equivalent_with_density(self) -> None:
        volume = copy.deepcopy(self.base)
        volume["batch"]["final_density_g_per_ml"] = "1.04"
        mass = copy.deepcopy(volume)
        mass["batch"]["final_quantity"] = {"value": "1040", "unit": "kg"}
        by_volume = calculate(self.catalog, volume)
        by_mass = calculate(self.catalog, mass)
        for nutrient_id in self.catalog["nutrients"]:
            self.assertEqual(
                nutrient(by_volume, nutrient_id)["per_100_ml"],
                nutrient(by_mass, nutrient_id)["per_100_ml"],
            )

    def test_mass_and_volume_servings_are_equivalent_with_density(self) -> None:
        volume = copy.deepcopy(self.base)
        volume["batch"]["final_density_g_per_ml"] = "1.04"
        volume["serving"] = {"value": "250", "unit": "mL"}
        mass = copy.deepcopy(volume)
        mass["serving"] = {"value": "260", "unit": "g"}
        by_volume = calculate(self.catalog, volume)
        by_mass = calculate(self.catalog, mass)
        for nutrient_id in self.catalog["nutrients"]:
            self.assertEqual(
                nutrient(by_volume, nutrient_id)["per_serving"],
                nutrient(by_mass, nutrient_id)["per_serving"],
            )

    def test_quantity_and_final_yield_ranges_use_worst_case_bounds(self) -> None:
        formula = copy.deepcopy(self.base)
        formula["ingredients"][1]["quantity"].update({"minimum": "54", "maximum": "56"})
        formula["batch"]["final_quantity"].update({"minimum": "990", "maximum": "1010"})
        energy = nutrient(calculate(self.catalog, formula), "energy")
        self.assertEqual(energy["per_100_ml_range"]["kind"], "bounded")
        self.assertLess(
            Decimal(energy["per_100_ml_range"]["lower"]), Decimal(energy["per_100_ml"])
        )
        self.assertGreater(
            Decimal(energy["per_100_ml_range"]["upper"]), Decimal(energy["per_100_ml"])
        )

    def test_explicit_zero_remains_complete_while_missing_profile_is_partial(self) -> None:
        formula = copy.deepcopy(self.base)
        result = calculate(self.catalog, formula)
        self.assertEqual(nutrient(result, "protein")["total_batch"], "0")
        self.assertEqual(nutrient(result, "protein")["status"], "complete")

        formula["ingredients"].append(
            {"material_id": "whey_protein_isolate", "quantity": {"value": "1", "unit": "kg"}}
        )
        partial = calculate(self.catalog, formula)
        self.assertEqual(nutrient(partial, "riboflavin")["status"], "partial")

    def test_negative_profile_value_is_rejected(self) -> None:
        catalog = copy.deepcopy(self.catalog)
        catalog["materials"]["granulated_sugar"]["nutrients"]["energy"]["value"] = "-1"
        with self.assertRaisesRegex(CalculationError, "cannot be negative"):
            calculate(catalog, self.base)

    def test_negative_profile_range_is_rejected(self) -> None:
        catalog = copy.deepcopy(self.catalog)
        profile = catalog["materials"]["granulated_sugar"]["nutrients"]["energy"]
        profile.update({"minimum": "-1", "maximum": "400"})
        with self.assertRaisesRegex(CalculationError, "cannot be negative"):
            calculate(catalog, self.base)

    def test_nonpositive_serving_is_rejected(self) -> None:
        for value in ("0", "-1"):
            formula = copy.deepcopy(self.base)
            formula["serving"] = {"value": value, "unit": "mL"}
            with self.subTest(value=value), self.assertRaisesRegex(
                CalculationError, "serving.value must be greater than zero"
            ):
                calculate(self.catalog, formula)

    def test_semantic_serving_unit_is_rejected(self) -> None:
        formula = copy.deepcopy(self.base)
        formula["serving"] = {"value": "1", "unit": "tablet"}
        with self.assertRaisesRegex(CalculationError, "Unsupported serving unit"):
            calculate(self.catalog, formula)


if __name__ == "__main__":
    unittest.main()
