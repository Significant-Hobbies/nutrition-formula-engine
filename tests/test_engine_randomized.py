from __future__ import annotations

import json
import random
import unittest
from decimal import Decimal
from pathlib import Path

from nutrition_formula.engine import calculate

ROOT = Path(__file__).resolve().parents[1]


def nutrient_map(result: dict) -> dict[str, dict]:
    return {item["id"]: item for item in result["nutrients"]}


class DeterministicGeneratedEngineTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        with (ROOT / "src/nutrition_formula/data/catalog.json").open(encoding="utf-8") as handle:
            cls.catalog = json.load(handle)

    @staticmethod
    def formula(sugar_parts: list[tuple[str, str]], final_litres: str) -> dict:
        return {
            "schema_version": 1,
            "batch": {
                "name": "Generated equivalence trial",
                "final_quantity": {"value": final_litres, "unit": "L"},
            },
            "ingredients": [
                {
                    "material_id": "granulated_sugar",
                    "quantity": {"value": value, "unit": unit},
                }
                for value, unit in sugar_parts
            ],
        }

    def assert_same_numerical_result(self, left: dict, right: dict) -> None:
        self.assertEqual(left["input_mass_g"], right["input_mass_g"])
        left_metrics = nutrient_map(left)
        right_metrics = nutrient_map(right)
        for nutrient_id in left_metrics:
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
                self.assertEqual(
                    left_metrics[nutrient_id][field],
                    right_metrics[nutrient_id][field],
                    (nutrient_id, field),
                )

    def test_120_generated_unit_split_and_order_equivalence_trials(self) -> None:
        generator = random.Random(20260921)
        for trial in range(120):
            milligrams = generator.randint(1, 10_000_000_000)
            final_litres = str(generator.randint(1, 5000))
            first = generator.randint(0, milligrams)
            second = milligrams - first
            canonical = self.formula([(str(milligrams), "mg")], final_litres)
            grams = self.formula([(str(Decimal(milligrams) / 1000), "g")], final_litres)
            split = self.formula(
                [(str(first), "mg"), (str(Decimal(second) / 1_000_000), "kg")],
                final_litres,
            )
            reversed_split = {
                **split,
                "ingredients": list(reversed(split["ingredients"])),
            }

            with self.subTest(trial=trial, milligrams=milligrams):
                expected = calculate(self.catalog, canonical)
                self.assert_same_numerical_result(expected, calculate(self.catalog, grams))
                self.assert_same_numerical_result(expected, calculate(self.catalog, split))
                self.assert_same_numerical_result(expected, calculate(self.catalog, reversed_split))

    def test_100_generated_quantity_and_yield_ranges_contain_point_estimate(self) -> None:
        generator = random.Random(314159)
        for trial in range(100):
            value = Decimal(generator.randint(10, 100_000)) / Decimal(100)
            input_delta = value * Decimal(generator.randint(0, 20)) / Decimal(100)
            final_value = Decimal(generator.randint(10, 5000))
            final_delta = final_value * Decimal(generator.randint(0, 10)) / Decimal(100)
            formula = self.formula([(str(value), "kg")], str(final_value))
            formula["ingredients"][0]["quantity"].update(
                {"minimum": str(value - input_delta), "maximum": str(value + input_delta)}
            )
            formula["batch"]["final_quantity"].update(
                {
                    "minimum": str(final_value - final_delta),
                    "maximum": str(final_value + final_delta),
                }
            )
            result = calculate(self.catalog, formula)
            with self.subTest(trial=trial):
                for metric in result["nutrients"]:
                    bounds = metric["per_100_ml_range"]
                    point = Decimal(metric["per_100_ml"])
                    self.assertLessEqual(Decimal(bounds["lower"]), point)
                    self.assertGreaterEqual(Decimal(bounds["upper"]), point)


if __name__ == "__main__":
    unittest.main()
