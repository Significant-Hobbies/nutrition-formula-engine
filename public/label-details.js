// Product facts are supplied by the operator; never inferred from a dose or
// copied from a different marketed product.
import { buildBarcode } from "./label-barcode.js";
export const LABEL_DETAIL_FIELDS = Object.freeze({
  description: "Product description", category: "Product category", netQuantity: "Net quantity",
  intendedUsers: "Intended users", usage: "Recommended usage", duration: "Duration of use",
  directions: "Directions", storage: "Storage", cautions: "Cautions",
  sweetenerDeclaration: "Sweetener declaration",
  allergens: "Allergen status", allergenText: "Allergen declaration", dietaryStatus: "Dietary status",
  batchNumber: "Batch number", manufactureDate: "Manufacturing date", expiryDate: "Expiry / best-before",
  mrp: "MRP (inclusive of taxes)", licenceNumber: "Licence number",
  barcode: "Barcode (EAN-13)",
});

const CATEGORIES = Object.freeze({ food: "Food", health_supplement: "Health supplement", nutraceutical: "Nutraceutical", medicine: "Medicine" });
const pending = "To be confirmed";

export function buildLabelDetails(input = {}, ingredientDetails = []) {
  const values = Object.fromEntries(Object.keys(LABEL_DETAIL_FIELDS).map((key) => [key, String(input[key] || "").trim()]));
  const category = CATEGORIES[values.category] || pending;
  const barcode = buildBarcode(values.barcode);
  const sections = [
    { title: "Intended users", text: values.intendedUsers || pending, pending: !values.intendedUsers },
    { title: "Recommended usage", text: values.usage || "To be confirmed — serving size is not a daily-use instruction.", pending: !values.usage },
    { title: "Duration of use", text: values.duration || pending, pending: !values.duration },
    { title: "Directions", text: values.directions || pending, pending: !values.directions },
    { title: "Storage", text: values.storage || pending, pending: !values.storage },
    { title: "Cautions", text: values.cautions || pending, pending: !values.cautions },
  ];
  const containsAspartame = ingredientDetails.some((item) => item.ins === "951");
  if (containsAspartame) sections.push({ title: "Sweetener declaration", text: values.sweetenerDeclaration || "Contains aspartame (INS 951), a source of phenylalanine. Confirm the required category-specific declaration before finalizing.", pending: !values.sweetenerDeclaration });
  const allergenComplete = values.allergens === "none" || (values.allergens === "contains" && Boolean(values.allergenText));
  sections.push({ title: "Allergen information", text: values.allergens === "none" ? "No declarable allergens — confirmed by operator."
    : values.allergens === "contains" && values.allergenText ? `Contains: ${values.allergenText}` : pending, pending: !allergenComplete });
  const dietary = values.dietaryStatus === "vegetarian" ? "Vegetarian" : values.dietaryStatus === "nonvegetarian" ? "Non-vegetarian" : pending;
  const pack = [
    ["Net quantity", values.netQuantity], ["Batch no.", values.batchNumber],
    ["Manufactured", values.manufactureDate], ["Expiry / best-before", values.expiryDate],
    ["MRP (inclusive of taxes)", values.mrp ? `₹${values.mrp}` : ""], ["Licence no.", values.licenceNumber],
  ].map(([title, text]) => ({ title, text: text || pending, pending: !text }));
  const missing = sections.filter((section) => section.pending).map((section) => section.title);
  missing.push(...pack.filter((item) => item.pending).map((item) => item.title));
  if (!CATEGORIES[values.category]) missing.unshift("Product category");
  if (dietary === pending) missing.push("Dietary status");
  if (!barcode.valid) missing.push(barcode.issue);
  return {
    values, category, dietary, sections, pack, missing, containsAspartame, barcode,
    categoryDeclaration: ["health_supplement", "nutraceutical"].includes(values.category) ? "NOT FOR MEDICINAL USE" : "",
    note: "Manufacturing and marketing information must be added separately. Draft artwork requires supplier and category-specific review.",
  };
}
