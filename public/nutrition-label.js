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

function roundedRatio(numerator, denominator, decimalPlaces) {
  if (denominator <= 0n) throw new Error("The divisor must be greater than zero.");
  const scale = powerOfTen(decimalPlaces);
  const scaled = numerator * scale;
  const quotient = scaled / denominator;
  const remainder = scaled % denominator;
  const rounded = remainder * 2n >= denominator ? quotient + 1n : quotient;
  if (decimalPlaces === 0) return rounded.toString();
  const digits = rounded.toString().padStart(decimalPlaces + 1, "0");
  const whole = digits.slice(0, -decimalPlaces);
  const fraction = digits.slice(-decimalPlaces).replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole;
}

export function multiplyDivideDecimal(value, multiplier, divisor, decimalPlaces = 2) {
  const left = decimalParts(value);
  const right = decimalParts(multiplier);
  const bottom = decimalParts(divisor);
  const numerator = left.coefficient * right.coefficient * powerOfTen(bottom.scale);
  const denominator = bottom.coefficient * powerOfTen(left.scale + right.scale);
  return roundedRatio(numerator, denominator, decimalPlaces);
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

export const LABEL_REFERENCE = Object.freeze({
  jurisdiction: "India",
  labelRegulation: "FSSAI Labelling and Display Regulations, 2020 — Version VIII (09.09.2025)",
  nutrientReference: "ICMR-NIN Nutrient Requirements for Indians, RDA and EAR 2020",
  audience: "Average adult; micronutrients use the adult sedentary-man reference where applicable",
});

export const ADULT_RDA = Object.freeze({
  energy: { value: "2000", unit: "kcal", source: "fssai" },
  protein: { value: "54", unit: "g", source: "icmr" },
  added_sugars: { value: "50", unit: "g", source: "fssai" },
  dietary_fibre: { value: "30", unit: "g", source: "icmr" },
  total_fat: { value: "67", unit: "g", source: "fssai" },
  saturated_fat: { value: "22", unit: "g", source: "fssai" },
  trans_fat: { value: "2", unit: "g", source: "fssai" },
  calcium: { value: "1000", unit: "mg", source: "icmr" },
  iron: { value: "19", unit: "mg", source: "icmr" },
  magnesium: { value: "440", unit: "mg", source: "icmr" },
  phosphorus: { value: "1000", unit: "mg", source: "icmr" },
  potassium: { value: "3500", unit: "mg", source: "icmr" },
  sodium: { value: "2000", unit: "mg", source: "fssai" },
  zinc: { value: "17", unit: "mg", source: "icmr" },
  copper: { value: "1.7", unit: "mg", source: "icmr" },
  manganese: { value: "4", unit: "mg", source: "icmr" },
  selenium: { value: "40", unit: "ug", source: "icmr" },
  vitamin_c: { value: "80", unit: "mg", source: "icmr" },
  thiamin: { value: "1.4", unit: "mg", source: "icmr" },
  riboflavin: { value: "2", unit: "mg", source: "icmr" },
  niacin: { value: "14", unit: "mg", source: "icmr" },
  vitamin_b6: { value: "1.9", unit: "mg", source: "icmr" },
  folate_dfe: { value: "300", unit: "ug", source: "icmr" },
  vitamin_b12: { value: "2.2", unit: "ug", source: "icmr" },
  vitamin_a_rae: { value: "1000", unit: "ug", source: "icmr" },
  vitamin_d: { value: "15", unit: "ug", source: "icmr" },
  vitamin_k: { value: "55", unit: "ug", source: "icmr" },
});

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

function componentOrder(component) {
  const requiredIndex = REQUIRED_ORDER.indexOf(component.id);
  return requiredIndex === -1 ? REQUIRED_ORDER.length : requiredIndex;
}

function amountPrecision(unit) {
  if (unit === "kcal") return 0;
  if (unit === "g") return 2;
  return 2;
}

function displayUnit(unit) {
  return unit === "ug" ? "µg" : unit;
}

function labelIngredientName(row) {
  if (row.confidence === "exact" && row.interpretation) return row.interpretation;
  return row.item;
}

export function buildNutritionLabel(result, options = {}) {
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
    .filter(({ component }) => REQUIRED_ORDER.includes(component.id) || isNonZeroDecimal(component.value))
    .map(({ component }) => {
      const precision = amountPrecision(component.unit);
      const perServing = multiplyDivideDecimal(component.value, servingSize, "100", precision);
      const reference = ADULT_RDA[component.id];
      const rdaPercent = reference && reference.unit === component.unit
        ? multiplyDivideDecimal(component.value, servingSize, reference.value, 0)
        : null;
      const qualifier = component.status === "partial" ? "≥" : "";
      const rdaLabel = rdaPercent === null
        ? "—"
        : rdaPercent === "0" && isNonZeroDecimal(component.value)
          ? "<1%"
          : `${qualifier}${rdaPercent}%`;
      return {
        id: component.id,
        name: component.name,
        unit: displayUnit(component.unit),
        perBasis: `${qualifier}${multiplyDivideDecimal(component.value, "1", "1", precision)}`,
        perServing: `${qualifier}${perServing}`,
        rdaPercent: rdaLabel,
        referenceSource: reference?.source || null,
        status: component.status,
      };
    });

  const formulaRows = (result.formula_rows || []).slice(1);
  const labelIngredients = (result.label_ingredients || []).map((item) => item.name);
  const ingredients = labelIngredients.length
    ? labelIngredients
    : formulaRows.map(labelIngredientName);

  return {
    productName,
    basisLabel: `Per 100 ${basisUnit}`,
    servingLabel: `Per serve (${servingSize} ${basisUnit})`,
    servingSize,
    servingUnit: basisUnit,
    servingsPerPack,
    ingredients,
    nutrients,
    hasIncompleteData: nutrients.some((nutrient) => nutrient.status === "partial"),
    hasIdentityReview: formulaRows.some((row) => row.needs_review),
    reference: LABEL_REFERENCE,
  };
}
