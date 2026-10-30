import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import { normalizeText } from "../public/input-normalizer.js";
import { buildInputOnlyResult, defaultIdentityRows } from "../public/draft-result.js";
import { buildNutritionLabel, identityReviewKey, pendingIdentityRows, multiplyDivideDecimal } from "../public/nutrition-label.js";
import { buildAssumptionScenario, scenarioEligibility, scenarioAssumptions } from "../public/assumption-scenario.js";
import { buildResultReadiness, componentEvidence } from "../public/result-readiness.js";
import { sourceLabel as inputSourceLabel } from "../public/input-provenance.js";
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

test("real result, identity and nutrition renderers produce a printable input-only sheet for every reviewed ingredient", () => {
  const rows = normalizeText(snapshot.contents).rows;
  const draft = buildInputOnlyResult(rows);
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
    ingredientIsSaved: () => false, persistLabelReview() {}, recordAudit() {},
    updateStatus(target, text) { target.textContent = text; },
  });
  vm.runInContext(renderers, context);
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
