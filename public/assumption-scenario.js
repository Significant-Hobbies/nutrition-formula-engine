import { identityReviewKey, multiplyDivideDecimal, pendingIdentityRows } from "./nutrition-label.js";

// This convention applies only to the supported isolated-ingredient liquid.
// Food profiles, unidentified ingredients and arbitrary saved profiles must not
// acquire assumed zeros through this control.
const SUPPORTED_MATERIALS = new Set([
  "lysine_hcl_pure_assumed", "vitamin_b1_declared", "vitamin_b2_declared",
  "vitamin_b6_declared", "vitamin_b12_declared", "niacinamide_pure",
  "d_panthenol_pure_assumed", "sodium_methylparaben_assumed",
  "propylparaben_assumed", "bronopol", "sodium_benzoate", "benzoic_acid",
  "saccharin_unspecified", "aspartame_pure_assumed", "mixed_fruit_essence",
]);
export const SCENARIO_MACROS = new Set([
  "energy", "protein", "carbohydrate", "total_sugars", "added_sugars",
  "dietary_fibre", "total_fat", "saturated_fat", "trans_fat",
]);
const PAPAIN_MATERIALS = new Set([
  "papain_pure_assumed", "lysine_free_pure_assumed", "niacinamide_pure",
  "vitamin_b1_declared", "vitamin_b6_declared",
]);
const MINERAL_AMINO_MATERIALS = new Set([
  "iron_fac_declared", "zinc_sulphate_declared", "lysine_free_pure_assumed",
  "vitamin_b6_declared", "vitamin_b12_declared", "folic_acid_declared",
]);
export const MINERAL_AMINO_ASSUMPTIONS = [
  "Water q.s. to the entered dose volume; no sugar syrup, oil or unlisted nutritive excipients.",
  "Iron and zinc quantities are declared elemental amounts, with ferric ammonium citrate and zinc sulphate as their sources. Salt weights, assay, hydrate and ingredient order require confirmation.",
  "L-lysine is free active L-lysine; vitamins and folic acid are active amounts without nutritive carriers. Supplier forms and assays are unverified.",
  "Energy is a screening estimate from free lysine at 4 kcal/g. The unreported citrate ligand and other sources are assigned no energy in this scenario; the result is not a complete analytical total.",
  "Other macros and sodium are assigned zero only under these water-base, isolated-active assumptions; they are estimates, not measured zeros. Free lysine is separate from intact protein.",
  "Folic acid mass is retained as entered. Its RDA percentage uses dietary folate equivalents at 1.7 times folic acid, following the label reference.",
];
export const PAPAIN_ASSUMPTIONS = [
  "Water q.s. to the entered finished volume; no sugar syrup, oil or unlisted nutritive excipients.",
  "Pure ingredients without carriers. Papain is assumed to be pure enzyme protein; its entered mass contributes to intact protein. Commercial enzyme grades may differ.",
  "Lysine is assumed to be free active L-lysine, not a hydrochloride salt. Vitamin amounts are active amounts; forms, dilutions and assays remain unverified.",
  "Energy is a screening estimate at 4 kcal/g for enzyme protein and free lysine. Other listed ingredients are assigned no energy. Free lysine is listed separately from intact protein.",
  "Other macros and sodium are assigned zero only under this pure-ingredient water-base scenario; these are estimates, not measured zeros.",
  "Papain activity units, pH, compatibility, preservation, stability and shelf life are not established by the ingredient list.",
];

export function scenarioAssumptions(result) {
  if (result?.formula_rows?.some((row) => ["iron_fac_declared", "zinc_sulphate_declared"].includes(row.material_id)))
    return MINERAL_AMINO_ASSUMPTIONS;
  return result?.formula_rows?.some((row) => row.material_id === "papain_pure_assumed")
    ? PAPAIN_ASSUMPTIONS : SCENARIO_ASSUMPTIONS;
}

export const SCENARIO_ASSUMPTIONS = [
  "Water q.s. to the entered finished volume; no sugar syrup, oil or unlisted nutritive excipients.",
  "Pure ingredients without premix carriers; mixed-fruit essence is aqueous and nonnutritive. Zero macros are scenario assumptions, not measured zeros.",
  "Vitamin quantities are active amounts. Raw-material carriers and unreported counterions are excluded; the agreed preservative and sweetener identities are retained.",
  "Lysine HCl is anhydrous monohydrochloride at 100% assay; D-panthenol is the pure D-isomer. B5 is a theoretical equivalent, not a measured bioavailability value.",
  "Energy is a screening estimate: free lysine and aspartame at 4 kcal/g; other listed ingredients are assigned no nutritional energy. This is not a complete analytical total.",
  "Protein here means intact protein, with free lysine listed separately. A final nutrition-label protein declaration still requires the appropriate method.",
];

function sumDecimals(...values) {
  const parts = values.map((value) => {
    const match = /^(\d+)(?:\.(\d+))?$/.exec(String(value));
    if (!match) throw new Error("A scenario input is not a nonnegative decimal.");
    return { digits: BigInt(match[1] + (match[2] || "")), scale: (match[2] || "").length };
  });
  const scale = Math.max(...parts.map((part) => part.scale));
  const total = parts.reduce((sum, part) => sum + part.digits * 10n ** BigInt(scale - part.scale), 0n);
  if (!scale) return String(total);
  const digits = String(total).padStart(scale + 1, "0");
  return `${digits.slice(0, -scale)}.${digits.slice(-scale)}`.replace(/\.?0+$/, "");
}

export function scenarioEligibility(result, options = {}) {
  if (!result || result.basis_label !== "per 100 mL") return { allowed: false, reason: "This estimate requires a finished liquid volume." };
  const rows = (result.formula_rows || []).slice(1);
  const supported = rows.some((row) => ["iron_fac_declared", "zinc_sulphate_declared"].includes(row.material_id))
    ? MINERAL_AMINO_MATERIALS : rows.some((row) => row.material_id === "papain_pure_assumed") ? PAPAIN_MATERIALS : SUPPORTED_MATERIALS;
  if (!rows.length || rows.some((row) => !supported.has(row.material_id))) {
    return { allowed: false, reason: "This assumption recipe does not cover every ingredient. Supply composition data for the other ingredients." };
  }
  if (pendingIdentityRows(result, options.confirmedIdentities || new Set()).length) {
    return { allowed: false, reason: "Confirm the ingredient interpretations before using this estimate." };
  }
  if (!options.waterBase) return { allowed: false, reason: "Select water to finished volume before using this estimate." };
  return { allowed: true, reason: "Optional working estimate. Accept the assumptions below to show estimated macros." };
}

export function buildAssumptionScenario(result, options = {}) {
  if (!options.assumptionEstimate || !scenarioEligibility(result, options).allowed) return result;
  const scenario = structuredClone(result);
  const assumptions = scenarioAssumptions(result);
  const components = scenario.screened_components || [];
  const batch = result.label_batch_quantity;
  const lysine = components.find((item) => item.id === "lysine");
  const lysineEnergy = lysine?.total_batch == null ? "0"
    : multiplyDivideDecimal(lysine.total_batch, "4", "1000", 28);
  const papain = result.label_entries?.find((entry) => entry.category === "Enzymes" &&
    result.formula_rows.some((row) => row.item === entry.name && row.material_id === "papain_pure_assumed"));
  const papainProtein = papain ? multiplyDivideDecimal(papain.batch_amount, "1", "1000", 28) : "0";
  const papainEnergy = multiplyDivideDecimal(papainProtein, "4", "1", 28);
  const changed = [];
  for (const component of components) {
    if (!SCENARIO_MACROS.has(component.id) && component.id !== "sodium") continue;
    if (component.total_batch == null) {
      // No source contribution is different from a source-confirmed zero.
      component.total_batch = component.value == null ? "0"
        : multiplyDivideDecimal(component.value, batch, "100", 28);
    }
    const assumedZeroMaterials = [...(component.unknown_materials || [])];
    if (papain && ["energy", "protein"].includes(component.id)) {
      const total = component.id === "energy" ? papainEnergy : papainProtein;
      component.total_batch = sumDecimals(component.total_batch, total);
      const lineIndex = result.formula_rows.findIndex((row) => row.material_id === "papain_pure_assumed") - 1;
      const contribution = {
        line_index: lineIndex, input_material_id: "papain_pure_assumed", material_id: "papain_pure_assumed",
        input_material_name: "Papain", material_name: "Papain", material_path: ["papain_pure_assumed"],
        input_mass_g: papainProtein, total_batch: total, unit: component.unit,
        per_100_ml: multiplyDivideDecimal(total, "100", batch, 28),
        source: { kind: "operator_assumption", reference: "Pure papain assumed as enzyme protein, at 4 kcal/g for screening energy; not a supplier assay.", url: "https://www.worthingtonweb.com/PAP/default.html" },
      };
      component.contributions ||= [];
      component.contributions.push(contribution);
      const index = assumedZeroMaterials.indexOf("papain_pure_assumed");
      if (index >= 0) assumedZeroMaterials.splice(index, 1);
    }
    if (component.id === "energy" && lysine && lysineEnergy !== "0") {
      component.total_batch = sumDecimals(component.total_batch, lysineEnergy);
      component.contributions ||= [];
      for (const entry of lysine.contributions || []) {
        const energy = multiplyDivideDecimal(entry.total_batch, "4", "1000", 28);
        const contribution = { ...structuredClone(entry), total_batch: energy, unit: "kcal", profile_unit: "kcal",
          per_100_ml: multiplyDivideDecimal(energy, "100", batch, 28),
          source: { kind: "operator_assumption", reference: "Scenario energy convention: free lysine at 4 kcal/g; not an assayed energy value." } };
        for (const field of ["profile_value", "profile_minimum", "profile_maximum", "minimum_total_batch", "maximum_total_batch", "per_100_g", "per_serving"])
          if (entry[field] != null) contribution[field] = multiplyDivideDecimal(entry[field], "4", "1000", 28);
        component.contributions.push(contribution);
        const index = assumedZeroMaterials.indexOf(entry.input_material_id);
        if (index >= 0) assumedZeroMaterials.splice(index, 1);
      }
    }
    component.value = multiplyDivideDecimal(component.total_batch, "100", batch, 28);
    component.status = "estimated";
    component.unknown_materials = [];
    component.range = null;
    component.range_label = "Assumption estimate; not an assay";
    component.display_precision = component.id === "energy" && assumptions !== MINERAL_AMINO_ASSUMPTIONS ? 1 : 2;
    component.assumption = { kind: "operator_assumption", assumed_zero_materials: assumedZeroMaterials,
      reference: assumptions.join(" ") };
    if (component.id === "protein") component.name = "Intact protein";
    changed.push(component.id);
  }
  for (const component of components) {
    if (["pantothenic_acid", "lysine", "chloride"].includes(component.id)) component.display_precision = 2;
    if (component.id === "chloride") component.name = "Chloride from lysine HCl";
  }
  scenario.assumption_scenario = {
    active: true, version: 1, title: "Assumption-based working estimate",
    assumptions, estimated_nutrient_ids: changed,
    source_catalog_fingerprint: result.calculation?.nutrition_catalog_fingerprint,
    source_values_preserved: true,
    confirmation_keys: (result.formula_rows || []).slice(1).map(identityReviewKey),
  };
  scenario.report_assumptions = [...assumptions,
    ...(result.report_assumptions || []).filter((note) => !note.startsWith("Only non-zero components"))];
  scenario.present_components = components.filter((component) => SCENARIO_MACROS.has(component.id) || /[1-9]/.test(String(component.value || "0")));
  return scenario;
}
