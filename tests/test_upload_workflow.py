from __future__ import annotations

import unittest
from pathlib import Path

from nutrition_formula.http_api import (
    bearer_token,
    sync_owner_id,
    validate_accepted_aliases,
    validate_analysis_body,
    validate_material_save_body,
    validate_version_body,
)
from nutrition_formula.tsv import FormulaUploadError, parse_formula_tsv
from nutrition_formula.upload_analysis import analyze_formula_upload

ROOT = Path(__file__).resolve().parents[1]


class UploadWorkflowTests(unittest.TestCase):
    def test_api_body_requires_reviewed_formula_fields(self) -> None:
        self.assertEqual(
            validate_analysis_body({"file_name": "batch.tsv", "contents": "reviewed rows"}),
            ("batch.tsv", "reviewed rows"),
        )
        with self.assertRaisesRegex(FormulaUploadError, "JSON object"):
            validate_analysis_body(["not", "an", "object"])
        with self.assertRaisesRegex(FormulaUploadError, "file_name and contents"):
            validate_analysis_body({"file_name": "batch.tsv"})

    def test_version_request_requires_optimistic_version_and_bearer_token(self) -> None:
        self.assertEqual(
            validate_version_body(
                {
                    "file_name": "batch.tsv",
                    "contents": "reviewed rows",
                    "expected_version": 2,
                    "cause": "identity_replaced",
                    "decisions": [{"action": "replace"}],
                }
            ),
            (
                "batch.tsv",
                "reviewed rows",
                2,
                "identity_replaced",
                [{"action": "replace"}],
            ),
        )
        self.assertEqual(bearer_token("Bearer private-token"), "private-token")
        with self.assertRaisesRegex(FormulaUploadError, "positive integer"):
            validate_version_body(
                {"file_name": "batch.tsv", "contents": "rows", "expected_version": 0}
            )
        with self.assertRaisesRegex(FormulaUploadError, "access token"):
            bearer_token(None)

    def test_sync_keys_are_validated_and_scoped_deterministically(self) -> None:
        key = "a" * 43
        self.assertEqual(sync_owner_id(key), sync_owner_id(key))
        self.assertNotEqual(sync_owner_id(key), sync_owner_id("b" * 43))
        with self.assertRaisesRegex(FormulaUploadError, "sync key"):
            sync_owner_id("short")

    def test_saved_alias_and_material_profile_requests_are_bounded(self) -> None:
        self.assertEqual(
            validate_accepted_aliases(
                {"accepted_aliases": [{"alias": "Supplier C", "material_id": "ascorbic_acid"}]}
            ),
            {"Supplier C": "ascorbic_acid"},
        )
        self.assertEqual(
            validate_material_save_body(
                {
                    "material_id": "ascorbic_acid",
                    "submitted_alias": "Supplier C",
                    "kind": "food",
                }
            ),
            ("ascorbic_acid", "Supplier C", "food"),
        )
        with self.assertRaisesRegex(FormulaUploadError, "at most 100"):
            validate_accepted_aliases(
                {
                    "accepted_aliases": [
                        {"alias": f"Alias {index}", "material_id": "ascorbic_acid"}
                        for index in range(101)
                    ]
                }
            )

    def test_sample_tonic_upload_returns_present_components_and_visible_assumptions(self) -> None:
        text = (ROOT / "public" / "sample-tonic.tsv").read_text(encoding="utf-8")

        result = analyze_formula_upload(text, "sample-tonic.tsv")
        present = {item["id"]: item for item in result["present_components"]}
        screened = {item["id"]: item for item in result["screened_components"]}

        self.assertEqual(result["product_inference"]["name"], "Oral haematinic syrup/tonic")
        self.assertEqual(result["coverage"]["characterized_percent"], "100")
        self.assertEqual(len(result["present_components"]), 11)
        self.assertEqual(len(result["screened_components"]), 30)
        self.assertEqual(present["iron"]["value"], "261.3")
        self.assertEqual(present["iron"]["range_label"], "194.3–301.5 mg")
        self.assertEqual(present["zinc"]["range_label"], "10.6867–19.0341 mg")
        self.assertTrue(present["iron"]["contributions"])
        self.assertEqual(
            present["iron"]["contributions"][0]["material_name"],
            "Ferric ammonium citrate, brown grade at 19.5% iron",
        )
        self.assertNotIn("protein", present)
        self.assertEqual(screened["protein"]["value"], "0")
        nepazene = next(row for row in result["formula_rows"] if row["item"] == "NEPAZENE")
        self.assertEqual(nepazene["interpretation"], "Sodium methylparaben")
        self.assertEqual(nepazene["confidence"], "low")
        self.assertTrue(nepazene["needs_review"])
        self.assertEqual(
            nepazene["alternatives"], ["Methylparaben", "Paraben preservative blend"]
        )
        self.assertIn("10 ingredient identities require review", result["warnings"])
        self.assertIn("Present macro- and micronutrients", result["markdown"])
        self.assertIn("Calculation contributions", result["markdown"])

    def test_mass_batch_uses_generic_per_100_g_result(self) -> None:
        text = (
            "Item\tQuantity\tUnit\n"
            "FINISHED BATCH\t100\tkg\n"
            "Sugar\t50\tkg\n"
            "Cocoa powder\t50\tkg\n"
        )

        result = analyze_formula_upload(text, "cocoa-mix.tsv")
        present = {item["id"]: item for item in result["present_components"]}

        self.assertEqual(result["basis_label"], "per 100 g")
        self.assertEqual(result["product_inference"]["name"], "Food or beverage formulation")
        self.assertEqual(present["protein"]["value"], "9.8")
        self.assertEqual(present["carbohydrate"]["value"], "78.94")

    def test_saved_alias_reuses_a_profile_without_identity_review(self) -> None:
        text = (
            "Item\tQuantity\tUnit\n"
            "FINISHED BATCH\t100\tkg\n"
            "Supplier B6\t100\tg\n"
        )
        result = analyze_formula_upload(
            text,
            "saved-alias.tsv",
            accepted_aliases={"Supplier B6": "pyridoxine_hydrochloride"},
        )
        row = result["formula_rows"][1]
        self.assertEqual(row["material_id"], "pyridoxine_hydrochloride")
        self.assertEqual(row["confidence"], "exact")
        self.assertFalse(row["needs_review"])

    def test_parser_accepts_common_manufacturing_unit_aliases(self) -> None:
        parsed = parse_formula_tsv(
            "Item\tQuantity\tUnit\nFINISHED BATCH\t1,000\tLITRE\nSugar\t500\tKG\n",
            "batch.tsv",
        )

        self.assertEqual(parsed["formula"]["batch"]["final_quantity"], {"value": "1000", "unit": "l"})
        self.assertEqual(parsed["rows"][1]["normalized_equivalent"], "500000 g")

    def test_parser_rejects_non_tsv_extension(self) -> None:
        with self.assertRaisesRegex(FormulaUploadError, "Upload a .tsv file"):
            parse_formula_tsv(
                "Item\tQuantity\tUnit\nFINISHED BATCH\t1000\tL\nSugar\t500\tkg\n",
                "batch.csv",
            )

    def test_parser_reports_row_specific_invalid_unit(self) -> None:
        with self.assertRaisesRegex(FormulaUploadError, "Row 3: unsupported unit"):
            parse_formula_tsv(
                "Item\tQuantity\tUnit\nFINISHED BATCH\t1000\tL\nSugar\t500\tbag\n",
                "batch.tsv",
            )

    def test_parser_requires_finished_batch_first(self) -> None:
        with self.assertRaisesRegex(FormulaUploadError, "Row 2 must define FINISHED BATCH"):
            parse_formula_tsv(
                "Item\tQuantity\tUnit\nSugar\t500\tkg\nWater\t500\tL\n",
                "batch.tsv",
            )


if __name__ == "__main__":
    unittest.main()
