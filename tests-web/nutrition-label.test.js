import assert from "node:assert/strict";
import test from "node:test";

import {
  ADULT_RDA,
  buildNutritionLabel,
  multiplyDivideDecimal,
} from "../public/nutrition-label.js";

test("decimal label calculations do not use binary floating point", () => {
  assert.equal(multiplyDivideDecimal("4.5", "30", "100", 2), "1.35");
  assert.equal(multiplyDivideDecimal(".5", "30.", "100", 2), "0.15");
  assert.equal(multiplyDivideDecimal("0.1", "3", "100", 4), "0.003");
  assert.equal(multiplyDivideDecimal("75.075", "250", "100", 2), "187.69");
});

test("label model follows the retail per-100, per-serve, and adult RDA pattern", () => {
  const result = {
    product_name: "Cocoa mix",
    basis_label: "per 100 g",
    formula_rows: [
      { item: "FINISHED BATCH" },
      { item: "Cocoa", interpretation: "Cocoa powder", confidence: "exact", needs_review: false },
      { item: "Supplier blend", confidence: "low", needs_review: true },
    ],
    label_ingredients: [
      { name: "Sugar" },
      { name: "Cocoa powder" },
    ],
    screened_components: [
      { id: "protein", name: "Protein", value: "18", unit: "g", status: "complete" },
      { id: "iron", name: "Iron", value: "8", unit: "mg", status: "partial" },
      { id: "total_fat", name: "Total fat", value: "2", unit: "g", status: "complete" },
      { id: "carbohydrate", name: "Carbohydrate", value: "62", unit: "g", status: "complete" },
      { id: "thiamin", name: "Vitamin B1", value: "0.023", unit: "mg", status: "complete" },
    ],
  };

  const label = buildNutritionLabel(result, {
    servingSize: "25",
    servingsPerPack: "20",
  });

  assert.equal(label.productName, "Cocoa mix");
  assert.equal(label.basisLabel, "Per 100 g");
  assert.equal(label.servingLabel, "Per serve (25 g)");
  assert.deepEqual(label.ingredients, ["Sugar", "Cocoa powder"]);
  assert.deepEqual(label.nutrients.map((item) => item.id), [
    "protein",
    "carbohydrate",
    "total_fat",
    "iron",
    "thiamin",
  ]);
  assert.equal(label.nutrients[0].perServing, "4.5");
  assert.equal(label.nutrients[0].rdaPercent, "8%");
  assert.equal(label.nutrients[3].perServing, "≥2");
  assert.equal(label.nutrients[3].rdaPercent, "≥11%");
  assert.equal(label.nutrients[4].perServing, "0.01");
  assert.equal(label.nutrients[4].rdaPercent, "<1%");
  assert.equal(label.hasIncompleteData, true);
  assert.equal(label.hasIdentityReview, true);
});

test("reference values preserve the current FSSAI and ICMR source split", () => {
  assert.deepEqual(ADULT_RDA.energy, { value: "2000", unit: "kcal", source: "fssai" });
  assert.deepEqual(ADULT_RDA.sodium, { value: "2000", unit: "mg", source: "fssai" });
  assert.deepEqual(ADULT_RDA.iron, { value: "19", unit: "mg", source: "icmr" });
});
