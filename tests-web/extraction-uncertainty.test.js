import assert from "node:assert/strict";
import test from "node:test";
import { normalizeText, normalizePages } from "../public/input-normalizer.js";

// Synthetic recovered text tests parser behavior, not OCR accuracy.
test("damaged OCR quantities remain visible as unresolved source lines", () => {
  const text = "FINISHED BATCH 1000 L\nSugar 500 kg\nSalt 1O g";
  const result = normalizeText(text, "image OCR");
  assert.deepEqual(result.rows.map(row => row.item), ["FINISHED BATCH", "Sugar"]);
  assert.deepEqual(result.unparsedRows, [{ method: "image OCR", line: 3, text: "Salt 1O g" }]);
});

test("a wrapped quantity never fabricates a later batch row", () => {
  const result = normalizeText("1000 L\nSugar 500 kg\nSalt\n10 g", "image OCR");
  assert.deepEqual(result.rows.map(row => row.item), ["FINISHED BATCH", "Sugar"]);
  assert.deepEqual(result.unparsedRows.map(row => [row.line, row.text]), [[3, "Salt"], [4, "10 g"]]);
  assert.equal(result.rows[0].quantity, "1000");
});

test("PDF uncertainty preserves page coordinates and uncalibrated engine metadata", () => {
  const ocr = { engine: "Tesseract.js 7 / LSTM", language: "eng", scope: "page", confidence: 98 };
  const result = normalizePages([{ text: "FINISHED BATCH 1000 L\nSugar 500 kg" }, { text: "Salt 1O g\nOil 10 oz", ocr }], "PDF OCR");
  assert.deepEqual(result.unparsedRows.map(row => [row.page, row.line, row.text]), [[2, 1, "Salt 1O g"], [2, 2, "Oil 10 oz"]]);
  assert.deepEqual(result.unparsedRows[0].ocr, ocr);
  assert.equal(result.rawText, "FINISHED BATCH 1000 L\nSugar 500 kg\nSalt 1O g\nOil 10 oz");
});

test("known headers, blank rows and Markdown separators are not unresolved formula lines", () => {
  const result = normalizeText("Item | Quantity | Unit\n--- | --- | ---\n\nFINISHED BATCH | 1000 | L\nSugar | 500 | kg");
  assert.deepEqual(result.unparsedRows, []);
});

test("a wrapped quantity cannot replace an explicit dose basis", () => {
  const result = normalizeText("Salt\n10 g\nSugar 500 kg", "image OCR", { basisRow: { quantity: "5", unit: "mL" } });
  assert.deepEqual(result.rows.map(({ item, quantity, unit }) => ({ item, quantity, unit })), [
    { item: "FINISHED BATCH", quantity: "5", unit: "mL" },
    { item: "Sugar", quantity: "500", unit: "kg" },
  ]);
  assert.deepEqual(result.unparsedRows.map(row => row.text), ["Salt", "10 g"]);
});
