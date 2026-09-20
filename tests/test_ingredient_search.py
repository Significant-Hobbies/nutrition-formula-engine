from __future__ import annotations

import unittest

from nutrition_formula.ingredient_search import search_local_ingredients


class IngredientSearchTests(unittest.TestCase):
    def test_search_returns_candidates_without_applying_them(self) -> None:
        result = search_local_ingredients("sugar", kind="food")

        self.assertTrue(result["candidate_only"])
        self.assertTrue(result["confirmation_required"])
        self.assertFalse(result["external_search_available"])
        self.assertEqual(result["candidates"][0]["material_id"], "granulated_sugar")
        self.assertTrue(result["candidates"][0]["has_composition_profile"])

    def test_search_keeps_chemical_identity_and_profile_status_visible(self) -> None:
        result = search_local_ingredients("Nepazene", kind="chemical")
        candidate = result["candidates"][0]
        assumed = next(
            item
            for item in result["candidates"]
            if item["material_id"] == "sodium_methylparaben_assumed"
        )

        self.assertEqual(candidate["material_id"], "nepazene_unresolved")
        self.assertEqual(candidate["identity_status"], "unresolved")
        self.assertEqual(assumed["identity_status"], "assumed")
        self.assertTrue(candidate["candidate_only"])

    def test_invalid_search_fails_visibly(self) -> None:
        with self.assertRaisesRegex(ValueError, "required"):
            search_local_ingredients(" ")
        with self.assertRaisesRegex(ValueError, "kind"):
            search_local_ingredients("sugar", kind="medicine")


if __name__ == "__main__":
    unittest.main()
