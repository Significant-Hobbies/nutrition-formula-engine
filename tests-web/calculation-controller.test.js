import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import { createCalculationRequests } from "../public/calculation-request.js";
import { buildInputOnlyResult, validateReviewedRows } from "../public/draft-result.js";
import { normalizeText, rowsToTsv } from "../public/input-normalizer.js";
import { inputProvenance } from "../public/input-provenance.js";
import { buildNutritionLabel, identityReviewKey } from "../public/nutrition-label.js";
import { appendSessionVersion } from "../public/version-history.js";

const app = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
const controller = app.slice(app.indexOf("async function analyzeContents("), app.indexOf('document.querySelector("#save-workspace").addEventListener'));
function fixture(fetchImpl, timeoutMs = 10000) {
  const rows = normalizeText("1 mL\nSugar 200 mg").rows;
  const rendered = [];
  let persisted = 0;
  const context = vm.createContext({
    performance, structuredClone, buildInputOnlyResult, validateReviewedRows, inputProvenance, identityReviewKey, appendSessionVersion,
    calculationRequests: createCalculationRequests({ fetchImpl, timeoutMs }),
    currentRows: rows, draftRows: rows, currentInputBasis: "dose", confirmedIdentities: new Set(),
    workspace: null, publishedProduct: null, publishedReviewSignature: null, savedLabelReview: null,
    sessionHistory: [], latestResult: null, latestContents: "", latestFileName: "",
    calculateButton: {}, results: { hidden: true }, formulaReview: { hidden: false }, window: {},
    document: { querySelector: () => ({}) },
    sha256: async () => "hash", durationSince: () => 1, acceptedAliasPayload: () => [], bestEstimateAliases: () => [],
    recordAudit() {}, refreshDatabaseSync: async () => {}, renderDraftRows() {},
    persistBrowserWorkspace: async () => { persisted += 1; },
    renderResult(result) { context.latestResult = result; context.currentRows = result.formula_rows; context.results.hidden = false; rendered.push(result); },
    applyBestLabelDefaults() { context.label = buildNutritionLabel(context.latestResult, { servingSize: "1" }); },
    setReviewStatus(message) { context.reviewMessage = message; },
  });
  vm.runInContext(controller, context);
  return { context, rendered, persisted: () => persisted, contents: rowsToTsv(rows) };
}

for (const [name, fetchImpl, timeoutMs] of [
  ["offline", async () => { throw new TypeError("offline"); }, 10000],
  ["503", async () => new Response('{"error":"Unavailable"}', { status: 503 }), 10000],
  ["timeout", async () => new Promise(() => {}), 10],
]) test(`shipped controller produces printable/exportable input-only output on ${name}, without calculated history or persistence`, async () => {
  const { context, rendered, persisted, contents } = fixture(fetchImpl, timeoutMs);
  assert.equal(await context.analyzeContents(contents, "reviewed.tsv"), true);
  assert.equal(rendered.length, 1);
  assert.equal(rendered[0].input_only, true);
  assert.equal(context.label.groups[0].nutrients[0].perServing, "200");
  assert.equal(context.label.groups[0].nutrients[0].unit, "mg");
  assert.equal(context.latestContents, contents);
  assert.equal(context.formulaReview.hidden, false);
  assert.equal(context.results.hidden, false);
  assert.equal(context.calculateButton.disabled, false);
  assert.equal(context.sessionHistory.length, 0);
  assert.equal(persisted(), 0);
  assert.match(context.reviewMessage, /retry Confirm and calculate/);
});

test("shipped controller preserves reviewed input and specific authoritative correction", async () => {
  const { context, rendered, contents } = fixture(async () => new Response('{"error":"Row 3: supplier density required"}', { status: 400 }));
  assert.equal(await context.analyzeContents(contents, "reviewed.tsv"), false);
  assert.equal(rendered.length, 0);
  assert.equal(context.formulaReview.hidden, false);
  assert.equal(context.latestContents, contents);
  assert.equal(context.reviewMessage, "Row 3: supplier density required");
});

test("edits after a failed calculation appear in the next fallback instead of reusing old submitted quantities", async () => {
  const { context, contents } = fixture(async () => { throw new TypeError("offline"); });
  await context.analyzeContents(contents, "reviewed.tsv");
  context.draftRows[1].quantity = "300";
  await context.analyzeContents(rowsToTsv(context.draftRows), "reviewed.tsv");
  assert.equal(context.label.groups[0].nutrients[0].perServing, "300");
});

test("older failure cannot overwrite a newer successful submission or re-enable its pending controls", async () => {
  let calls = 0;
  const { context, rendered, persisted, contents } = fixture(async () => {
    if (++calls === 1) return new Promise(() => {});
    const report = buildInputOnlyResult(normalizeText("1 mL\nSugar 300 mg").rows);
    delete report.input_only;
    report.product_name = "Newest result";
    return new Response(JSON.stringify(report));
  });
  const first = context.analyzeContents(contents, "old.tsv");
  await new Promise(setImmediate);
  const second = context.analyzeContents(contents.replace("200", "300"), "new.tsv");
  assert.equal(await first, false);
  assert.equal(await second, true);
  assert.equal(rendered.length, 1);
  assert.equal(rendered[0].product_name, "Newest result");
  assert.equal(context.sessionHistory.length, 1);
  assert.equal(persisted(), 1);
  assert.match(context.latestContents, /300/);
  assert.equal(context.calculateButton.disabled, false);
});
