import { identityReviewKey, pendingIdentityRows } from "./nutrition-label.js";

const MACROS = new Set(["energy", "protein", "carbohydrate", "total_sugars", "added_sugars", "dietary_fibre", "total_fat", "saturated_fat", "trans_fat"]);
const ASSUMPTION_SOURCES = new Set(["declared_active_assumption", "theoretical_conversion_assumption", "nutrition_reference_assumption"]);
const positive = (value) => /^\d*(?:\.\d*)?$/.test(String(value)) && /[1-9]/.test(String(value));
const key = (value) => String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

export function componentEvidence(component, result, confirmedIdentities = new Set()) {
  const contributions = (component.contributions || []).filter((entry) => positive(entry.total_batch ?? entry.per_100_ml ?? entry.per_100_g));
  const assumptions = contributions.some((entry) => ASSUMPTION_SOURCES.has(entry.source?.kind));
  const pending = contributions.some((entry) => {
    const row = result.formula_rows?.[entry.line_index + 1];
    return row?.needs_review && !confirmedIdentities.has(identityReviewKey(row));
  });
  const incomplete = component.status === "partial" || component.value == null || Boolean(component.unknown_materials?.length);
  const declared = contributions.length > 0 && contributions.every((entry) => entry.source?.kind === "declared_active_assumption");
  if (component.assumption?.kind === "operator_assumption") return {
    incomplete: false, assumed: true, label: "Scenario estimate",
    description: "Uses the explicitly accepted scenario assumptions; supplier data is still needed.",
  };
  return {
    incomplete,
    assumed: assumptions || pending,
    label: declared && !pending ? "Declared contribution" : assumptions || pending ? "Assumed contribution" : incomplete ? "Known contribution" : "Calculated",
    description: incomplete ? "Other ingredients may contribute; this is not a complete total." : "Calculated from the supplied composition profile.",
  };
}

export function buildResultReadiness(result, options = {}) {
  if (result.input_only) return {
    title: "Input-only draft — nutrition not calculated",
    summary: `${result.input_only_reason || "Nutrition could not be calculated."} Your reviewed ingredient quantities are ready to print or download; nutrient totals and RDA have not been calculated.`,
    requests: result.missing_information, pendingIdentityCount: 0, incompleteMacros: [], incompleteNutrients: [],
    availableCount: 0, partial: true, scenario: false, assumptions: [],
    nextAction: "Resolve the calculation correction above, then retry Confirm and calculate. Reviewed input is retained.",
    legend: "As supplied = ingredient quantity from your reviewed formula. No ingredient identity, nutrient equivalent, zero value or RDA has been inferred.",
  };
  const confirmedIdentities = options.confirmedIdentities || new Set();
  const pending = pendingIdentityRows(result, confirmedIdentities);
  const screened = result.screened_components || [];
  const incomplete = screened.filter((component) => component.status === "partial" || component.value == null || component.unknown_materials?.length);
  const incompleteMacros = incomplete.filter((component) => MACROS.has(component.id));
  const available = screened.filter((component) => positive(component.value));
  const requests = [];
  const rows = (result.formula_rows || []).slice(1);
  const add = (item, needed, affects = [], category = "composition") => {
    const existing = requests.find((request) => key(request.item) === key(item));
    if (existing) {
      existing.affects = [...new Set([...existing.affects, ...affects])];
      if (!existing.needed.includes(needed)) existing.needed += ` ${needed}`;
    } else requests.push({ item, needed, affects: [...new Set(affects)], category });
  };
  for (const item of result.missing_information || []) {
    const row = rows.find((entry) => key(entry.interpretation) === key(item.item) || key(entry.item) === key(item.item));
    add(row?.item || item.item, item.needed || "Provide the supplier composition specification and lot CoA.", item.affects || []);
  }
  const declaredRows = [];
  for (const row of rows) {
    const contributions = screened.flatMap((component) => (component.contributions || [])
      .filter((entry) => entry.input_material_id === row.material_id && ASSUMPTION_SOURCES.has(entry.source?.kind)));
    if (row.identity_note || contributions.length) {
      const kinds = new Set(contributions.map((entry) => entry.source.kind));
      if (kinds.has("declared_active_assumption")) {
        declaredRows.push(row);
        continue;
      }
      if (requests.some((request) => key(request.item) === key(row.item))) continue;
      const needed = `Supply the ingredient specification and lot CoA to verify the grade, chemical form, purity/assay and any carrier. ${row.identity_note || "The current contribution uses an assumed reference profile."}`;
      add(row.item, needed, screened.filter((component) => (component.contributions || []).some((entry) => entry.input_material_id === row.material_id && positive(entry.total_batch ?? entry.per_100_ml ?? entry.per_100_g))).map((component) => component.name));
    }
  }
  if (declaredRows.length) add(`Declared actives (${declaredRows.map((row) => row.item).join(", ")})`,
    "The entered amounts are treated as active nutrients, not raw-material/premix weights. Supply each active ingredient form, potency/assay, actual raw-material weight and any carrier composition.",
    ["Vitamin amounts", "% RDA", "Complete macro totals"], "assay");
  for (const row of pending) {
    if (declaredRows.includes(row)) continue;
    add(row.item, row.unresolved
      ? "No catalog identity was selected. Provide the exact ingredient name and supplier grade."
      : `Identity to confirm: ${row.interpretation}.`, [], "identity");
  }
  if (incomplete.length && !(result.missing_information || []).length) {
    add("Ingredient composition", "Provide the complete composition of every ingredient contributing to these unresolved nutrients; an omitted nutrient is not a confirmed zero.", incomplete.map((component) => component.name));
  }
  const liquid = result.basis_label === "per 100 mL";
  const waterBase = liquid && options.waterBase;
  if (liquid) add("Liquid base and finished yield", waterBase
    ? "Water to finished volume is an operator assumption. Confirm there is no sugar syrup, sorbitol or other carrier, and confirm the final volume after processing."
    : "Confirm the complete liquid base: water, sugar syrup, sorbitol or another carrier, its quantity/composition, and the final volume after processing.", ["Per-serving amounts", "Energy", "Carbohydrate", "Total sugars", "Total fat"], "batch");
  else add("Finished yield and processing", "Confirm the finished batch weight and any nutrient loss/retention during processing or storage.", ["Per-serving amounts", "Nutrient totals"], "batch");
  if (!positive(options.servingSize)) add("Serving size", "Specify the intended dose/serving and its unit before calculating per-serving amounts and RDA.", ["Per-serving amounts", "% RDA"], "serving");
  const scenario = result.assumption_scenario?.active;
  const title = scenario ? "Assumption-based working estimate"
    : incompleteMacros.length ? "Partial result — macros incomplete"
    : incomplete.length ? "Partial result — nutrient data incomplete"
    : pending.length ? "Calculated draft — ingredient review needed"
    : "Calculated draft — source review required";
  const summary = scenario
    ? "Macros use your accepted water, purity and carrier assumptions. Vitamins use the entered active quantities. Supplier composition and assays are still needed for final declarations."
    : `${available.length} nutrient contribution${available.length === 1 ? "" : "s"} calculated. ${incompleteMacros.length
    ? `Complete totals need more composition data for: ${incompleteMacros.map((component) => component.name).join(", ")}.`
    : incomplete.length ? `${incomplete.length} screened nutrient totals remain unresolved.` : "Screened nutrient totals are covered by the selected profiles; this does not verify supplier assays or label compliance."}`;
  return {
    title, summary, requests,
    pendingIdentityCount: pending.length,
    incompleteMacros: incompleteMacros.map((component) => ({ id: component.id, name: component.name })),
    incompleteNutrients: incomplete.map((component) => ({ id: component.id, name: component.name })),
    availableCount: available.length,
    partial: incomplete.length > 0,
    scenario,
    assumptions: result.assumption_scenario?.assumptions || [],
    nextAction: pending.length
      ? `Review ${pending.length} ingredient interpretation${pending.length === 1 ? "" : "s"}, then request the specifications listed below. Confirming a name does not complete its nutrient data.`
      : "Use the sender checklist below to obtain composition and assay data before finalizing the label.",
    legend: scenario
      ? "≈ = assumption estimate, including assumed zero macros. Declared vitamins use entered active quantities. Source data is retained separately; supplier information is still required."
      : "Calculated = from selected source data. Declared = entered active quantity. Assumed = unverified identity, purity or conversion. ≥ = known contribution under those profiles, not a complete or assayed total. Missing = unresolved, never zero.",
  };
}

export function senderChecklist(readiness, productName) {
  return [`Information needed for ${productName || "this formula"}`, "", readiness.title, readiness.summary, "",
    ...readiness.assumptions.flatMap((assumption) => [`Working assumption: ${assumption}`]), "",
    "Please provide supplier specifications/CoAs with amounts, units and the composition basis (per 100 g, per 100 mL or active assay). Distinguish confirmed zeros from unmeasured or unreported nutrients.", "",
    ...readiness.requests.flatMap((request, index) => [`${index + 1}. ${request.item}`, request.needed,
      ...(request.affects.length ? [`Needed for: ${request.affects.length > 10 ? "complete macros and other screened nutrient totals" : request.affects.join(", ")}.`] : []), ""]),
    "Calculated values are theoretical contributions; this draft is not a laboratory assay or regulatory approval.", ""].join("\n");
}

export function readinessMarkdown(readiness, productName) {
  return ["## Result readiness", "", `**${readiness.title}**`, "", readiness.summary, "", readiness.legend, "",
    `## Information to request for ${productName || "this formula"}`, "",
    ...readiness.requests.flatMap((request) => [`- **${request.item}:** ${request.needed}`,
      ...(request.affects.length ? [`  Needed for: ${request.affects.join(", ")}.`] : [])]), ""].join("\n");
}
