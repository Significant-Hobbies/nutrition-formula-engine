import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import { normalizeText, rowsToTsv } from "../public/input-normalizer.js";
import { buildNutritionLabel, identityReviewKey } from "../public/nutrition-label.js";
import { buildAssumptionScenario } from "../public/assumption-scenario.js";
import { defaultIdentityRows, validateReviewedRows } from "../public/draft-result.js";

const root = new URL("../", import.meta.url);
const records = await Promise.all((await readdir(new URL("public/saved-products/", root))).filter((name) => name.endsWith(".json"))
  .map(async (name) => JSON.parse(await readFile(new URL(`public/saved-products/${name}`, root), "utf8"))));
// Execute the shipped alias selection function; Vite's snapshot imports are
// supplied as fixture data rather than reimplementing its acceptance decisions.
const savedSource = await readFile(new URL("public/saved-products.js", root), "utf8");
const aliasesContext = vm.createContext({ savedProducts: records });
vm.runInContext(savedSource.slice(savedSource.indexOf("export function bestEstimateAliases")).replace("export function", "function"), aliasesContext);
const aliasesFor = aliasesContext.bestEstimateAliases;
const original = records.find((record) => record.id === "multivitamin-mineral-1ml");
const cases = records.map((record) => ({ id: record.id, text: record.contents, record }));
for (const [id, transform] of [
  ["uppercase", (text) => text.toUpperCase()],
  ["extra spaces", (text) => text.replace(/Vitamin /g, "Vitamin   ")],
  ["microgram units", (text) => text.replace(/\tug\b/g, "\tµg")],
  ["mcg units", (text) => text.replace(/\tug\b/g, "\tmcg")],
  ["decimal forms", (text) => text.replace(/\t0\.4\t/g, "\t.4\t").replace(/\t1\.5\t/g, "\t1.500\t")],
  ["source punctuation", (text) => text.replaceAll("hydrochloride)", "hydrochloride )").replace("Ascorbic acid", "Ascorbic-acid").replace("(as potassium iodide)", "as potassium-iodide")],
]) cases.push({ id, text: transform(original.contents), exact: true });
cases.push(
  { id: "unidentified carrier", text: original.contents + "UNIDENTIFIED CARRIER\t2\tmg\n", carrier: true },
  { id: "unknown acid", text: original.contents + "UNKNOWN ACID\t2\tmg\n", carrier: true },
  { id: "unsupported nutritive carrier", text: original.contents + "Sorbitol\t2\tmg\n", partial: true },
  { id: "weak vitamin spelling", text: original.contents.replace("Vitamin C (Ascorbic acid)", "Vit C Ascorbic Acid"), weak: true },
  { id: "unknown ingredient only", text: "1 mL\nUNIDENTIFIED CARRIER 2 mg", unknown: true },
  { id: "mass batch and ingredient volume", text: "FINISHED BATCH 1 kg\nUNIDENTIFIED CARRIER 2 mL", density: true },
);
for (const item of cases) {
  item.rows = normalizeText(item.text).rows;
  validateReviewedRows(item.rows);
  item.contents = rowsToTsv(item.rows);
  item.aliases = Object.fromEntries(aliasesFor(item.rows).map((alias) => [alias.alias, alias.material_id]));
}
const calculated = JSON.parse(execFileSync("uv", ["run", "python", "-c", `
import json,sys
from nutrition_formula.upload_analysis import analyze_formula_upload
out=[]
for case in json.load(sys.stdin):
 try:
  out.append(analyze_formula_upload(case['contents'], 'stress.tsv', accepted_aliases=case['aliases']))
 except Exception as error:
  out.append({'error':str(error)})
json.dump(out,sys.stdout)
`], { cwd: root, env: { ...process.env, PYTHONPATH: "src" }, input: JSON.stringify(cases), encoding: "utf8", maxBuffer: 12 * 1024 * 1024 }));

function labelFor(result, servingSize = "1", identities = defaultIdentityRows(result)) {
  const options = { servingSize, assumptionEstimate: true, waterBase: true,
    confirmedIdentities: new Set(identities.map(identityReviewKey)) };
  return { result: buildAssumptionScenario(result, options), options };
}
for (const [index, item] of cases.entries()) test(`normalization → Decimal engine → scenario → label: ${item.id}`, () => {
  const source = calculated[index];
  if (item.density) {
    assert.match(source.error, /density|measured mass/i);
    return;
  }
  assert.equal(source.error, undefined);
  source.input_basis = "dose";
  const before = JSON.stringify(source);
  const { result, options } = labelFor(source, item.record?.labelReview.servingSize || "1");
  const label = buildNutritionLabel(result, { ...options, includeUnavailable: true });
  assert.equal(JSON.stringify(source), before);
  assert.ok(label.groups.length > 0);
  assert.ok(label.groups.flatMap((group) => group.nutrients).every((row) => row.perServing !== "Not established"));
  if (item.record) {
    const expectedOptions = { ...item.record.labelReview, confirmedIdentities: new Set(item.record.labelReview.confirmedIdentities) };
    const expected = buildNutritionLabel(buildAssumptionScenario(item.record.report, expectedOptions), expectedOptions);
    assert.deepEqual(label.nutrients.map((row) => [row.id, row.perServing]), expected.nutrients.map((row) => [row.id, row.perServing]));
  }
  if (item.exact || item.id === original.id) {
    assert.equal(result.assumption_scenario?.active, true);
    const values = Object.fromEntries(label.nutrients.map((row) => [row.id, row.perServing]));
    assert.deepEqual(Object.fromEntries(["vitamin_c", "niacin", "riboflavin", "thiamin", "vitamin_b6", "vitamin_b12", "iodine", "zinc"].map((id) => [id, values[id]])),
      { vitamin_c: "4", niacin: "4", riboflavin: "0.4", thiamin: "0.3", vitamin_b6: "0.2", vitamin_b12: "0.4", iodine: "45", zinc: "3" });
    assert.equal(values.energy, "≈0.8");
    assert.equal(values.added_sugars, "≈0.2");
    assert.equal(values.sodium, "≈0.64");
  }
  if (item.carrier || item.unknown) {
    assert.equal(source.formula_rows.at(-1).unresolved, true);
    assert.notEqual(source.formula_rows.at(-1).material_id, "water");
    assert.equal(result.assumption_scenario, undefined);
    assert.ok(label.groups.some((group) => group.nutrients.some((row) => row.supplied && row.name === source.formula_rows.at(-1).item)));
    assert.ok(label.unavailableSummary);
  }
  if (item.weak) {
    assert.equal(result.assumption_scenario, undefined);
    assert.equal(label.nutrients.find((row) => row.id === "vitamin_c").perServing, "Not established");
    assert.ok(label.groups.some((group) => group.nutrients.some((row) => row.supplied && row.name === "Vit C Ascorbic Acid")));
    assert.ok(label.ingredients.some((name) => name.includes("Vit C Ascorbic Acid (identity/composition to confirm)")));
  }
  if (item.partial) assert.equal(result.assumption_scenario, undefined);
});
