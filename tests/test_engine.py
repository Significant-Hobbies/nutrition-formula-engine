from __future__ import annotations

import copy
import json
import unittest
from decimal import Decimal
from pathlib import Path

from nutrition_formula.cli import _markdown_product
from nutrition_formula.engine import CalculationError, calculate
from nutrition_formula.product_report import build_product_report
from nutrition_formula.resolver import search_materials

ROOT = Path(__file__).resolve().parents[1]


def load_json(path: Path) -> dict:
    with path.open(encoding="utf-8") as handle:
        return json.load(handle)


def nutrient(result: dict, nutrient_id: str) -> dict:
    return next(item for item in result["nutrients"] if item["id"] == nutrient_id)


class EngineTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.catalog = load_json(ROOT / "src/nutrition_formula/data/catalog.json")
        cls.chemical_catalog = load_json(ROOT / "src/nutrition_formula/data/chemical_catalog.json")

    def test_electrolyte_beverage_exact_totals_across_mixed_units(self) -> None:
        formula = load_json(ROOT / "examples/formulas/electrolyte_beverage_1000l.json")
        result = calculate(self.catalog, formula)

        self.assertEqual(result["input_mass_g"], "1000000")
        self.assertEqual(result["final_volume_ml"], "1000000")
        self.assertEqual(nutrient(result, "energy")["per_100_ml"], "21.285")
        self.assertEqual(nutrient(result, "sodium")["per_100_ml"], "19.67")
        self.assertEqual(nutrient(result, "potassium")["per_100_ml"], "13.11125")
        self.assertEqual(nutrient(result, "calcium")["per_100_ml"], "6.5")
        self.assertEqual(nutrient(result, "magnesium")["per_100_ml"], "3.2")
        self.assertEqual(nutrient(result, "vitamin_c")["per_100_ml"], "9")
        self.assertEqual(nutrient(result, "vitamin_c")["per_serving"], "22.5")
        self.assertTrue(all(item["status"] == "complete" for item in result["nutrients"]))

    def test_submitted_tonic_runs_with_visible_identity_assumptions(self) -> None:
        formula = load_json(ROOT / "examples/formulas/user_tonic_1000l.json")
        result = calculate(self.catalog, formula)

        self.assertIsNone(nutrient(result, "energy")["per_100_g"])
        self.assertEqual(nutrient(result, "energy")["per_100_ml"], "194.3")
        self.assertEqual(nutrient(result, "carbohydrate")["per_100_ml"], "49.99")
        self.assertEqual(nutrient(result, "iron")["per_100_ml"], "261.3")
        self.assertEqual(nutrient(result, "zinc")["per_100_ml"], "16.685")
        self.assertEqual(nutrient(result, "sodium")["per_100_ml"], "47.856")
        self.assertEqual(nutrient(result, "vitamin_b6")["per_100_ml"], "9.8724")
        self.assertEqual(nutrient(result, "folic_acid")["per_100_ml"], "2400")
        self.assertEqual(nutrient(result, "vitamin_b12")["per_100_ml"], "8.5")
        self.assertEqual(len(result["assumptions"]), 13)
        self.assertEqual(
            next(item for item in result["assumptions"] if item["query"] == "ZINC SULPHATE")[
                "identity_status"
            ],
            "assumed",
        )

    def test_submitted_tonic_reports_chemical_species_and_moieties(self) -> None:
        formula = load_json(ROOT / "examples/formulas/user_tonic_1000l.json")
        result = calculate(self.chemical_catalog, formula)

        self.assertEqual(result["report_type"], "chemical")
        self.assertEqual(nutrient(result, "cyanocobalamin")["formula"], "C63H88CoN14O14P")
        self.assertEqual(nutrient(result, "ferric_ammonium_citrate")["per_100_ml"], "1340")
        self.assertEqual(nutrient(result, "iron")["per_100_ml"], "261.3")
        self.assertEqual(nutrient(result, "cyanocobalamin")["per_100_ml"], "0.0085")
        self.assertEqual(nutrient(result, "cobalt")["per_100_ml"], "0.369582521027003105")
        self.assertEqual(nutrient(result, "zinc_sulfate_monohydrate")["per_100_ml"], "47")
        self.assertEqual(nutrient(result, "zinc")["per_100_ml"], "17.1189972144846807")
        self.assertEqual(nutrient(result, "pyridoxine_hydrochloride")["per_100_ml"], "12")
        self.assertEqual(nutrient(result, "pyridoxine")["per_100_ml"], "9.8723983660766388")
        self.assertEqual(nutrient(result, "sodium_benzoate")["per_100_ml"], "300")
        self.assertEqual(nutrient(result, "sodium")["per_100_ml"], "47.86211508674532")
        self.assertEqual(nutrient(result, "sucrose")["per_100_ml"], "50000")
        self.assertEqual(len(result["nutrients"]), 23)
        self.assertTrue(
            any(
                item["query"] == "NEPAZENE" and item["identity_status"] == "unresolved"
                for item in result["assumptions"]
            )
        )
        nepazene = next(item for item in result["assumptions"] if item["query"] == "NEPAZENE")
        self.assertEqual(
            [candidate["identity"] for candidate in nepazene["identity_candidates"]],
            ["Sodium methylparaben", "Methylparaben", "Paraben preservative blend"],
        )

    def test_product_report_selects_exactly_twenty_metrics_and_assumptions(self) -> None:
        formula = load_json(ROOT / "examples/formulas/user_tonic_1000l.json")
        definition = load_json(ROOT / "examples/product_reports/user_tonic_top20.json")
        result = build_product_report(
            nutrition_catalog=self.catalog,
            chemical_catalog=self.chemical_catalog,
            formula=formula,
            report_definition=definition,
        )
        metrics = {item["id"]: item for item in result["metrics"]}

        self.assertEqual(len(result["metrics"]), 20)
        self.assertEqual([item["rank"] for item in result["metrics"]], list(range(1, 21)))
        self.assertEqual(metrics["energy"]["per_100_ml"], "194.3")
        self.assertEqual(metrics["energy"]["status"], "partial")
        self.assertEqual(metrics["energy"]["confidence"]["score"], "0.67")
        self.assertEqual(metrics["energy"]["range"]["kind"], "lower_bound")
        self.assertEqual(metrics["protein"]["per_100_ml"], "0")
        self.assertEqual(metrics["cyanocobalamin"]["per_100_ml"], "8.5")
        self.assertEqual(
            result["profile_coverage"]["characterized_percent"],
            "99.80971014316390777613505830200535919033",
        )
        self.assertEqual(
            result["profile_coverage"]["uncharacterized_percent"],
            "0.190289856836092223864941697994640809675",
        )
        self.assertEqual(
            [item["id"] for item in result["profile_coverage"]["uncharacterized_materials"]],
            ["nepazene_unresolved"],
        )
        self.assertEqual(metrics["cyanocobalamin"]["unit"], "ug")
        self.assertEqual(metrics["folic_acid"]["per_100_ml"], "2400")
        self.assertEqual(metrics["iron"]["range"]["lower"], "194.3")
        self.assertEqual(metrics["iron"]["range"]["upper"], "301.5")
        self.assertEqual(metrics["iron"]["range"]["error_minus"], "67")
        self.assertEqual(metrics["iron"]["range"]["error_plus"], "40.2")
        self.assertEqual(metrics["zinc"]["confidence"]["score"], "0.64")
        self.assertEqual(metrics["pyridoxine"]["range"]["kind"], "not_estimated")
        self.assertEqual(metrics["nepazene_unresolved"]["status"], "identity unresolved")
        self.assertEqual(metrics["nepazene_unresolved"]["confidence"]["score"], "0.29")
        self.assertTrue(result["report_assumptions"])
        self.assertEqual(len(result["missing_information"]), 7)
        self.assertTrue(
            any(item["id"] == "nepazene_unresolved" for item in result["missing_information"])
        )
        self.assertEqual(len(result["ingredient_assumptions"]), 13)
        nepazene = next(
            item for item in result["ingredient_assumptions"] if item["query"] == "NEPAZENE"
        )
        self.assertEqual(len(nepazene["identity_candidates"]), 3)
        self.assertIn("10 ingredient identities require review", result["warnings"])

    def test_product_report_exposes_thirty_macro_and_micro_results(self) -> None:
        formula = load_json(ROOT / "examples/formulas/user_tonic_1000l_assumed_complete.json")
        definition = load_json(ROOT / "src/nutrition_formula/data/user_tonic_top30.json")
        result = build_product_report(
            nutrition_catalog=self.catalog,
            chemical_catalog=self.chemical_catalog,
            formula=formula,
            report_definition=definition,
        )
        metrics = {item["id"]: item for item in result["metrics"]}

        self.assertEqual(len(result["metrics"]), 30)
        self.assertFalse(result["display_zero_metrics"])
        self.assertEqual([item["rank"] for item in result["metrics"]], list(range(1, 31)))
        self.assertEqual(metrics["iron"]["range"]["lower"], "194.3")
        self.assertEqual(metrics["zinc"]["range"]["upper"], "19.0341")
        self.assertEqual(metrics["calcium"]["per_100_ml"], "0")
        self.assertEqual(metrics["calcium"]["range"]["kind"], "not_estimated")
        self.assertEqual(metrics["calcium"]["confidence"]["score"], "0.64")
        self.assertIn("under stated", metrics["calcium"]["status"])
        self.assertEqual(metrics["sodium"]["per_100_ml"], "61.0647621205706229345891000976")
        self.assertEqual(metrics["cyanocobalamin"]["per_100_ml"], "8.5")
        self.assertEqual(result["profile_coverage"]["characterized_percent"], "100")
        self.assertEqual(result["profile_coverage"]["uncharacterized_percent"], "0")
        self.assertEqual(result["profile_coverage"]["uncharacterized_materials"], [])

        markdown = _markdown_product(result)
        self.assertIn("| 1 | Energy |", markdown)
        self.assertIn("| 2 | Carbohydrate |", markdown)
        self.assertIn("| 11 | Vitamin B12 as cyanocobalamin |", markdown)
        self.assertNotIn("| Protein |", markdown)
        self.assertNotIn("Screened with zero result", markdown)

    def test_quantity_ranges_propagate_without_float_arithmetic(self) -> None:
        formula = load_json(ROOT / "examples/formulas/electrolyte_beverage_1000l.json")
        formula["ingredients"][1]["quantity"].update({"minimum": "54", "maximum": "56"})
        result = calculate(self.catalog, formula)
        energy = nutrient(result, "energy")

        self.assertEqual(energy["per_100_ml"], "21.285")
        self.assertEqual(energy["per_100_ml_range"]["kind"], "bounded")
        self.assertEqual(energy["per_100_ml_range"]["lower"], "20.898")
        self.assertEqual(energy["per_100_ml_range"]["upper"], "21.672")
        self.assertEqual(result["minimum_input_mass_g"], "999000")
        self.assertEqual(result["maximum_input_mass_g"], "1001000")

    def test_nested_compound_material_is_flattened_and_summed(self) -> None:
        formula = load_json(ROOT / "examples/formulas/chocolate_protein_beverage_1000l.json")
        result = calculate(self.catalog, formula)
        leaves = {item["material_id"]: item["mass_g"] for item in result["leaf_ingredients"]}

        self.assertEqual(leaves["skim_milk_powder"], "35000")
        self.assertEqual(leaves["cocoa_powder"], "15000")
        self.assertNotIn("chocolate_dairy_base", leaves)
        self.assertEqual(nutrient(result, "protein")["total_batch"], "46725")
        self.assertEqual(nutrient(result, "protein")["per_100_ml"], "4.6725")
        self.assertEqual(nutrient(result, "energy")["per_serving"], "133.05")
        self.assertEqual(len(result["assumptions"]), 5)
        self.assertEqual(result["assumptions"][2]["selected_material_id"], "whey_protein_isolate")

    def test_contribution_ledger_reconciles_nested_ingredients_and_retention(self) -> None:
        formula = load_json(ROOT / "examples/formulas/chocolate_protein_beverage_1000l.json")
        formula["nutrient_retention"] = {"protein": "0.9"}
        result = calculate(self.catalog, formula)
        protein = nutrient(result, "protein")

        contributions = protein["contributions"]
        self.assertGreater(len(contributions), 1)
        self.assertEqual(
            sum((Decimal(item["total_batch"]) for item in contributions), Decimal(0)),
            Decimal(protein["total_batch"]),
        )
        nested = next(
            item for item in contributions if item["material_id"] == "skim_milk_powder"
        )
        self.assertEqual(nested["input_material_id"], "chocolate_dairy_base")
        self.assertEqual(
            nested["material_path"], ["chocolate_dairy_base", "skim_milk_powder"]
        )
        self.assertEqual(nested["retention_factor"], "0.9")
        self.assertIn("reference", nested["source"])

    def test_missing_values_are_partial_instead_of_zero(self) -> None:
        formula = load_json(ROOT / "examples/formulas/chocolate_protein_beverage_1000l.json")
        result = calculate(self.catalog, formula)
        riboflavin = nutrient(result, "riboflavin")

        self.assertEqual(riboflavin["status"], "partial")
        self.assertEqual(riboflavin["unknown_materials"], ["whey_protein_isolate"])
        self.assertEqual(
            riboflavin["coverage_percent"], "96.65071770334928229665071770334928229665"
        )

    def test_user_corrections_replace_assumptions_without_changing_math(self) -> None:
        formula = load_json(ROOT / "examples/formulas/chocolate_protein_beverage_1000l.json")
        assumed = calculate(self.catalog, formula)
        corrected_formula = copy.deepcopy(formula)
        for line, assumption in zip(corrected_formula["ingredients"], assumed["assumptions"]):
            line.pop("ingredient")
            line["material_id"] = assumption["selected_material_id"]
        corrected = calculate(self.catalog, corrected_formula)

        self.assertEqual(corrected["assumptions"], [])
        self.assertEqual(corrected["nutrients"], assumed["nutrients"])

    def test_volume_ingredient_requires_density_for_mass_based_profile(self) -> None:
        formula = load_json(ROOT / "examples/formulas/electrolyte_beverage_1000l.json")
        formula["ingredients"] = [
            {"material_id": "granulated_sugar", "quantity": {"value": "1", "unit": "L"}}
        ]
        with self.assertRaisesRegex(CalculationError, "density"):
            calculate(self.catalog, formula)

    def test_invalid_compound_total_fails_closed(self) -> None:
        catalog = copy.deepcopy(self.catalog)
        catalog["materials"]["broken"] = {
            "name": "Broken premix",
            "components": [
                {"material_id": "water", "mass_fraction": "0.7"},
                {"material_id": "granulated_sugar", "mass_fraction": "0.2"},
            ],
        }
        formula = {
            "schema_version": 1,
            "batch": {"name": "Broken", "final_quantity": {"value": "1", "unit": "kg"}},
            "ingredients": [{"material_id": "broken", "quantity": {"value": "1", "unit": "kg"}}],
        }
        with self.assertRaisesRegex(CalculationError, "must total 1"):
            calculate(catalog, formula)

    def test_compound_cycle_fails_closed(self) -> None:
        catalog = copy.deepcopy(self.catalog)
        catalog["materials"]["cycle_a"] = {
            "name": "Cycle A",
            "components": [{"material_id": "cycle_b", "mass_fraction": "1"}],
        }
        catalog["materials"]["cycle_b"] = {
            "name": "Cycle B",
            "components": [{"material_id": "cycle_a", "mass_fraction": "1"}],
        }
        formula = {
            "schema_version": 1,
            "batch": {"name": "Cycle", "final_quantity": {"value": "1", "unit": "kg"}},
            "ingredients": [{"material_id": "cycle_a", "quantity": {"value": "1", "unit": "kg"}}],
        }
        with self.assertRaisesRegex(CalculationError, "cycle detected"):
            calculate(catalog, formula)

    def test_json_floats_are_rejected_to_preserve_decimal_inputs(self) -> None:
        formula = load_json(ROOT / "examples/formulas/electrolyte_beverage_1000l.json")
        formula["ingredients"][0]["quantity"]["value"] = 943.45
        with self.assertRaisesRegex(CalculationError, "JSON string"):
            calculate(self.catalog, formula)

    def test_local_search_uses_names_and_aliases(self) -> None:
        matches = search_materials(self.catalog, "WPI 90")
        self.assertEqual(matches[0]["material_id"], "whey_protein_isolate")
        self.assertEqual(matches[0]["match_type"], "exact")

    def test_unresolvable_ingredient_fails_with_candidates(self) -> None:
        formula = load_json(ROOT / "examples/formulas/electrolyte_beverage_1000l.json")
        formula["ingredients"] = [
            {"ingredient": "mysterious botanical ZXQ", "quantity": {"value": "1", "unit": "kg"}}
        ]
        with self.assertRaisesRegex(CalculationError, "Could not resolve ingredient"):
            calculate(self.catalog, formula)


if __name__ == "__main__":
    unittest.main()
