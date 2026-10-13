// ICMR-NIN 2020, including the 2 August 2021 corrigendum, as collated by
// FSSAI in July 2023: Annex IA (PDF p. 9) and Annex IB (PDF p. 10).
// Keep these decimal strings and source distinctions intact.
export const RDA_SOURCE_URL = "https://www.fssai.gov.in/upload/advisories/2023/07/64ae49674ddb3Direction%20_regarding_extension%20of%20time-period%20for%20the%20compliance%20of%20RDA%202020_organized.pdf";

const reference = (value, unit, source = "icmr") => Object.freeze({ value, unit, source });
const COMMON_RDA = {
  calcium: reference("1000", "mg"),
  phosphorus: reference("1000", "mg"),
  potassium: reference("3500", "mg"),
  copper: reference("1.7", "mg"),
  manganese: reference("4", "mg"),
  selenium: reference("40", "ug"),
  chromium: reference("50", "ug"),
  molybdenum: reference("45", "ug", "codex"),
  vitamin_b12: reference("2.2", "ug"),
  vitamin_d: reference("15", "ug"), // 600 IU / 40 IU per µg
  vitamin_e: Object.freeze({ minimum: "7.5", maximum: "10", unit: "mg", source: "icmr" }),
  vitamin_k: reference("55", "ug"),
  pantothenic_acid: reference("5", "mg", "icmr-ai"),
};

// Fixed adult pack-label references, rather than demographic energy needs.
const ADULT_LABEL_RDA = {
  energy: reference("2000", "kcal", "fssai"),
  added_sugars: reference("50", "g", "fssai"),
  total_fat: reference("67", "g", "fssai"),
  saturated_fat: reference("22", "g", "fssai"),
  trans_fat: reference("2", "g", "fssai"),
  sodium: reference("2000", "mg", "fssai"),
};

export const DEMOGRAPHIC_RDA = Object.freeze({
  men: Object.freeze({
    ...COMMON_RDA, ...ADULT_LABEL_RDA,
    protein: reference("54", "g"), dietary_fibre: reference("40", "g", "icmr-ai"),
    magnesium: reference("440", "mg"), iron: reference("19", "mg"), zinc: reference("17", "mg"),
    iodine: reference("140", "ug"), vitamin_c: reference("80", "mg"),
    thiamin: reference("1.8", "mg"), riboflavin: reference("2.5", "mg"), niacin: reference("18", "mg"),
    vitamin_b6: reference("2.4", "mg"), folate_dfe: reference("300", "ug"),
    vitamin_a_rae: reference("1000", "ug"), biotin: reference("40", "ug", "icmr-ai"),
  }),
  women: Object.freeze({
    ...COMMON_RDA, ...ADULT_LABEL_RDA,
    protein: reference("46", "g"), dietary_fibre: reference("30", "g", "icmr-ai"),
    magnesium: reference("370", "mg"), iron: reference("29", "mg"), zinc: reference("13.2", "mg"),
    iodine: reference("140", "ug"), vitamin_c: reference("65", "mg"),
    thiamin: reference("1.7", "mg"), riboflavin: reference("2.4", "mg"), niacin: reference("14", "mg"),
    vitamin_b6: reference("1.9", "mg"), folate_dfe: reference("220", "ug"),
    vitamin_a_rae: reference("840", "ug"), biotin: reference("40", "ug", "icmr-ai"),
  }),
  children: Object.freeze({
    ...COMMON_RDA,
    protein: reference("32", "g"), dietary_fibre: reference("33", "g", "icmr-ai"),
    calcium: reference("850", "mg"), magnesium: reference("240", "mg"), iron: reference("16", "mg"),
    zinc: reference("8.5", "mg"), iodine: reference("100", "ug"), sodium: reference("2000", "mg"),
    vitamin_c: reference("55", "mg"), thiamin: reference("1.5", "mg"), riboflavin: reference("2.1", "mg"),
    niacin: reference("15", "mg"), vitamin_b6: reference("2", "mg"), folate_dfe: reference("220", "ug"),
    vitamin_a_rae: reference("770", "ug"), biotin: reference("35", "ug", "icmr-ai"),
  }),
});

export const LABEL_REFERENCE = Object.freeze({
  jurisdiction: "India",
  nutrientReference: "ICMR-NIN RDA 2020 with 2021 corrigendum; FSSAI Annex IA/IB",
  audience: "Men and women (moderate work); single child column uses boys aged 10–12",
  sourceUrl: RDA_SOURCE_URL,
});
