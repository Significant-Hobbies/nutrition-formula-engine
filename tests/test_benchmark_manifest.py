from __future__ import annotations

import json
import unittest
from decimal import ROUND_HALF_UP, Decimal
from pathlib import Path

from nutrition_formula.engine import calculate
from nutrition_formula.ingredient_search import search_local_ingredients

ROOT = Path(__file__).resolve().parents[1]


class BenchmarkManifestTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.manifest = json.loads(
            (ROOT / "benchmarks/manifest.json").read_text(encoding="utf-8")
        )
        cls.public_cases = json.loads(
            (ROOT / "public/case-studies.json").read_text(encoding="utf-8")
        )["cases"]
        cls.catalog = json.loads(
            (ROOT / "examples/public_products/catalog.json").read_text(encoding="utf-8")
        )

    def test_stage_counts_are_explicit_and_stratified(self) -> None:
        self.assertEqual(len(self.manifest["calculation_cases"]), 26)
        self.assertEqual(len(self.manifest["identity_cases"]), 20)
        self.assertEqual(len(self.manifest["extraction_cases"]), 20)

    def test_calculation_cases_are_external_sourced_and_below_threshold(self) -> None:
        threshold = self.manifest["thresholds"]["calculation_maximum_difference_percent"]
        for benchmark in self.manifest["calculation_cases"]:
            fixture = ROOT / benchmark["fixture"]
            case = self.public_cases[benchmark["public_case_index"]]
            with self.subTest(product=case["product"]):
                self.assertTrue(fixture.is_file())
                self.assertTrue(case["source_url"].startswith("https://"))
                self.assertLess(float(case["difference_percent"]), threshold)
                formula = json.loads(fixture.read_text(encoding="utf-8"))
                result = calculate(self.catalog, formula)
                metric = next(
                    item
                    for item in result["nutrients"]
                    if item["id"] == benchmark["metric_id"]
                )
                actual = Decimal(metric[benchmark["result_field"]]) * Decimal(
                    benchmark["scale"]
                )
                declared = Decimal(benchmark["declared_value"])
                difference = (abs(actual - declared) / declared * 100).quantize(
                    Decimal("0.001"), rounding=ROUND_HALF_UP
                )
                self.assertEqual(difference, Decimal(case["difference_percent"]))

    def test_all_displayed_case_study_values_match_engine_results(self) -> None:
        metric_ids = {
            "Glucose": "glucose",
            "Sodium": "sodium",
            "Chloride": "chloride",
            "Potassium": "potassium",
            "Citrate": "citrate",
            "Calcium": "calcium",
            "Lactate": "lactate",
            "Dextrose": "dextrose",
            "Energy": "energy",
            "Magnesium": "magnesium",
            "Acetate": "acetate",
            "Gluconate": "gluconate",
            "Bicarbonate": "bicarbonate",
            "Protein": "protein",
            "Carbohydrate": "carbohydrate",
            "Vitamin C": "vitamin_c",
            "Elemental magnesium": "elemental_magnesium",
            "Elemental iron": "elemental_iron",
            "Elemental zinc": "elemental_zinc",
            "Elemental calcium": "elemental_calcium",
            "Elemental copper": "elemental_copper",
            "Elemental selenium": "elemental_selenium",
            "Elemental potassium": "elemental_potassium",
            "Phosphorus": "phosphorus",
            "Elemental manganese": "elemental_manganese",
            "Elemental chromium": "elemental_chromium",
        }
        fixtures = {
            case["public_case_index"]: ROOT / case["fixture"]
            for case in self.manifest["calculation_cases"]
        }
        checked = 0
        for case_index, case in enumerate(self.public_cases):
            formula = json.loads(fixtures[case_index].read_text(encoding="utf-8"))
            result = calculate(self.catalog, formula)
            comparisons = case.get("components") or [case]
            for comparison in comparisons:
                with self.subTest(
                    product=case["product"], component=comparison["component"]
                ):
                    metric_id = metric_ids[comparison["component"]]
                    if case["product"] == "USDA MyPlate Yogurt Smoothie in a Bag":
                        metric_id = {
                            "Calcium": "food_calcium",
                            "Potassium": "food_potassium",
                        }.get(comparison["component"], metric_id)
                    item = next(
                        nutrient
                        for nutrient in result["nutrients"]
                        if nutrient["id"] == metric_id
                    )
                    unit = comparison["predicted"].split(" ", 1)[1]
                    if unit.endswith("/L"):
                        actual = Decimal(item["per_100_ml"]) * Decimal(10)
                    elif unit.endswith("/100 mL"):
                        actual = Decimal(item["per_100_ml"])
                    else:
                        actual = Decimal(item["total_batch"])
                    shown = Decimal(comparison["predicted"].split(" ", 1)[0])
                    self.assertEqual(
                        actual.quantize(shown, rounding=ROUND_HALF_UP),
                        shown,
                    )
                    checked += 1
        self.assertEqual(checked, 55)

    def test_identity_cases_select_the_expected_local_candidate(self) -> None:
        for case in self.manifest["identity_cases"]:
            with self.subTest(query=case["query"]):
                result = search_local_ingredients(case["query"], case["kind"])
                self.assertEqual(
                    result["candidates"][0]["material_id"], case["expected_material_id"]
                )


if __name__ == "__main__":
    unittest.main()
