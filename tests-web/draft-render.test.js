import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import { createCalculationRequests } from "../public/calculation-request.js";
import { appendSessionVersion } from "../public/version-history.js";
import { normalizeText, rowsToTsv, normalizeUnit } from "../public/input-normalizer.js";
import { buildInputOnlyResult, defaultIdentityRows, validateReviewedRows, validateCalculationSource } from "../public/draft-result.js";
import { buildNutritionLabel, identityReviewKey, pendingIdentityRows, multiplyDivideDecimal } from "../public/nutrition-label.js";
import { buildAssumptionScenario, scenarioEligibility, scenarioAssumptions } from "../public/assumption-scenario.js";
import { buildResultReadiness, componentEvidence } from "../public/result-readiness.js";
import { sourceLabel as inputSourceLabel, inputProvenance } from "../public/input-provenance.js";
import { LABEL_DETAIL_FIELDS } from "../public/label-details.js";

const app = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
const snapshot = JSON.parse(await readFile(new URL("../public/saved-products/multivitamin-mineral-1ml.json", import.meta.url), "utf8"));
const section = (from, to) => app.slice(app.indexOf(from), app.indexOf(to));
const renderers = [
  section("function labelReviewOptions()", "function persistLabelReview()"),
  section("function renderReadiness()", "async function persistBrowserWorkspace()"),
  section("function cell(", "function draftInput("),
  section("function updateInputBasis()", 'document.querySelector("#input-basis").addEventListener'),
  section("function renderFormula(", "function analysisRowsToTsv("),
  section("function reviewButton(", "function sourceLabel(contribution)"),
  section("function sourceLabel(contribution)", "function causeLabel("),
  section("function renderHistory()", "async function analyzeContents("),
  section("function applyBestLabelDefaults()", "function openPublishedProduct("),
].join("\n");

function element() {
  return {
    hidden: false, disabled: false, value: "", checked: false, children: [], style: {}, dataset: {},
    classList: { add() {}, toggle() {} }, _text: "",
    set textContent(value) { this._text = String(value); this.children = []; },
    get textContent() { return this._text + this.children.map((child) => typeof child === "string" ? child : child.textContent).join(""); },
    append(...children) { this.children.push(...children); }, replaceChildren() { this.children = []; this._text = ""; },
    setAttribute() {}, addEventListener() {}, scrollIntoView() {}, focus() {},
  };
}

function fixture(fetchImpl = async () => { throw new Error("offline"); }) {
  const rows = normalizeText(snapshot.contents).rows;
  const nodes = new Map();
  const node = (selector) => { if (!nodes.has(selector)) nodes.set(selector, element()); return nodes.get(selector); };
  const context = vm.createContext({
    document: { querySelector: node, createElement: element, createElementNS: element, createTextNode: (text) => ({ textContent: text }) },
    buildNutritionLabel, identityReviewKey, pendingIdentityRows, multiplyDivideDecimal,
    buildAssumptionScenario, scenarioEligibility, scenarioAssumptions, buildResultReadiness, componentEvidence,
    defaultIdentityRows, inputSourceLabel, LABEL_DETAIL_FIELDS,
    latestResult: null, currentRows: [], currentInputBasis: "dose", savedLabelReview: null,
    confirmedIdentities: new Set(), publishedProduct: null, publishedReviewSignature: null,
    workspace: null, sessionHistory: [], results: node("#results"),
    performance, structuredClone, normalizeUnit, buildInputOnlyResult, validateReviewedRows, validateCalculationSource, inputProvenance, appendSessionVersion,
    calculationRequests: createCalculationRequests({ fetchImpl }),
    unparsedSourceRows: [], draftRows: rows, latestFileName: "", latestContents: "", calculateButton: node("#calculate-button"), formulaReview: node("#formula-review"),
    window: {}, sha256: async () => "hash", durationSince: () => 1, acceptedAliasPayload: () => [], bestEstimateAliases: () => [],
    persistBrowserWorkspace: async () => {}, renderDraftRows() {}, refreshDatabaseSync: async () => {},
    setReviewStatus(message) { node("#review-status").textContent = message; },
    ingredientIsSaved: () => false, persistLabelReview() {}, recordAudit() {},
    updateStatus(target, text) { target.textContent = text; },
  });
  vm.runInContext(renderers + app.slice(app.indexOf("async function analyzeContents("), app.indexOf('document.querySelector("#save-workspace").addEventListener')), context);
  return { context, node, rows };
}

test("real result, identity and nutrition renderers produce a printable input-only sheet for every reviewed ingredient", () => {
  const { context, node, rows } = fixture();
  const draft = buildInputOnlyResult(rows);
  // These are the actual shipped functions, including all rendering work that
  // the request-controller fixture intentionally does not replace or model.
  context.renderResult(draft);
  context.applyBestLabelDefaults();
  assert.equal(node("#results").hidden, false);
  assert.equal(node("#nutrition-label").hidden, false, node("#label-status").textContent);
  assert.equal(node("#print-label").disabled, false);
  assert.equal(node("#label-info-title").textContent, "Supplied ingredient quantities");
  assert.equal(node("#label-nutrient-heading").textContent, "Ingredient");
  assert.equal(node("#label-nutrition-reference").hidden, true);
  assert.equal(node("#identity-review-list").children.length, rows.length - 1);
  assert.equal(node("#label-nutrients").children.length, rows.length);
  for (const row of rows.slice(1)) assert.ok(node("#label-nutrients").textContent.includes(row.item), row.item);
  assert.ok(!node("#label-nutrients").textContent.includes("Not established"));
  assert.match(node("#label-print-review").textContent, /ingredients as supplied, not nutrient totals/);
  assert.equal(node("#save-workspace").disabled, true);
});

for (const [name, corrupt] of [
  ["missing alternatives", (report) => { delete report.formula_rows[1].alternatives; }],
  ["missing quantity", (report) => { delete report.formula_rows[1].submitted_quantity; }],
  ["invalid nested contribution", (report) => { report.present_components[0].contributions[0].per_serving = "NaN"; }],
  ["unreadable identity assumption", (report) => { report.ingredient_assumptions = [null]; }],
  ["unreadable source evidence", (report) => { report.formula_rows[1].input_source.original = null; }],
  ["invalid nutrient total", (report) => { report.screened_components[0].value = "unknown"; }],
  ["invalid coverage", (report) => { report.coverage.characterized_percent = {}; }],
  ["unreadable ingredient row", (report) => { report.formula_rows[1] = null; }],
]) test(`malformed 200 ${name} reaches a printable input-only sheet through the real controller and renderer`, async () => {
  const report = structuredClone(snapshot.report);
  corrupt(report);
  const { context, node, rows } = fixture(async () => new Response(JSON.stringify(report)));
  assert.equal(await context.analyzeContents(rowsToTsv(rows), "original.tsv"), true);
  assert.equal(context.latestResult.input_only, true);
  assert.equal(node("#results").hidden, false);
  assert.equal(node("#nutrition-label").hidden, false);
  assert.equal(node("#print-label").disabled, false);
  assert.equal(context.sessionHistory.length, 0);
  assert.equal(context.currentRows[1].submitted_quantity, rows[1].quantity);
  assert.match(node("#review-status").textContent, /incomplete response/);
});

test("a valid service result for a different formula cannot replace reviewed input", async () => {
  const { context, node } = fixture(async () => new Response(JSON.stringify(snapshot.report)));
  context.draftRows = normalizeText("1 mL\nSugar 0 mg").rows;
  assert.equal(await context.analyzeContents(rowsToTsv(context.draftRows), "original.tsv"), true);
  assert.equal(context.latestResult.input_only, true);
  assert.equal(context.currentRows.length, 2);
  assert.equal(context.currentRows[1].submitted_quantity, "0");
  assert.equal(context.sessionHistory.length, 0);
  assert.match(node("#review-status").textContent, /did not match/);
});

test("density correction remains visible in a printable sheet through real rendering", async () => {
  const { context, node } = fixture(async () => new Response(JSON.stringify({ error: "Unknown carrier: supplier density required" }), { status: 400 }));
  context.draftRows = normalizeText("1 mL\nUnknown carrier 0.2 mL\nVitamin C 4 mg").rows;
  assert.equal(await context.analyzeContents(rowsToTsv(context.draftRows), "volume.tsv"), true);
  assert.equal(node("#print-label").disabled, false);
  assert.match(node("#label-nutrients").textContent, /Unknown carrier/);
  assert.match(node("#label-nutrients").textContent, /0.2 mL/);
  assert.match(node("#inference-reason").textContent, /supplier density required/);
  assert.doesNotMatch(node("#inference-reason").textContent, /service is unavailable/);
});
