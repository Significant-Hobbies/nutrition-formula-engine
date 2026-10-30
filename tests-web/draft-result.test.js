import assert from "node:assert/strict";
import test from "node:test";
import { normalizeText } from "../public/input-normalizer.js";
import { buildInputOnlyResult, validateReviewedRows, defaultIdentityRows } from "../public/draft-result.js";
import { buildNutritionLabel } from "../public/nutrition-label.js";
import { buildResultReadiness } from "../public/result-readiness.js";

test("input-only draft preserves reviewed quantities/provenance without nutrient or identity inventions", () => {
  const rows = normalizeText("1 mL\nUnknown carrier 2 mg\nSugar 0.2 g\nExtract 0.1 mL").rows;
  const before = JSON.stringify(rows);
  const result = buildInputOnlyResult(rows);
  const label = buildNutritionLabel(result, { servingSize: "1" });
  assert.equal(JSON.stringify(rows), before);
  assert.equal(result.calculation.engine_version, "input-only fallback");
  assert.equal(result.coverage.characterized_percent, null);
  assert.ok(result.formula_rows.every((row) => row.material_id === null));
  assert.deepEqual(result.formula_rows.map((row) => row.input_source), rows.map((row) => row.input_source));
  assert.deepEqual(result.screened_components, []);
  assert.deepEqual(label.nutrients, []);
  assert.deepEqual(label.groups.flatMap((group) => group.nutrients).map((row) => [row.name, row.perServing, row.unit]), [
    ["Unknown carrier", "2", "mg"], ["Sugar", "0.2", "g"], ["Extract", "0.1", "mL"],
  ]);
  assert.ok(label.groups.flatMap((group) => group.nutrients).every((row) => Object.values(row.rda).every((rda) => rda === "—")));
  assert.match(label.unavailableSummary, /not nutrient totals/);
  assert.equal(buildResultReadiness(result).requests.length, 1);
  assert.equal(buildResultReadiness(result).partial, true);
});

test("batch draft keeps mass and volume inputs separate without inventing density or rescaling supplied amounts", () => {
  const result = buildInputOnlyResult(normalizeText("FINISHED BATCH 1 kg\nExtract 2 mL\nCarrier 3 g").rows, { inputBasis: "batch" });
  const label = buildNutritionLabel(result, { servingSize: "10" });
  assert.equal(result.label_batch_quantity, "1000");
  assert.match(label.groups[0].name, /batch \(1000 g\)/);
  assert.equal(label.groups[0].nutrients[0].perServing, "2");
  assert.equal(label.groups[0].nutrients[0].unit, "mL");
});

for (const [name, edit] of [
  ["zero dose", (rows) => { rows[0].quantity = "0"; }],
  ["negative dose", (rows) => { rows[0].quantity = "-1"; }],
  ["negative ingredient", (rows) => { rows[1].quantity = "-1"; }],
  ["missing unit", (rows) => { rows[1].unit = ""; }],
  ["invalid unit", (rows) => { rows[1].unit = "FOO"; }],
  ["invalid quantity", (rows) => { rows[1].quantity = "NaN"; }],
  ["missing dose", (rows) => { rows.shift(); }],
]) test(`${name} requires correction instead of a fabricated draft`, () => {
  const rows = normalizeText("1 mL\nSugar 2 mg").rows;
  edit(rows);
  assert.throws(() => buildInputOnlyResult(rows), /row|batch|quantity/i);
});

test("explicit zero ingredient quantity is retained as supplied, never inferred as zero nutrients", () => {
  const rows = normalizeText("1 mL\nSugar 0 mg").rows;
  validateReviewedRows(rows);
  const label = buildNutritionLabel(buildInputOnlyResult(rows), { servingSize: "1" });
  assert.equal(label.groups[0].nutrients[0].perServing, "0");
  assert.deepEqual(label.nutrients, []);
});

test("a small positive dose retains its exact decimal basis instead of rounding to zero", () => {
  const dose = "0.000000000000000000000000001";
  const result = buildInputOnlyResult(normalizeText(`${dose} mL\nSugar 2 mg`).rows);
  assert.equal(result.label_batch_quantity, dose);
  assert.ok(buildNutritionLabel(result, { servingSize: dose }).groups.length);
});

test("automatic identity confirmation distinguishes exact assay assumptions from fuzzy suggestions", () => {
  const result = { formula_rows: [{}, { material_id: "declared", confidence: "low" }, { material_id: "water", confidence: "low" }, { material_id: "accepted", confidence: "exact" }],
    ingredient_assumptions: [{ line_index: 0, score: "1.000000" }, { line_index: 1, score: "0.588235" }] };
  assert.deepEqual(defaultIdentityRows(result).map((row) => row.material_id), ["declared", "accepted"]);
});

for (const text of ["1 mL\nSugar 2 mg\nCarrier 1", "1 mL\nSugar 2 mg\nCarrier 1 FOO", "1 mL\nSugar 2 mg\nCarrier NaN mg", "Item\tQuantity\tUnit\nFINISHED BATCH\t1\tmL\nSugar\t2\tmg\nCarrier\t2\t"]) {
  test(`malformed ingredient cannot silently disappear: ${JSON.stringify(text)}`, () => {
    assert.throws(() => normalizeText(text), /row.*quantity.*unit/i);
  });
}
