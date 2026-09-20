from __future__ import annotations

import json
import unittest
from pathlib import Path

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

    def test_stage_counts_are_explicit_and_stratified(self) -> None:
        self.assertEqual(len(self.manifest["calculation_cases"]), 15)
        self.assertEqual(len(self.manifest["identity_cases"]), 10)
        self.assertEqual(len(self.manifest["extraction_cases"]), 10)

    def test_calculation_cases_are_external_sourced_and_below_threshold(self) -> None:
        threshold = self.manifest["thresholds"]["calculation_maximum_difference_percent"]
        for benchmark in self.manifest["calculation_cases"]:
            fixture = ROOT / benchmark["fixture"]
            case = self.public_cases[benchmark["public_case_index"]]
            with self.subTest(product=case["product"]):
                self.assertTrue(fixture.is_file())
                self.assertTrue(case["source_url"].startswith("https://"))
                self.assertLess(float(case["difference_percent"]), threshold)

    def test_identity_cases_select_the_expected_local_candidate(self) -> None:
        for case in self.manifest["identity_cases"]:
            with self.subTest(query=case["query"]):
                result = search_local_ingredients(case["query"], case["kind"])
                self.assertEqual(
                    result["candidates"][0]["material_id"], case["expected_material_id"]
                )


if __name__ == "__main__":
    unittest.main()
