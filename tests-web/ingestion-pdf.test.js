import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import { normalizePages } from "../public/input-normalizer.js";

const source = await readFile(new URL("../public/ingestion.js", import.meta.url), "utf8");
const controller = source.slice(source.indexOf("async function ingestPdf("), source.indexOf("async function ingestSpreadsheet("));
function fixture(pages, recognize) {
  const pdf = { numPages: pages.length, getPage: async (number) => ({
    number, getTextContent: async () => ({ items: pages[number - 1].text }),
    getOperatorList: async () => ({ fnArray: pages[number - 1].empty ? [] : [1] }),
  }) };
  const context = vm.createContext({
    MAX_PDF_PAGES: 8, Uint8Array, normalizePages,
    getDocument: () => ({ promise: Promise.resolve(pdf) }), pdfPageText: text => text,
    renderPdfPage: async page => page, recognizeImage: recognize,
  });
  vm.runInContext(controller, context);
  return () => context.ingestPdf({ arrayBuffer: async () => new ArrayBuffer(0) }, () => {}, {});
}

test("provably empty PDF page preserves page coordinates without OCR", async () => {
  const ingest = fixture([{ text: "FINISHED BATCH 1000 L" }, { text: "", empty: true }, { text: "Sugar 500 kg" }], () => { throw new Error("Blank page must not trigger OCR"); });
  const result = await ingest();
  assert.equal(result.rows[1].input_source.page, 3);
  assert.equal(result.method, "PDF embedded text");
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
