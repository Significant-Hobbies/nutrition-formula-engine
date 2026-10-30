import { normalizeUnit } from "./input-normalizer.js";
import { multiplyDivideDecimal } from "./nutrition-label.js";
import { inputProvenance } from "./input-provenance.js";

export function validateReviewedRows(rows) {
  if (!Array.isArray(rows) || rows.length < 2) throw new Error("Keep a finished-batch row and at least one ingredient.");
  if (!/^finished\s+batch$/i.test(rows[0].item?.trim())) throw new Error("The first row must be FINISHED BATCH. Correct the recovered item before calculating.");
  for (const [index, row] of rows.entries()) {
    const quantity = String(row.submitted_quantity ?? row.quantity ?? "").trim();
    if (!row.item?.trim() || !/^(?:\d+(?:\.\d*)?|\.\d+)$/.test(quantity) ||
      (index === 0 && !/[1-9]/.test(quantity))) {
      throw new Error(`Row ${index + 1}: enter an ingredient name and a nonnegative decimal quantity; the dose or finished batch must be greater than zero.`);
    }
    if (!normalizeUnit(row.submitted_unit ?? row.unit)) throw new Error(`Row ${index + 1}: choose a supported mass or volume unit.`);
  }
}

export function buildInputOnlyResult(rows, { fileName = "formula.tsv", inputBasis = "dose" } = {}) {
  validateReviewedRows(rows);
  const sourceRows = rows.map((row, index) => {
    const quantity = String(row.submitted_quantity ?? row.quantity).trim();
    const unit = row.submitted_unit ?? row.unit;
    return { item: row.item, quantity, unit: normalizeUnit(unit), submitted_quantity: quantity, submitted_unit: unit,
      normalized_equivalent: `${quantity} ${unit} (as supplied)`, interpretation: "As supplied; composition not calculated",
      material_id: null, confidence: index === 0 ? "exact" : "unresolved", unresolved: index > 0, needs_review: index > 0,
      alternatives: [], identity_note: null, profile_version: null, reusable_profile: false,
      source: "Operator-provided quantity; no ingredient identity or nutrient profile assigned.",
      ...(row.input_source ? { input_source: structuredClone(row.input_source) } : {}) };
  });
  const batch = sourceRows[0];
  const volume = ["L", "mL"].includes(batch.unit);
  const factors = { kg: "1000", g: "1", mg: "0.001", ug: "0.000001", L: "1000", mL: "1" };
  const precision = (batch.quantity.split(".")[1] || "").length + (factors[batch.unit].split(".")[1] || "").length;
  const quantity = multiplyDivideDecimal(batch.quantity, factors[batch.unit], "1", precision);
  const note = "Nutrient amounts and % RDA are not established. Quantities below are ingredients as supplied, not nutrient totals; obtain ingredient identities, composition and assays, then retry calculation.";
  return {
    schema_version: 1, input_only: true, input_basis: inputBasis,
    product_name: "Formula — input-only draft", file_name: fileName,
    calculation: { engine_version: "input-only fallback", arithmetic: "Decimal quantity scaling only", source: { kind: "operator_provided", reference: "Reviewed input; calculation service unavailable." } },
    basis_label: volume ? "per 100 mL" : "per 100 g", label_batch_quantity: quantity,
    formula_rows: sourceRows, label_ingredients: sourceRows.slice(1).map((row) => ({ name: row.item })),
    label_entries: [], declared_nutrient_ids: [], screened_components: [], present_components: [], ingredient_assumptions: [],
    coverage: { characterized_percent: null, uncharacterized_percent: null },
    report_assumptions: ["Input-only draft: the calculation service is unavailable. Original reviewed quantities and units are retained; no nutrient values or ingredient identities have been inferred."],
    missing_information: [{ item: "Nutrition composition", needed: note, affects: [] }], warnings: [note],
    input_provenance: inputProvenance(sourceRows),
  };
}

// A low confidence assay assumption may still be an exact name match. Only
// exact names or previously accepted decisions get automatic label confirmation.
export function defaultIdentityRows(result) {
  return (result.formula_rows || []).filter((row, index) => row.material_id && !row.unresolved &&
    (row.confidence === "exact" || result.ingredient_assumptions?.some((item) =>
      item.line_index === index - 1 && item.score === "1.000000")));
}
