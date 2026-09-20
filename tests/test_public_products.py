from __future__ import annotations

import json
import unittest
from decimal import Decimal
from pathlib import Path

from nutrition_formula.engine import calculate

ROOT = Path(__file__).resolve().parents[1]
PUBLIC = ROOT / "examples/public_products"


def load_json(path: Path) -> dict:
    with path.open(encoding="utf-8") as handle:
        return json.load(handle)


def metric(result: dict, metric_id: str) -> dict:
    return next(item for item in result["nutrients"] if item["id"] == metric_id)


def per_litre(result: dict, metric_id: str) -> Decimal:
    return Decimal(metric(result, metric_id)["per_100_ml"]) * Decimal(10)


class PublicProductValidationTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.catalog = load_json(PUBLIC / "catalog.json")

    def calculate(self, fixture: str) -> dict:
        return calculate(self.catalog, load_json(PUBLIC / fixture))

    def assert_close(self, actual: Decimal, expected: str, tolerance: str) -> None:
        difference = abs(actual - Decimal(expected))
        self.assertLessEqual(
            difference,
            Decimal(tolerance),
            f"{actual} differs from public label {expected} by {difference}",
        )

    def assert_within_percent(
        self,
        actual: Decimal,
        expected: str,
        tolerance_percent: str,
    ) -> None:
        expected_value = Decimal(expected)
        difference_percent = abs(actual - expected_value) / expected_value * Decimal(100)
        self.assertLessEqual(
            difference_percent,
            Decimal(tolerance_percent),
            f"{actual} differs from public target {expected} by {difference_percent}%",
        )

    def test_who_reduced_osmolarity_ors_matches_published_ions(self) -> None:
        result = self.calculate("who_ors_1l.json")

        self.assert_close(per_litre(result, "sodium"), "75", "1")
        self.assert_close(per_litre(result, "potassium"), "20", "0.2")
        self.assert_close(per_litre(result, "chloride"), "65", "0.5")
        self.assert_close(per_litre(result, "citrate"), "10", "0.2")
        self.assert_close(per_litre(result, "glucose"), "75", "0.1")

    def test_normal_saline_matches_154_meq_per_litre_label(self) -> None:
        result = self.calculate("sodium_chloride_09_1l.json")

        self.assert_close(per_litre(result, "sodium"), "154", "0.01")
        self.assert_close(per_litre(result, "chloride"), "154", "0.01")

    def test_lactated_ringers_matches_published_ionic_composition(self) -> None:
        result = self.calculate("lactated_ringers_1l.json")

        self.assert_close(per_litre(result, "sodium"), "130", "0.5")
        self.assert_close(per_litre(result, "potassium"), "4", "0.1")
        self.assert_close(per_litre(result, "calcium"), "3", "0.3")
        self.assert_close(per_litre(result, "chloride"), "109", "0.5")
        self.assert_close(per_litre(result, "lactate"), "28", "0.5")

    def test_ringers_matches_published_ionic_composition(self) -> None:
        result = self.calculate("ringers_1l.json")

        self.assert_close(per_litre(result, "sodium"), "147", "0.2")
        self.assert_close(per_litre(result, "potassium"), "4", "0.1")
        self.assert_close(per_litre(result, "calcium"), "4.5", "0.1")
        self.assert_close(per_litre(result, "chloride"), "156", "0.5")

    def test_five_percent_dextrose_matches_label_mass_and_calories(self) -> None:
        result = self.calculate("dextrose_5_1l.json")

        self.assertEqual(metric(result, "dextrose")["per_100_ml"], "5")
        self.assertEqual(metric(result, "energy")["per_100_ml"], "17")

    def test_ten_percent_dextrose_matches_label_mass_and_calories(self) -> None:
        result = self.calculate("dextrose_10_1l.json")

        self.assertEqual(metric(result, "dextrose")["per_100_ml"], "10")
        self.assertEqual(metric(result, "energy")["per_100_ml"], "34")

    def test_plasma_lyte_a_matches_six_declared_ions(self) -> None:
        result = self.calculate("plasma_lyte_a_1l.json")

        for metric_id, expected, tolerance in [
            ("sodium", "140", "0.1"),
            ("potassium", "5", "0.05"),
            ("magnesium", "3", "0.05"),
            ("chloride", "98", "0.1"),
            ("acetate", "27", "0.05"),
            ("gluconate", "23", "0.05"),
        ]:
            with self.subTest(metric_id=metric_id):
                self.assert_close(per_litre(result, metric_id), expected, tolerance)

    def test_sodium_bicarbonate_injection_matches_both_declared_ions(self) -> None:
        result = self.calculate("sodium_bicarbonate_84mg_ml.json")

        self.assert_close(Decimal(metric(result, "sodium")["total_batch"]), "1", "0.001")
        self.assert_close(
            Decimal(metric(result, "bicarbonate")["total_batch"]),
            "1",
            "0.001",
        )

    def test_who_f75_recipe_matches_energy_and_protein_targets_with_reference_foods(
        self,
    ) -> None:
        result = self.calculate("who_f75_no_cereal_1l.json")

        self.assert_within_percent(Decimal(metric(result, "energy")["per_100_ml"]), "75", "5")
        self.assert_within_percent(Decimal(metric(result, "protein")["per_100_ml"]), "0.9", "5")

    def test_who_f100_recipe_matches_energy_and_protein_targets_with_reference_foods(
        self,
    ) -> None:
        result = self.calculate("who_f100_1l.json")

        self.assert_within_percent(Decimal(metric(result, "energy")["per_100_ml"]), "100", "5")
        self.assert_within_percent(Decimal(metric(result, "protein")["per_100_ml"]), "2.9", "5")

    def test_market_magnesium_oxide_tablet_matches_elemental_magnesium_label(self) -> None:
        result = self.calculate("magnesium_oxide_400mg_tablet.json")

        self.assert_close(
            Decimal(metric(result, "elemental_magnesium")["total_batch"]),
            "241.3",
            "0.1",
        )

    def test_market_ferrous_sulfate_tablet_matches_elemental_iron_label(self) -> None:
        result = self.calculate("ferrous_sulfate_325mg_tablet.json")

        self.assert_close(
            Decimal(metric(result, "elemental_iron")["total_batch"]),
            "65",
            "0.3",
        )

    def test_market_zinc_sulfate_injection_matches_elemental_zinc_label(self) -> None:
        result = self.calculate("zinc_sulfate_injection_3mg_per_ml.json")

        self.assert_close(
            Decimal(metric(result, "elemental_zinc")["total_batch"]),
            "3",
            "0.01",
        )

    def test_market_calcium_carbonate_tablet_matches_elemental_calcium_label(self) -> None:
        result = self.calculate("calcium_carbonate_1250mg_tablet.json")

        self.assert_close(
            Decimal(metric(result, "elemental_calcium")["total_batch"]),
            "500",
            "0.6",
        )

    def test_market_potassium_chloride_tablet_matches_potassium_label(self) -> None:
        result = self.calculate("potassium_chloride_750mg_tablet.json")

        self.assert_close(
            Decimal(metric(result, "potassium")["total_batch"]),
            "10",
            "0.1",
        )


if __name__ == "__main__":
    unittest.main()
