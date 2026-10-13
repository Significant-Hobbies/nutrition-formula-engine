// Identification references only. An INS entry does not establish permission
// for a product category, use level, salt form, supplier grade or finished label.
export const INS_REFERENCE = Object.freeze({
  title: "FSSAI food-additive identification list, Version XII (8 September 2020)",
  url: "https://www.fssai.gov.in/upload/uploadfiles/files/Compendium_Food_Additives_Regulations_08_09_2020-compressed.pdf",
  scope: "Identifier and functional class; current category permissions and limits are not evaluated.",
});

const additive = (ins, functionalClass, note = "") => Object.freeze({ ins, functionalClass, note });
const PAPAIN_REFERENCE = Object.freeze({
  title: "FAO/WHO JECFA papain specification (INS 1101(ii))",
  url: "https://www.fao.org/fileadmin/user_upload/jecfa_additives/docs/Monograph1/Additive-302.pdf",
  scope: "Ingredient identifier only; activity, grade and category permissions require confirmation.",
});
const FAC_REFERENCE = Object.freeze({
  title: "FAO/WHO JECFA ferric ammonium citrate (INS 381)",
  url: "https://www.fao.org/food/food-safety-quality/scientific-advice/jecfa/jecfa-additives/detail/en/c/92/",
  scope: "Salt identifier only; it is not an identifier for elemental iron or proof of use permission.",
});
const REFERENCES = Object.freeze({
  sodium_benzoate: additive("211", "Preservative"),
  benzoic_acid: additive("210", "Preservative"),
  sodium_methylparaben_assumed: additive("219", "Preservative", "INS 219 applies to sodium methylparaben. Verify the Nepazene identity and sodium salt with the supplier."),
  propylparaben_assumed: additive("216", "Preservative", "INS 216 applies to propylparaben; sodium propylparaben is INS 217. Verify which form Nepasol contains."),
  aspartame_pure_assumed: additive("951", "Sweetener", "Verify ASPARTUM is aspartame and confirm its carrier and purity."),
  saccharin_unspecified: additive("954", "Sweetener", "INS 954 is the saccharin group. Confirm the exact salt: saccharin 954(i), calcium 954(ii), potassium 954(iii), sodium 954(iv)."),
  xanthan_gum_fibre_assumed: additive("415", "Thickener", "Verify the supplier grade and actual technological function."),
  papain_pure_assumed: { ...additive("1101(ii)", "Enzyme"), source: PAPAIN_REFERENCE, identifierOnly: true },
  iron_fac_declared: { ...additive("381", "Iron source"), source: FAC_REFERENCE, identifierOnly: true },
  ferric_ammonium_citrate_brown_mid: { ...additive("381", "Iron source"), source: FAC_REFERENCE, identifierOnly: true },
  lysine_hcl_pure_assumed: { ...additive("642", "Amino acid source"), identifierOnly: true },
  lysine_hcl_unassayed: { ...additive("642", "Amino acid source"), identifierOnly: true },
});
const NUTRIENTS = new Set([
  "vitamin_b1_declared", "vitamin_b6_declared", "vitamin_b12_declared",
  "niacinamide_pure", "d_panthenol_pure_assumed", "lysine_free_pure_assumed",
  "folic_acid_declared", "folic_acid_pure", "cyanocobalamin_pure",
  "pyridoxine_hydrochloride", "zinc_sulphate_declared", "zinc_sulphate_monohydrate_355",
]);

export function describeLabelIngredient(item, identityAccepted) {
  const name = item.label_name || item.name || item.item || "Unidentified ingredient";
  const materialId = item.material_id;
  const reference = REFERENCES[materialId];
  if (reference && identityAccepted) return {
    materialId, name, ins: reference.ins, functionalClass: reference.functionalClass,
    statement: reference.identifierOnly ? `${name} (INS ${reference.ins})`
      : `${reference.functionalClass} (${name}; INS ${reference.ins})`,
    insStatus: "assigned", insStatusLabel: `INS ${reference.ins}`,
    identityBasis: reference.note ? "accepted interpretation; supplier confirmation needed" : "selected ingredient profile",
    note: reference.note, source: reference.source || INS_REFERENCE,
  };
  if (reference) return {
    materialId, name, ins: null, functionalClass: reference.functionalClass,
    statement: `${name} (identity to confirm)`, identityBasis: "unconfirmed",
    insStatus: "identity_required", insStatusLabel: "Confirm ingredient identity",
    note: `${name}: confirm the ingredient interpretation before assigning its INS number.`, source: null,
  };
  if (materialId === "bronopol") return {
    materialId, name, ins: null, functionalClass: "Preservative",
    statement: `Preservative (${name}; INS unverified)`, identityBasis: "selected ingredient profile",
    insStatus: "unverified", insStatusLabel: "INS not verified",
    note: "Bronopol: no food-additive INS mapping is verified in this reference. Confirm suitability for the intended product category before finalizing the label.", source: null,
  };
  if (materialId === "vitamin_b2_declared") return {
    materialId, name, ins: null, functionalClass: null, statement: name,
    insStatus: "form_required", insStatusLabel: "Form needed (riboflavins INS 101 group)",
    note: "Vitamin B2: confirm synthetic riboflavin 101(i), riboflavin 5′-phosphate sodium 101(ii), or Bacillus subtilis riboflavin 101(iii). An active vitamin amount does not identify the form.",
    source: INS_REFERENCE,
  };
  if (NUTRIENTS.has(materialId)) return {
    materialId, name, ins: null, functionalClass: null, statement: name,
    insStatus: "nutrient", insStatusLabel: "Nutrient — no INS assigned",
    note: "", source: null,
  };
  if (materialId === "mixed_fruit_essence") return {
    materialId, name, ins: null, functionalClass: "Flavour", statement: name,
    insStatus: "mixture", insStatusLabel: "Flavour mixture — no single INS",
    note: "", source: null,
  };
  if (materialId === "water") return {
    materialId, name, ins: null, functionalClass: null, statement: name,
    insStatus: "not_applicable", insStatusLabel: "Base — INS not applicable",
    note: "", source: null,
  };
  return { materialId, name, ins: null, functionalClass: null, statement: name,
    insStatus: "unverified", insStatusLabel: "INS not verified for supplied ingredient",
    note: "", source: null };
}

export function ingredientIdentifierSummary(details) {
  const assigned = details.filter((item) => item.insStatus === "assigned");
  const parts = [`INS assigned: ${assigned.length} ingredient${assigned.length === 1 ? "" : "s"} (codes in ingredient statement).`];
  for (const [status, title] of [
    ["nutrient", "No INS assigned for nutritional use"],
    ["form_required", "Exact form needed"],
    ["identity_required", "Ingredient identity needed"],
    ["mixture", "No single INS for flavour mixture"],
    ["unverified", "INS not verified"],
    ["not_applicable", "INS not applicable"],
  ]) {
    const names = details.filter((item) => item.insStatus === status).map((item) => item.name);
    if (names.length) parts.push(`${title}: ${names.join(", ")}.`);
  }
  return parts.join(" ");
}
