// Published snapshots travel with the site, independent of browser/D1 storage.
import { multiplyDivideDecimal } from "./nutrition-label.js";
import { normalizeUnit } from "./input-normalizer.js";
const records = import.meta.glob("./saved-products/*.json", { eager: true, import: "default" });
const pdfs = import.meta.glob("./saved-products/*.pdf", { eager: true, query: "?url", import: "default" });
export const savedProducts = Object.values(records).map((record) => ({
  ...record,
  href: `/?product=${encodeURIComponent(record.id)}#label-builder`,
  pdfUrl: pdfs[`./saved-products/${record.id}.pdf`] || null,
}));

export function savedProduct(id) {
  return savedProducts.find((product) => product.id === id);
}

function rowSignature(rows) {
  const factors = { kg: "1000000", g: "1000", mg: "1", ug: "0.001", L: "1000", mL: "1" };
  return JSON.stringify(rows.map((row) => {
    const unit = normalizeUnit(row.unit);
    return [
    row.item.trim().toLowerCase().replace(/\s+/g, " "),
    multiplyDivideDecimal(row.quantity, factors[unit] || "1", "1", 12),
    ["L", "mL"].includes(unit) ? "volume" : "mass",
  ]; }).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))));
}

export function savedProductForRows(rows) {
  try {
    const signature = rowSignature(rows);
    return savedProducts.find((product) => rowSignature(product.report.formula_rows) === signature);
  } catch { return null; }
}

export function bestEstimateAliases(rows) {
  const reviewed = new Map(savedProducts.flatMap((product) => product.report.formula_rows)
    .filter((row) => row.material_id && !row.unresolved)
    .map((row) => [row.item.trim().toLowerCase(), row.material_id]));
  return rows.flatMap((row) => {
    const id = reviewed.get(row.item.trim().toLowerCase());
    return id ? [{ alias: row.item, material_id: id }] : [];
  });
}
