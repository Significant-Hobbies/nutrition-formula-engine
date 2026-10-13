import assert from "node:assert/strict";
import test from "node:test";

import {
  ADULT_RDA,
  buildNutritionLabel,
  multiplyDivideDecimal,
} from "../public/nutrition-label.js";

test("decimal label calculations do not use binary floating point", () => {
  assert.equal(multiplyDivideDecimal("4.5", "30", "100", 2), "1.35");
  assert.equal(multiplyDivideDecimal("19.7", "100", "2000", 2, "down"), "0.98");
  assert.equal(multiplyDivideDecimal(".5", "30.", "100", 2), "0.15");
  assert.equal(multiplyDivideDecimal("0.1", "3", "100", 4), "0.003");
  assert.equal(multiplyDivideDecimal("75.075", "250", "100", 2), "187.69");
});

test("label model follows the grouped per-serving demographic RDA pattern", () => {
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
  assert.equal(label.servingLabel, "Per serving (25 g)");
  assert.deepEqual(label.ingredients, ["Sugar", "Cocoa powder"]);
  assert.deepEqual(label.nutrients.map((item) => item.id), [
    "protein",
    "carbohydrate",
    "total_fat",
    "thiamin",
    "iron",
  ]);
  assert.equal(label.nutrients[0].perServing, "4.5");
  assert.equal(label.nutrients[0].rdaPercent, "8.33%");
  assert.equal(label.nutrients[4].perServing, "≥2");
  assert.equal(label.nutrients[4].rdaPercent, "≥10.52%");
  assert.equal(label.nutrients[3].perServing, "0.0058");
  assert.equal(label.nutrients[3].rdaPercent, "0.31%");
  assert.equal(label.hasIncompleteData, true);
  assert.equal(label.hasIdentityReview, true);
});

test("reference values preserve the current FSSAI and ICMR source split", () => {
  assert.deepEqual(ADULT_RDA.energy, { value: "2000", unit: "kcal", source: "fssai" });
  assert.deepEqual(ADULT_RDA.sodium, { value: "2000", unit: "mg", source: "fssai" });
  assert.deepEqual(ADULT_RDA.iron, { value: "19", unit: "mg", source: "icmr" });
});

const labelFor = (components, servingSize = "5") => buildNutritionLabel({ basis_label: "per 100 mL", screened_components: components }, { servingSize });
const nutrient = (id, value, unit = "mg", extra = {}) => ({ id, name: id, value, unit, status: "complete", ...extra });

test("single child reference and moderate-work adult references match the supplied vitamin table", () => {
  const label = labelFor([
    nutrient("vitamin_c", "400"), nutrient("niacin", "260"), nutrient("riboflavin", "60"),
    nutrient("vitamin_b6", "24"), nutrient("thiamin", "20"), nutrient("vitamin_b12", "20", "ug"),
    nutrient("vitamin_a_rae", "12000", "ug"), nutrient("biotin", "240", "ug"),
  ]);
  const values = Object.fromEntries(label.nutrients.map((n) => [n.id, n]));
  assert.deepEqual(values.vitamin_c.rda, { men: "25%", women: "30.76%", children: "36.36%" });
  assert.deepEqual(values.thiamin.rda, { men: "55.55%", women: "58.82%", children: "66.66%" });
  assert.deepEqual(values.vitamin_a_rae.rda, { men: "60%", women: "71.42%", children: "77.92%" });
  assert.deepEqual(values.biotin.rda, { men: "30%", women: "30%", children: "34.28%" });
  assert.equal(values.vitamin_b12.rda.men, "45.45%"); // corrected 2.2 µg reference, not the photo's 2 µg
  assert.deepEqual(Object.keys(values.vitamin_c.rda), ["men", "women", "children"]);
});

test("published reference ranges and folic acid DFE conversion remain explicit", () => {
  const values = labelFor([nutrient("vitamin_e", "100"), nutrient("folic_acid", "1000", "ug")]).nutrients;
  assert.equal(values.find((n) => n.id === "vitamin_e").rda.men, "50%–66.66%");
  assert.equal(values.find((n) => n.id === "folic_acid").rda.men, "28.33%");
  assert.equal(values.find((n) => n.id === "folic_acid").perServing, "50");
});

test("categories and actual nonzero mineral contributions survive grouping", () => {
  const contributions = [
    { material_name: "Zinc gluconate", total_batch: "4", source: { kind: "supplier_specification", reference: "Lot spec" } },
    { material_name: "Zinc gluconate", total_batch: "2" },
    { material_name: "Cocoa powder", total_batch: "1", source: { kind: "reference_database" } },
    { material_name: "Zero source", total_batch: "0" },
  ];
  const label = labelFor([nutrient("zinc", "40", "mg", { contributions }), nutrient("vitamin_c", "400"), nutrient("protein", "0", "g"), nutrient("lycopene", "500", "ug")]);
  assert.deepEqual(label.groups.map((g) => g.name), ["Main nutrients", "Vitamins", "Minerals", "Other components"]);
  const zinc = label.nutrients.find((n) => n.id === "zinc");
  assert.equal(zinc.sourceLabel, "as Zinc gluconate; from Cocoa powder");
  assert.equal(zinc.sources[0].provenance.reference, "Lot spec");
  assert.deepEqual(zinc.rda, { men: "11.76%", women: "15.15%", children: "23.52%" });
});

test("unknown quantities never become zero, including unknown micronutrients", () => {
  const label = labelFor([
    nutrient("protein", "0", "g", { status: "partial" }),
    nutrient("vitamin_c", "0", "mg", { status: "partial" }),
    nutrient("iron", null), nutrient("sodium", "0"), nutrient("total_fat", "0.22", "g"),
  ]);
  for (const id of ["protein", "vitamin_c", "iron"]) {
    const n = label.nutrients.find((n) => n.id === id);
    assert.equal(n.perServing, "Not established");
    assert.equal(n.rda.men, "Not established");
  }
  assert.equal(label.nutrients.find((n) => n.id === "sodium").perServing, "0");
  assert.equal(label.nutrients.find((n) => n.id === "sodium").rda.men, "0%");
  assert.equal(label.nutrients.find((n) => n.id === "total_fat").perServing, "0.011");
  assert.equal(label.hasIncompleteData, true);
});

test("percentages use unrounded amounts and exact unit conversions", () => {
  const c = labelFor([nutrient("vitamin_c", "0.4", "g")]).nutrients[0];
  assert.equal(c.rda.men, "25%");
  assert.equal(c.perServing, "0.02");
  const tiny = labelFor([nutrient("vitamin_c", "0.00001")]).nutrients[0];
  assert.equal(tiny.perServing, "<0.0001");
  assert.equal(tiny.rda.men, "<0.01%");
  const mismatch = labelFor([nutrient("vitamin_c", "100", "IU")]).nutrients[0];
  assert.equal(mismatch.rda.men, "—");
  assert.throws(() => labelFor([nutrient("protein", "1", "g")], "0"), /greater than zero/);
});

test("dose values use exact batch totals and keep weighed ingredients separate from nutrients", () => {
  const result = {
    basis_label: "per 100 mL", label_batch_quantity: "15", declared_nutrient_ids: ["vitamin_b6"],
    screened_components: [
      nutrient("vitamin_b6", "6.666666666666666666666666667", "mg", { total_batch: "1", status: "partial" }),
      nutrient("vitamin_c", "0", "mg", { status: "partial" }),
      nutrient("protein", "0", "g", { total_batch: "0", status: "partial" }),
    ],
    label_entries: [
      { name: "LYSINE HCL", interpretation: "Lysine hydrochloride", category: "Amino acids", batch_amount: "25", unit: "mg" },
      { name: "D-PANTHENOL", interpretation: "D-panthenol", category: "Vitamins", batch_amount: "2.5", unit: "mg" },
      { name: "SOD BENZ", interpretation: "Sodium benzoate", category: "Preservatives", batch_amount: "45", unit: "mg" },
    ],
  };
  const label = buildNutritionLabel(result, { servingSize: "15" });
  const b6 = label.nutrients.find((n) => n.id === "vitamin_b6");
  assert.equal(b6.perServing, "≥1");
  assert.equal(b6.rda.children, "≥50%"); // no 49.99% from repeated per-100 division
  assert.equal(label.nutrients.some((n) => n.id === "vitamin_c"), false);
  assert.equal(label.nutrients.find((n) => n.id === "protein").perServing, "Not established");
  assert.deepEqual(label.weighedIngredients.map((n) => n.perServing), ["25", "2.5", "45"]);
  assert.equal(label.weighedIngredients[1].rda.men, "—"); // panthenol is not declared pantothenic acid
  assert.equal(buildNutritionLabel(result, { servingSize: "5" }).weighedIngredients[0].perServing, "8.3333");
});
