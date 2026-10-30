import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import { normalizeText, rowsToTsv } from "../public/input-normalizer.js";

const app = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
// Execute the shipped preparation and confirmation controller against a small
// DOM fixture. Browser qualification additionally exercises real file parsers.
const prepare = app.slice(app.indexOf("async function prepareInput()"), app.indexOf('prepareButton.addEventListener("click", prepareInput);'))
  .replace('import("./ingestion.js")', 'Promise.resolve({ ingestFile })');
const confirm = app.slice(app.indexOf('calculateButton.addEventListener("click", async () => {'), app.indexOf("function currentOutputSnapshot()"));
for (const [kind, method, publishedMatch] of [["paste", "pasted text", false], ["file", "text file", false], ["file", "PDF embedded text", false], ["file", "image OCR", false], ["paste", "pasted text", true]]) {
  test(`${method} ${publishedMatch ? "matching published values" : kind} requires explicit confirmation`, async () => {
    const nodes = new Map();
    const node = (selector) => {
      if (!nodes.has(selector)) nodes.set(selector, { value: selector === "#input-basis" ? "dose" : "10", reset() {}, scrollIntoView() {} });
      return nodes.get(selector);
    };
    let calculate;
    const calls = [];
    const contents = publishedMatch ? "Sugar 500 kg" : "FINISHED BATCH 1000 L\nSugar 500 kg";
    const context = vm.createContext({
      document: { querySelector: node }, performance, TextEncoder, Promise,
      selectedFile: kind === "file" ? { name: "fixture.txt", size: contents.length, arrayBuffer: async () => new ArrayBuffer(0) } : null,
      formulaText: { value: contents }, prepareButton: {},
      calculateButton: { addEventListener: (_event, handler) => { calculate = handler; } },
      currentInputBasis: "dose", latestFileName: "", draftRows: [],
      workspace: null, publishedProduct: null, publishedReviewSignature: null, sessionHistory: [], confirmedIdentities: new Set(),
      normalizeText, rowsToTsv, sha256: async () => "fixture-hash", durationSince: () => 1,
      ingestFile: async () => ({ ...normalizeText(contents, method), rawText: contents }),
      setStatus() {}, recordAudit() {}, updateInputBasis() {}, validateDraftRows() {}, setReviewStatus() {}, cancelCalculation() {},
      savedProductForRows: () => publishedMatch ? { id: "published" } : null,
      openPublishedProduct: () => calls.push("opened without review"),
      analyzeContents: async (contents) => { calls.push(contents); return true; },
    });
    context.renderPreparedFormula = (extraction) => { context.draftRows = extraction.rows; };
    vm.runInContext(prepare + confirm, context);
    await context.prepareInput();
    assert.equal(context.draftRows.length, 2);
    assert.deepEqual(calls, []);
    context.draftRows[1].quantity = "400";
    await calculate();
    assert.equal(calls.length, 1);
    assert.match(calls[0], /Sugar\t400\tkg/);
  });
}
