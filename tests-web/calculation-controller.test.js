import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import { createCalculationRequests } from "../public/calculation-request.js";
import { buildInputOnlyResult, validateReviewedRows, validateCalculationSource } from "../public/draft-result.js";
import { normalizeText, rowsToTsv, normalizeUnit } from "../public/input-normalizer.js";
import { inputProvenance } from "../public/input-provenance.js";
import { buildNutritionLabel, identityReviewKey } from "../public/nutrition-label.js";
import { appendSessionVersion } from "../public/version-history.js";

const app = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
const controller = app.slice(app.indexOf("async function analyzeContents("), app.indexOf('document.querySelector("#save-workspace").addEventListener'));
function fixture(fetchImpl, timeoutMs = 10000, persistFailure = false) {
  const rows = normalizeText("1 mL\nSugar 200 mg").rows;
  const rendered = [];
  let persisted = 0;
  const context = vm.createContext({
    performance, structuredClone, normalizeUnit, buildInputOnlyResult, validateReviewedRows, validateCalculationSource, inputProvenance, identityReviewKey, appendSessionVersion,
    calculationRequests: createCalculationRequests({ fetchImpl, timeoutMs }),
    currentRows: rows, unparsedSourceRows: [], draftRows: rows, currentInputBasis: "dose", confirmedIdentities: new Set(),
    workspace: null, publishedProduct: null, publishedReviewSignature: null, savedLabelReview: null,
    sessionHistory: [], latestResult: null, latestContents: "", latestFileName: "",
    calculateButton: {}, results: { hidden: true }, formulaReview: { hidden: false }, window: {},
    document: { querySelector: () => ({}) },
    sha256: async () => "hash", durationSince: () => 1, acceptedAliasPayload: () => [], bestEstimateAliases: () => [],
    recordAudit() {}, refreshDatabaseSync: async () => {}, renderDraftRows() {},
    persistBrowserWorkspace: async () => { persisted += 1; if (persistFailure) throw new DOMException("Quota exceeded", "QuotaExceededError"); },
    updateStatus(target, message) { target.textContent = message; },
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
  assert.equal(await context.analyzeContents(contents, "reviewed.tsv"), true);
  assert.equal(rendered.length, 1);
  assert.equal(rendered[0].input_only, true);
  assert.equal(context.sessionHistory.length, 0);
  assert.equal(context.formulaReview.hidden, false);
  assert.equal(context.latestContents, contents);
  assert.match(context.reviewMessage, /Row 3: supplier density required/);
  assert.doesNotMatch(rendered[0].report_assumptions.join(" "), /service is unavailable/);
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
  context.draftRows[1].quantity = "300";
  const second = context.analyzeContents(contents.replace("200", "300"), "new.tsv");
  assert.equal(await first, null);
  assert.equal(await second, true);
  assert.equal(rendered.length, 1);
  assert.equal(rendered[0].product_name, "Newest result");
  assert.equal(context.sessionHistory.length, 1);
  assert.equal(persisted(), 1);
  assert.match(context.latestContents, /300/);
  assert.equal(context.calculateButton.disabled, false);
});


test("a browser quota failure cannot undo a calculated correction or discard its report", async () => {
  const report = buildInputOnlyResult(normalizeText("1 mL\nSugar 300 mg").rows);
  delete report.input_only;
  const { context, rendered, contents } = fixture(async () => new Response(JSON.stringify(report)), 10000, true);
  context.currentRows = normalizeText("1 mL\nSugar 300 mg").rows;
  context.workspace = { mode: "browser" };
  context.window.appHealth = { track() { throw new Error("Telemetry unavailable"); } };
  let hashes = 0;
  context.sha256 = async () => { if (++hashes > 1) throw new Error("Hash unavailable"); return "input hash"; };
  assert.equal(await context.analyzeContents(contents, "corrected.tsv", "formula_corrected"), true);
  assert.equal(rendered.length, 1);
  assert.equal(context.currentRows[1].submitted_quantity, "300");
  assert.equal(context.sessionHistory.length, 1);
  assert.match(context.reviewMessage, /calculated.*could not be saved/);
  assert.equal(context.results.hidden, false);
});

test("density rejection retains all supplied volume and mass units and can retry after correction", async () => {
  let calls = 0;
  const { context, persisted } = fixture(async () => {
    if (++calls === 1) return new Response(JSON.stringify({ error: "Unknown carrier: supplier density required to convert mL to mass" }), { status: 400 });
    const report = buildInputOnlyResult(context.draftRows);
    delete report.input_only;
    return new Response(JSON.stringify(report));
  });
  context.draftRows = normalizeText("1 mL\nUnknown carrier 0.2 mL\nVitamin C 4 mg").rows;
  assert.equal(await context.analyzeContents(rowsToTsv(context.draftRows), "volume.tsv"), true);
  assert.equal(context.latestResult.formula_rows[1].submitted_quantity, "0.2");
  assert.equal(context.latestResult.formula_rows[1].submitted_unit, "mL");
  assert.equal(context.latestResult.screened_components.length, 0);
  assert.equal(context.sessionHistory.length, 0);
  assert.equal(persisted(), 0);
  context.draftRows[1].quantity = "200";
  context.draftRows[1].unit = "mg";
  assert.equal(await context.analyzeContents(rowsToTsv(context.draftRows), "corrected.tsv"), true);
  assert.equal(context.latestResult.formula_rows[1].submitted_unit, "mg");
  assert.equal(context.sessionHistory.length, 1);
  assert.equal(persisted(), 1);
});

test("the shipped start-over handler cancels a pending calculation so its late output cannot restore cleared rows", async () => {
  let finish;
  const { context, rendered, contents } = fixture(async () => new Promise((resolve) => { finish = resolve; }));
  const node = () => ({ reset() {}, focus() {}, scrollIntoView() {} });
  context.document.querySelector = node;
  context.inputGeneration = 0;
  context.preparationTasks = { cancel() {} };
  context.prepareButton = {};
  context.fileInput = node();
  context.formulaText = node();
  context.fileSummary = node();
  context.uploadPanel = node();
  context.setStatus = () => {};
  vm.runInContext(app.slice(app.indexOf("function cancelCalculation()"), app.indexOf("function labelReviewOptions()")), context);
  const reset = app.slice(app.indexOf('document.querySelector("#start-over").addEventListener'), app.indexOf('const addIngredientForm ='))
    .replace('document.querySelector("#start-over").addEventListener("click", () => {', 'globalThis.startOver = () => {').replace(/\}\);\s*$/, '};');
  vm.runInContext(reset, context);
  const pending = context.analyzeContents(contents, "old.tsv");
  await new Promise(setImmediate);
  context.startOver();
  assert.equal(await pending, null);
  finish(new Response(JSON.stringify(buildInputOnlyResult(normalizeText("1 mL\nSugar 200 mg").rows))));
  await new Promise(setImmediate);
  assert.equal(context.currentRows.length, 0);
  assert.equal(context.draftRows.length, 0);
  assert.equal(context.latestResult, null);
  assert.equal(context.results.hidden, true);
  assert.equal(rendered.length, 0);
});

test("shipped controller sends excluded recovery evidence and refuses a service response that drops it", async () => {
  let received;
  const { context, contents } = fixture(async (_url, options) => {
    received = JSON.parse(options.body);
    const report = buildInputOnlyResult(normalizeText("1 mL\nSugar 200 mg").rows);
    delete report.input_only;
    return new Response(JSON.stringify(report));
  });
  context.unparsedSourceRows = [{ method: "image OCR", line: 3, text: "Salt 1O g" }];
  assert.equal(await context.analyzeContents(contents, "ocr.tsv"), true);
  assert.equal(received.input_provenance.unparsed_rows[0].text, "Salt 1O g");
  assert.equal(context.latestResult.input_only, true);
  assert.equal(context.latestResult.input_provenance.unparsed_rows[0].text, "Salt 1O g");
  assert.equal(context.sessionHistory.length, 0);
  assert.match(context.reviewMessage, /omitted recovered source evidence/);
});
