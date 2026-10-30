import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import { createPreparationTasks } from "../public/preparation-task.js";
import { normalizeText, normalizeMatrix, normalizePages, rowsToTsv, hasExplicitBatchSource } from "../public/input-normalizer.js";

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
      preparationTasks: createPreparationTasks(), MAX_INPUT_BYTES: 12 * 1024 * 1024,
      selectedFile: kind === "file" ? { name: "fixture.txt", size: contents.length, arrayBuffer: async () => new ArrayBuffer(0) } : null,
      formulaText: { value: contents }, prepareButton: {},
      calculateButton: { addEventListener: (_event, handler) => { calculate = handler; } },
      currentInputBasis: "dose", latestFileName: "", draftRows: [],
      workspace: null, publishedProduct: null, publishedReviewSignature: null, sessionHistory: [], confirmedIdentities: new Set(),
      normalizeText, rowsToTsv, hasExplicitBatchSource, sha256: async () => "fixture-hash", durationSince: () => 1,
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

function preparationFixture({ timeoutMs = 10000, ingestFile, hash = async () => "hash" } = {}) {
  const nodes = new Map();
  const node = (selector) => {
    if (!nodes.has(selector)) nodes.set(selector, { value: selector === "#input-basis" ? "dose" : "1", hidden: true,
      textContent: "", listeners: {}, classList: { toggle() {} },
      addEventListener(event, handler) { this.listeners[event] = handler; }, reset() {}, focus() {}, scrollIntoView() {} });
    return nodes.get(selector);
  };
  const context = vm.createContext({
    document: { querySelector: node }, performance, TextEncoder, Promise,
    preparationTasks: createPreparationTasks({ timeoutMs }), calculationRequests: { cancel() {} }, inputGeneration: 0,
    selectedFile: null, formulaText: node("#formula-text"), prepareButton: node("#prepare-button"), calculateButton: node("#calculate-button"),
    fileSummary: node("#file-summary"), fileInput: node("#formula-file"), fileName: node("#file-name"), fileSize: node("#file-size"),
    formulaReview: node("#formula-review"), results: node("#results"), uploadPanel: node("#upload-panel"),
    currentInputBasis: "dose", latestFileName: "", latestResult: null, currentRows: [], draftRows: [], latestContents: "", sessionHistory: [],
    workspace: null, savedLabelReview: null, confirmedIdentities: new Set(), MAX_INPUT_BYTES: 12 * 1024 * 1024,
    normalizeText, rowsToTsv, hasExplicitBatchSource, sha256: hash, durationSince: () => 1, ingestFile,
    setStatus(message) { context.message = message; }, recordAudit() {}, updateInputBasis() {}, setReviewStatus() {}, refreshSavedWorkspaceOffer() {},
  });
  context.renderPreparedFormula = (extraction) => { context.draftRows = extraction.rows; context.rendered = extraction; };
  const section = (from, to) => app.slice(app.indexOf(from), app.indexOf(to));
  vm.runInContext([
    section("function cancelCalculation()", "function labelReviewOptions()"),
    section("function selectFile(file)", 'for (const eventName of ["dragenter"'),
    prepare,
    section('document.querySelector("#input-basis").addEventListener', 'document.querySelector("#add-draft-row").addEventListener'),
    section('document.querySelector("#edit-source").addEventListener', 'function validateDraftRows()'),
    section('document.querySelector("#start-over").addEventListener', 'const addIngredientForm ='),
  ].join("\n"), context);
  return { context, node };
}
const fakeFile = (name) => ({ name, size: 20, type: "application/pdf", arrayBuffer: async () => new ArrayBuffer(0) });
const extraction = (amount) => ({ ...normalizeText(`1 mL\nSugar ${amount} mg`), rawText: `1 mL\nSugar ${amount} mg` });
const tick = () => new Promise(setImmediate);

test("preparation keeps file name, rows and normalization from one immutable source snapshot", async () => {
  let finishHash;
  let receivedFile;
  let receivedBasis;
  const { context, node } = preparationFixture({
    hash: async () => new Promise((resolve) => { finishHash = resolve; }),
    ingestFile: async (file, _progress, options) => { receivedFile = file; receivedBasis = options.basisRow; return extraction("10"); },
  });
  const original = fakeFile("old-A.pdf");
  context.selectedFile = original;
  node("#dose-volume").value = "2";
  const pending = context.prepareInput();
  await tick();
  // Mutate ambient state without an event: even then a job must not mix sources.
  context.selectedFile = fakeFile("new-B.pdf");
  context.formulaText.value = "1 mL\nSalt 9 mg";
  node("#dose-volume").value = "9";
  finishHash("hash");
  await pending;
  assert.equal(receivedFile, original);
  assert.equal(receivedBasis.quantity, "2");
  assert.equal(context.latestFileName, "old-A.pdf");
  assert.equal(context.draftRows[1].quantity, "10");
});

test("new file selection releases a hanging extraction and stale OCR progress/results cannot overwrite its replacement", async () => {
  let finishOld;
  let oldProgress;
  let oldSignal;
  const { context } = preparationFixture({ ingestFile: async (file, progress, { signal }) => {
    if (file.name === "old-A.pdf") { oldProgress = progress; oldSignal = signal; return new Promise((resolve) => { finishOld = resolve; }); }
    return extraction("20");
  } });
  context.selectFile(fakeFile("old-A.pdf"));
  const old = context.prepareInput();
  await tick();
  context.selectFile(fakeFile("new-B.pdf"));
  assert.equal(context.prepareButton.disabled, false);
  assert.equal(oldSignal.aborted, true);
  const next = context.prepareInput();
  await old;
  assert.equal(context.prepareButton.disabled, true, "obsolete finally cannot enable the new pending job");
  await next;
  oldProgress("Stale OCR error");
  finishOld(extraction("10"));
  await tick();
  assert.equal(context.latestFileName, "new-B.pdf");
  assert.equal(context.draftRows[1].quantity, "20");
  assert.match(context.message, /Check the recovered rows/);
});

for (const [name, selector, event] of [
  ["pasted text", "#formula-text", "input"], ["input basis", "#input-basis", "change"],
  ["dose", "#dose-volume", "input"], ["edit source", "#edit-source", "click"],
  ["start over", "#start-over", "click"],
]) test(`${name} cancels obsolete extraction without losing new customer input`, async () => {
  let finish;
  const { context, node } = preparationFixture({ ingestFile: async () => new Promise((resolve) => { finish = resolve; }) });
  context.selectFile(fakeFile("slow.pdf"));
  const pending = context.prepareInput();
  await tick();
  context.formulaText.value = "1 mL\nSugar 30 mg";
  node(selector).listeners[event]();
  await pending;
  finish(extraction("10"));
  await tick();
  assert.equal(context.draftRows.length, 0);
  assert.equal(context.prepareButton.disabled, false);
  if (name !== "start over") assert.match(context.formulaText.value, /Sugar 30 mg/);
  else assert.equal(context.formulaText.value, "");
});

test("preparation deadline keeps the selected source, releases controls and ignores late parser output", async () => {
  let signal;
  let finish;
  const { context } = preparationFixture({ timeoutMs: 10, ingestFile: async (_file, _progress, options) => {
    signal = options.signal;
    return new Promise((resolve) => { finish = resolve; });
  } });
  context.selectFile(fakeFile("slow.pdf"));
  await context.prepareInput();
  assert.equal(signal.aborted, true);
  assert.equal(context.selectedFile.name, "slow.pdf");
  assert.equal(context.prepareButton.disabled, false);
  assert.match(context.message, /timed out.*Paste.*upload/);
  finish(extraction("10"));
  await tick();
  assert.equal(context.draftRows.length, 0);
});


test("oversized UTF-8 paste is retained and rejected before hashing or parsing", async () => {
  let hashed = false;
  const { context } = preparationFixture({ hash: async () => { hashed = true; return "hash"; } });
  context.formulaText.value = "é".repeat(6 * 1024 * 1024 + 1);
  const original = context.formulaText.value;
  await context.prepareInput();
  assert.equal(hashed, false);
  assert.equal(context.formulaText.value, original);
  assert.equal(context.draftRows.length, 0);
  assert.equal(context.prepareButton.disabled, false);
  assert.match(context.message, /12 MB.*input is retained/);
});


for (const label of ["FINISHED BATCH", "FINAL BATCH", "BATCH SIZE", "Final yield"]) {
  test(`explicit ${label} XLSX source selects batch mode even without raw text`, async () => {
    const recovered = { ...normalizeMatrix([[label, "1000", "L"], ["Sugar", "500", "kg"]], "XLSX spreadsheet"), rawText: "" };
    const { context, node } = preparationFixture({ ingestFile: async () => recovered });
    context.selectFile(fakeFile("blank-rows.xlsx"));
    await context.prepareInput();
    assert.equal(context.currentInputBasis, "batch");
    assert.equal(node("#input-basis").value, "batch");
    assert.equal(context.draftRows[0].quantity, "1000");
    assert.equal(context.draftRows[0].unit, "L");
  });
}

for (const [label, recovered] of [
  ["pasted text", normalizeText("FINISHED BATCH 1000 L\nSugar 500 kg")],
  ["TXT", normalizeText("FINAL BATCH 1000 L\nSugar 500 kg", "text file")],
  ["PDF", normalizePages([{ text: "BATCH SIZE 1000 L\nSugar 500 kg" }], "PDF embedded text")],
  ["JSON structural batch", normalizeText(JSON.stringify({ batch: { quantity: "1000", unit: "L" }, ingredients: [{ item: "Sugar", quantity: "500", unit: "kg" }] }))],
  ["JSON explicit row", normalizeText(JSON.stringify([{ item: "FINISHED BATCH", quantity: "1000", unit: "L" }, { item: "Sugar", quantity: "500", unit: "kg" }]))],
]) test(`${label} explicit batch evidence selects batch mode consistently`, async () => {
  const { context } = preparationFixture({ ingestFile: async () => ({ ...recovered, rawText: "" }) });
  context.selectFile(fakeFile("formula.dat"));
  await context.prepareInput();
  assert.equal(context.currentInputBasis, "batch");
});

for (const text of ["1 mL\nSugar 20 mg", "Sugar 20 mg"]) test(`implicit dose source preserves dose mode: ${text}`, async () => {
  const { context, node } = preparationFixture();
  node("#dose-volume").value = "1";
  context.formulaText.value = text;
  await context.prepareInput();
  assert.equal(context.currentInputBasis, "dose");
  assert.equal(node("#input-basis").value, "dose");
  assert.equal(context.draftRows[0].quantity, "1");
  assert.equal(context.draftRows[0].unit, "mL");
});


for (const rejection of ["Error attempting to read image", null, {}]) test(`library rejection ${JSON.stringify(rejection)} produces a readable retained-input retry`, async () => {
  const { context } = preparationFixture({ ingestFile: async () => { throw rejection; } });
  context.selectFile(fakeFile("broken-image.png"));
  await context.prepareInput();
  assert.equal(context.selectedFile.name, "broken-image.png");
  assert.equal(context.prepareButton.disabled, false);
  assert.match(context.message, /Could not read this file.*clearer image\/PDF.*paste.*input is retained/);
});
