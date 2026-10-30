import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import { normalizePages } from "../public/input-normalizer.js";

const source = await readFile(new URL("../public/ingestion.js", import.meta.url), "utf8");
const controller = source.slice(source.indexOf("async function ingestPdf("), source.indexOf("async function ingestSpreadsheet("));
function fixture(pages, recognize) {
  let destroyed = 0;
  const pdf = { numPages: pages.length, getPage: async (number) => ({
    number, getTextContent: async () => ({ items: pages[number - 1].text }),
    getOperatorList: async () => ({ fnArray: pages[number - 1].empty ? [] : [1] }),
  }) };
  const context = vm.createContext({
    MAX_PDF_PAGES: 8, Uint8Array, normalizePages,
    getDocument: () => ({ promise: Promise.resolve(pdf), destroy: async () => { destroyed += 1; } }), pdfPageText: text => text,
    renderPdfPage: async page => page, recognizeImage: recognize,
  });
  vm.runInContext(source.slice(source.indexOf("function abortable("), source.indexOf("function resetOcrWorker(")) + controller, context);
  const ingest = (signal) => context.ingestPdf({ arrayBuffer: async () => new ArrayBuffer(0) }, () => {}, { signal });
  ingest.destroyed = () => destroyed;
  return ingest;
}

test("provably empty PDF page preserves page coordinates without OCR", async () => {
  const ingest = fixture([{ text: "FINISHED BATCH 1000 L" }, { text: "", empty: true }, { text: "Sugar 500 kg" }], () => { throw new Error("Blank page must not trigger OCR"); });
  const result = await ingest();
  assert.equal(result.rows[1].input_source.page, 3);
  assert.equal(result.method, "PDF embedded text");
  assert.equal(ingest.destroyed(), 1);
});

test("nonblank page without embedded text cannot silently disappear", async () => {
  const recognized = [];
  const ingest = fixture([{ text: "FINISHED BATCH 1000 L\nSugar 500 kg" }, { text: "" }], async page => {
    recognized.push(page.number);
    if (page.number === 2) throw new Error("No recovered text");
    return { text: "FINISHED BATCH 1000 L\nSugar 500 kg", ocr: { scope: "image", confidence: 90 } };
  });
  await assert.rejects(ingest(), /nonblank PDF page 2/);
  assert.deepEqual(recognized, [1, 2]);
  assert.equal(ingest.destroyed(), 1);
});

test("mixed PDF recovery includes scanned-page rows and page engine confidence", async () => {
  const ingest = fixture([{ text: "FINISHED BATCH 1000 L\nSugar 500 kg" }, { text: "" }], async page => ({
    text: page.number === 1 ? "FINISHED BATCH 1000 L\nSugar 500 kg" : "Water 100 L",
    ocr: { engine: "Tesseract.js 7 / LSTM", language: "eng", scope: "image", confidence: 80 },
  }));
  const result = await ingest();
  assert.equal(result.rows[2].item, "Water");
  assert.equal(result.rows[2].input_source.page, 2);
  assert.equal(result.rows[2].input_source.ocr.scope, "page");
});


test("aborted PDF loading destroys its task and releases the caller", async () => {
  let destroyed = 0;
  const context = vm.createContext({ MAX_PDF_PAGES: 8, Uint8Array,
    getDocument: () => ({ promise: new Promise(() => {}), destroy: async () => { destroyed += 1; } }),
  });
  vm.runInContext(source.slice(source.indexOf("function abortable("), source.indexOf("function resetOcrWorker(")) + controller, context);
  const abort = new AbortController();
  const pending = context.ingestPdf({ arrayBuffer: async () => new ArrayBuffer(0) }, () => {}, { signal: abort.signal });
  await new Promise(setImmediate);
  abort.abort();
  await assert.rejects(pending, /abort/i);
  assert.equal(destroyed, 1);
});

test("aborted PDF rendering cancels the active render task", async () => {
  let cancelled = 0;
  const context = vm.createContext({ document: { createElement: () => ({ getContext: () => ({}) }) } });
  vm.runInContext(source.slice(source.indexOf("function abortable("), source.indexOf("function resetOcrWorker(")) +
    source.slice(source.indexOf("async function renderPdfPage("), source.indexOf("async function ingestPdf(")), context);
  const abort = new AbortController();
  const pending = context.renderPdfPage({ getViewport: () => ({ width: 10, height: 10 }), render: () => ({
    promise: new Promise(() => {}), cancel() { cancelled += 1; },
  }) }, abort.signal);
  abort.abort();
  await assert.rejects(pending, /abort/i);
  assert.equal(cancelled, 1);
});
