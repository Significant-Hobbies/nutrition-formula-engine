import { DEMOGRAPHIC_RDA, LABEL_REFERENCE } from "./rda-reference.js";
import { describeLabelIngredient, ingredientIdentifierSummary, INS_REFERENCE } from "./additive-reference.js";
import { buildLabelDetails } from "./label-details.js";
export { DEMOGRAPHIC_RDA, LABEL_REFERENCE } from "./rda-reference.js";

const POWERS_OF_TEN = [1n];

function powerOfTen(exponent) {
  while (POWERS_OF_TEN.length <= exponent) {
    POWERS_OF_TEN.push(POWERS_OF_TEN.at(-1) * 10n);
  }
  return POWERS_OF_TEN[exponent];
}

function decimalParts(value) {
  const text = String(value ?? "").trim();
  const match = /^(?:(\d+)(?:\.(\d*))?|\.(\d+))$/.exec(text);
  if (!match) throw new Error(`Invalid decimal value: ${text || "empty"}`);
  const whole = match[1] || "0";
  const fraction = match[2] ?? match[3] ?? "";
  return {
    coefficient: BigInt(`${whole}${fraction}`),
    scale: fraction.length,
  };
}

function roundedRatio(numerator, denominator, decimalPlaces, rounding) {
  if (denominator <= 0n) throw new Error("The divisor must be greater than zero.");
  const scale = powerOfTen(decimalPlaces);
  const scaled = numerator * scale;
  const quotient = scaled / denominator;
  const remainder = scaled % denominator;
  const rounded = (rounding === "up" && remainder > 0n) || (rounding === "half-up" && remainder * 2n >= denominator) ? quotient + 1n : quotient;
  if (decimalPlaces === 0) return rounded.toString();
  const digits = rounded.toString().padStart(decimalPlaces + 1, "0");
  const whole = digits.slice(0, -decimalPlaces);
  const fraction = digits.slice(-decimalPlaces).replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole;
}

export function multiplyDivideDecimal(value, multiplier, divisor, decimalPlaces = 2, rounding = "half-up") {
  const left = decimalParts(value);
  const right = decimalParts(multiplier);
  const bottom = decimalParts(divisor);
  const numerator = left.coefficient * right.coefficient * powerOfTen(bottom.scale);
  const denominator = bottom.coefficient * powerOfTen(left.scale + right.scale);
  return roundedRatio(numerator, denominator, decimalPlaces, rounding);
}

function isPositiveDecimal(value) {
  try {
    return decimalParts(value).coefficient > 0n;
  } catch {
    return false;
  }
}

function isNonZeroDecimal(value) {
  try {
    return decimalParts(value).coefficient !== 0n;
  } catch {
    return false;
  }
}

// Compatibility for callers that used the former single adult reference.
export const ADULT_RDA = DEMOGRAPHIC_RDA.men;

const REQUIRED_ORDER = [
  "energy",
  "protein",
  "carbohydrate",
  "total_sugars",
  "added_sugars",
  "dietary_fibre",
  "total_fat",
  "saturated_fat",
  "trans_fat",
  "cholesterol",
  "sodium",
];
const MAIN_ORDER = [...REQUIRED_ORDER, "monounsaturated_fat", "polyunsaturated_fat"];

const VITAMIN_ORDER = ["vitamin_c", "niacin", "vitamin_e", "riboflavin", "vitamin_b6", "thiamin", "vitamin_b12", "vitamin_a_rae", "biotin", "folic_acid", "folate_dfe", "pantothenic_acid", "vitamin_d", "vitamin_k"];
const MINERAL_ORDER = ["calcium", "iron", "magnesium", "phosphorus", "potassium", "zinc", "manganese", "iodine", "selenium", "molybdenum", "copper", "chromium", "chloride"];
const CATEGORY_ORDER = ["Main nutrients", "Vitamins", "Minerals", "Amino acids", "Preservatives", "Sweeteners", "Flavour", "Other components"];

function componentCategory(id) {
  if (MAIN_ORDER.includes(id)) return "Main nutrients";
  if (VITAMIN_ORDER.includes(id)) return "Vitamins";
  if (MINERAL_ORDER.includes(id)) return "Minerals";
  if (id === "lysine") return "Amino acids";
  return "Other components";
}

function componentOrder(component) {
  const category = componentCategory(component.id);
  const order = category === "Main nutrients" ? MAIN_ORDER
    : category === "Vitamins" ? VITAMIN_ORDER : MINERAL_ORDER;
  const index = order.indexOf(component.id);
  return CATEGORY_ORDER.indexOf(category) * 100 + (index === -1 ? 99 : index);
}

function displayUnit(unit) {
  return ["ug", "mcg"].includes(unit) ? "µg" : unit;
}

function exactProduct(value, multiplier) {
  return multiplyDivideDecimal(value, multiplier, "1", decimalParts(value).scale + decimalParts(multiplier).scale);
}

function referenceAmount(component) {
  const units = { g: "1", mg: "1000", ug: "1000000", mcg: "1000000", "µg": "1000000" };
  const id = component.id === "folic_acid" ? "folate_dfe" : component.id;
  const referenceUnit = DEMOGRAPHIC_RDA.men[id]?.unit;
  if (!referenceUnit) return null;
  let value = component.value;
  if (component.unit !== referenceUnit) {
    if (!units[component.unit] || !units[referenceUnit]) return null;
    // Scaling by powers of ten is exact; retain all input decimal places.
    value = multiplyDivideDecimal(value, units[referenceUnit], units[component.unit], decimalParts(value).scale + 6);
  }
  return component.id === "folic_acid" ? exactProduct(value, "1.7") : value;
}

function rdaLabel(component, servingSize, demographic, batchQuantity) {
  const reference = DEMOGRAPHIC_RDA[demographic][component.id === "folic_acid" ? "folate_dfe" : component.id];
  if (!reference) return "—";
  if (component.value == null || (component.status === "partial" && !isNonZeroDecimal(component.value))) return "Not established";
  const fromBatch = isPositiveDecimal(batchQuantity) && component.total_batch != null;
  const value = referenceAmount(fromBatch ? { ...component, value: component.total_batch } : component);
  if (value === null) return "—";
  const format = (divisor) => {
    // per-100 amount × serving / 100 × 100 / RDA; never round the amount first.
    // The supplied pack truncates RDA percentages to two decimal places.
    const percent = multiplyDivideDecimal(value, fromBatch ? exactProduct(servingSize, "100") : servingSize,
      fromBatch ? exactProduct(batchQuantity, divisor) : divisor, 2, "down");
    if (percent === "0" && isNonZeroDecimal(value)) {
      if (component.status === "partial") return "Known <0.01%";
      return `${component.status === "estimated" ? "≈" : ""}<0.01%`;
    }
    if (component.status === "estimated") return `≈${percent}%`;
    if (component.status === "partial") return `≥${percent}%`;
    return percent === "0" && isNonZeroDecimal(value) ? "<0.01%" : `${percent}%`;
  };
  return reference.value ? format(reference.value) : `${format(reference.maximum)}–${format(reference.minimum)}`;
}

function amountLabel(component, multiplier, batchQuantity) {
  if (component.value == null || (component.status === "partial" && !isNonZeroDecimal(component.value))) return "Not established";
  const precision = component.display_precision ?? 4;
  const fromBatch = isPositiveDecimal(batchQuantity) && component.total_batch != null;
  const amount = multiplyDivideDecimal(fromBatch ? component.total_batch : component.value, multiplier,
    fromBatch ? batchQuantity : "100", precision, component.status === "partial" ? "down" : "half-up");
  if (amount === "0" && isNonZeroDecimal(component.value)) {
    const threshold = precision === 0 ? "1" : `0.${"0".repeat(precision - 1)}1`;
    return component.status === "partial" ? `Known contribution <${threshold}`
      : `${component.status === "estimated" ? "≈" : ""}<${threshold}`;
  }
  return `${component.status === "partial" ? "≥" : component.status === "estimated" ? "≈" : ""}${amount}`;
}

function mineralSources(component, confirmedMaterialIds) {
  if (!MINERAL_ORDER.includes(component.id)) return [];
  const unique = new Map();
  for (const contribution of component.contributions || []) {
    if (!isPositiveDecimal(contribution.total_batch)) continue;
    const name = contribution.source?.label_source || contribution.material_name || contribution.input_material_name;
    const identifier = describeLabelIngredient({ name, material_id: contribution.material_id }, confirmedMaterialIds.has(contribution.input_material_id));
    if (name && !unique.has(name)) unique.set(name, {
      name,
      ins: identifier.ins,
      relation: contribution.source?.kind === "reference_database" ? "from" : "as",
      provenance: contribution.source,
    });
  }
  return [...unique.values()];
}

function labelIngredientName(row) {
  if (row.confidence === "exact" && row.interpretation) return row.interpretation;
  return row.item;
}

// A confirmation belongs to this exact row/interpretation, not just its name.
export function identityReviewKey(row) {
  return JSON.stringify([row.item?.toLowerCase(), row.material_id, row.interpretation,
    row.submitted_quantity, row.submitted_unit, row.profile_version, row.source, row.identity_note]);
}

export function pendingIdentityRows(result, confirmedIdentities = new Set()) {
  return (result.formula_rows || []).slice(1)
    .filter((row) => row.unresolved || (row.needs_review && !confirmedIdentities.has(identityReviewKey(row))));
}

export function buildNutritionLabel(result, options = {}) {
  const confirmedIdentities = options.confirmedIdentities || new Set();
  const formulaRows = (result.formula_rows || []).slice(1);
  const confirmed = (row) => !row.needs_review || confirmedIdentities.has(identityReviewKey(row));
  const servingSize = String(options.servingSize || "30").trim();
  if (!isPositiveDecimal(servingSize)) {
    throw new Error("Serving size must be a number greater than zero.");
  }

  const basisUnit = result.basis_label === "per 100 mL" ? "mL" : "g";
  const productName = String(options.productName || result.product_name || "Product").trim();
  const servingsPerPack = String(options.servingsPerPack || "").trim();
  if (servingsPerPack && !isPositiveDecimal(servingsPerPack)) {
    throw new Error("Servings per pack must be a number greater than zero.");
  }

  const indexed = (result.screened_components || []).map((component, index) => ({
    component,
    index,
  }));
  indexed.sort((left, right) => {
    const byRequired = componentOrder(left.component) - componentOrder(right.component);
    return byRequired || left.index - right.index;
  });

  const nutrients = indexed
    .filter(({ component }) => REQUIRED_ORDER.includes(component.id) ||
      (component.value == null && (!result.declared_nutrient_ids || result.declared_nutrient_ids.includes(component.id))) ||
      (component.status === "partial" && (!result.declared_nutrient_ids || result.declared_nutrient_ids.includes(component.id))) || isNonZeroDecimal(component.value))
    .map(({ component: suppliedComponent }) => {
      // Unaccepted fuzzy identities are suggestions, never label quantities.
      const unconfirmedSource = (suppliedComponent.contributions || []).some((entry) => {
        const row = formulaRows[entry.line_index];
        return row && !confirmed(row);
      });
      const original = unconfirmedSource
        ? { ...suppliedComponent, value: null, total_batch: null, status: "partial" } : suppliedComponent;
      // Keep the report's incomplete totals intact. A confirmed declared active
      // amount is a separate label basis, not a claim of complete assay coverage.
      const contributions = (original.contributions || []).filter((entry) => isPositiveDecimal(entry.total_batch));
      const isDeclared = contributions.length > 0 && contributions.every((entry) =>
        entry.source?.kind === "declared_active_assumption" &&
        formulaRows.some((row) => row.material_id === entry.input_material_id &&
          result.formula_rows.indexOf(row) === entry.line_index + 1 && confirmed(row)));
      const isEstimated = contributions.length > 0 && contributions.every((entry) =>
        entry.source?.kind === "theoretical_conversion_assumption" &&
        formulaRows.some((row) => row.material_id === entry.input_material_id &&
          result.formula_rows.indexOf(row) === entry.line_index + 1 && confirmed(row)));
      const component = isDeclared ? { ...original, status: "declared" }
        : isEstimated ? { ...original, status: "estimated" } : original;
      const sources = mineralSources(component, new Set(formulaRows.filter(confirmed).map((row) => row.material_id)));
      const rda = Object.fromEntries(Object.keys(DEMOGRAPHIC_RDA).map((demographic) => [demographic, rdaLabel(component, servingSize, demographic, result.label_batch_quantity)]));
      return {
        id: component.id,
        name: component.name,
        category: componentCategory(component.id),
        sources,
        sourceLabel: sources.map((source) => `${source.relation} ${source.name}${source.ins ? `; INS ${source.ins}` : ""}`).join("; "),
        unit: displayUnit(component.unit),
        perBasis: amountLabel(component, "100"),
        perServing: amountLabel(component, servingSize, result.label_batch_quantity),
        rda: result.assumption_scenario?.active && ["energy", "protein"].includes(component.id)
          ? { men: "—", women: "—", children: "—" } : rda,
        rdaPercent: rda.men,
        referenceSource: DEMOGRAPHIC_RDA.men[component.id === "folic_acid" ? "folate_dfe" : component.id]?.source || null,
        status: component.value == null ? "partial" : component.status,
      };
    });
  const weighedIngredients = (result.label_entries || []).map((entry, index) => ({
    id: `weighed-${index}`, name: entry.category === "Enzymes" ? entry.interpretation : entry.name, category: entry.category,
    sourceLabel: [entry.category !== "Enzymes" && entry.interpretation !== entry.name ? entry.interpretation : "",
      entry.needs_review && !formulaRows.some((row) => row.item === entry.name && confirmed(row)) ? "identity to confirm" : "",
      entry.identity_note?.startsWith("Provitamin B5") ? "B5 equivalent not established" : ""].filter(Boolean).join("; "),
    unit: displayUnit(entry.unit),
    perBasis: multiplyDivideDecimal(entry.batch_amount, "100", result.label_batch_quantity, 4),
    perServing: multiplyDivideDecimal(entry.batch_amount, servingSize, result.label_batch_quantity, 4),
    rda: { men: "—", women: "—", children: "—" },
    status: "weighed", identityNote: entry.identity_note,
  }));
  const unavailableNutrients = nutrients.filter((nutrient) => nutrient.perServing === "Not established");
  const visibleNutrients = nutrients.filter((nutrient) => nutrient.perServing !== "Not established");
  // Nutrition rows contain nutrient equivalents only. Raw formulation inputs
  // remain in the ingredient statement and calculation report.
  const groups = CATEGORY_ORDER.map((name) => ({ name, nutrients: visibleNutrients.filter((nutrient) => nutrient.category === name) }))
    .filter((group) => group.nutrients.length);
  const enzymes = weighedIngredients.filter((item) => item.category === "Enzymes");
  if (enzymes.length) groups.push({ name: "Enzymes (ingredient weight)", nutrients: enzymes });
  const suppliedRows = result.input_only || !visibleNutrients.length ? formulaRows
    : formulaRows.filter((row) => row.unresolved || !confirmed(row));
  if (suppliedRows.length) groups.push({
    name: `Ingredients supplied per entered ${result.input_basis === "dose" ? "dose" : "batch"} (${result.label_batch_quantity} ${basisUnit})`,
    nutrients: suppliedRows.map((row, index) => ({
      id: `supplied-${index}`, name: row.item, unit: displayUnit(row.submitted_unit || row.unit),
      perServing: row.submitted_quantity ?? row.quantity, perBasis: row.submitted_quantity ?? row.quantity,
      status: "supplied", supplied: true, rda: { men: "—", women: "—", children: "—" },
    })),
  });

  const ingredientInputs = result.label_ingredients?.length ? result.label_ingredients
    : formulaRows.map((row) => ({ ...row, name: labelIngredientName(row) }));
  const ingredientDetails = ingredientInputs.map((item) => {
    const matchingRows = formulaRows.filter((row) => row.material_id === item.material_id);
    if (item.material_id && matchingRows.some((row) => row.unresolved || !confirmed(row))) {
      const name = [...new Set(matchingRows.map((row) => row.item))].join(" / ");
      return { materialId: item.material_id, name, ins: null, functionalClass: null,
        statement: `${name} (identity/composition to confirm)`, identityBasis: "unconfirmed",
        insStatus: "identity_required", insStatusLabel: "Confirm ingredient identity",
        note: "The supplied name is retained; no nutrient identity or INS number is accepted for this ingredient.", source: null };
    }
    return describeLabelIngredient(item, matchingRows.length > 0 && matchingRows.every((row) => !row.unresolved && confirmed(row)));
  });
  const ingredients = ingredientDetails.map((item) => item.statement);
  const waterBase = options.waterBase && basisUnit === "mL";
  if (waterBase) {
    const water = describeLabelIngredient({ material_id: "water", name: "Water" }, true);
    water.statement = `Water (q.s. to finished ${result.label_batch_quantity} mL)`;
    ingredients.push(water.statement);
    ingredientDetails.push(water);
  }

  return {
    productName,
    basisLabel: result.input_only ? "Supplied quantity" : `Per 100 ${basisUnit}`,
    servingLabel: result.input_only ? "Supplied quantity" : `Per serving (${servingSize} ${basisUnit})`,
    servingSize,
    servingUnit: basisUnit,
    servingsPerPack,
    ingredients,
    ingredientDetails,
    ingredientIdentifierSummary: ingredientIdentifierSummary(ingredientDetails),
    additiveReference: INS_REFERENCE,
    additiveIssues: ingredientDetails.filter((item) => item.note).map((item) => ({ ingredient: item.name, needed: item.note })),
    productDetails: buildLabelDetails(options.productDetails, ingredientDetails),
    nutrients,
    groups,
    weighedIngredients,
    unavailableNutrients,
    inputOnly: Boolean(result.input_only),
    unavailableSummary: result.input_only ? result.missing_information[0].needed : unavailableNutrients.length
      ? `Not established: ${unavailableNutrients.map((nutrient) => nutrient.name).join(", ")}. Missing composition is unknown, not zero; supplier data is required.` : "",
    waterBase,
    hasDeclaredActives: nutrients.some((nutrient) => nutrient.status === "declared"),
    hasEstimatedActives: nutrients.some((nutrient) => nutrient.status === "estimated"),
    hasIncompleteData: Boolean(result.input_only) || nutrients.some((nutrient) => nutrient.status === "partial"),
    hasIdentityReview: pendingIdentityRows(result, confirmedIdentities).length > 0,
    hasDeclaredActiveAssumptions: formulaRows.some((row) =>
      (row.interpretation?.includes("declared active") || row.interpretation?.includes("pure active basis")) && !confirmed(row)),
    reference: LABEL_REFERENCE,
  };
}
