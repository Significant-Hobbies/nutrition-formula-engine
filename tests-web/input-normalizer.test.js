import test from "node:test";
import assert from "node:assert/strict";

import { normalizeJson, normalizeMatrix, normalizeText, normalizePages, rowsToTsv } from "../public/input-normalizer.js";

const expected = [
  { item: "FINISHED BATCH", quantity: "1000", unit: "L", source_line: 2 },
  { item: "Ferric ammonium citrate", quantity: "13.4", unit: "kg", source_line: 3 },
];

test("normalizes a TSV table", () => {
  const result = normalizeText("Item\tQuantity\tUnit\nFINISHED BATCH\t1000\tL\nFerric ammonium citrate\t13.4\tkg");
  assert.deepEqual(result.rows.map(({ input_source, ...row }) => row), expected);
});

test("normalizes CSV with quoted cells", () => {
  const result = normalizeText('Item,Quantity,Unit\nFINISHED BATCH,"1,000",L\n"Ferric ammonium citrate",13.4,kg');
  assert.equal(result.rows[0].quantity, "1000");
  assert.equal(result.rows[1].item, "Ferric ammonium citrate");
});

test("normalizes a pipe table with unit aliases", () => {
  const result = normalizeText("Item | Qty | UOM\nFINISHED BATCH | 1,000 | litres\nZinc sulphate | 470 | grams");
  assert.deepEqual(result.rows.map(({ item, quantity, unit }) => ({ item, quantity, unit })), [
    { item: "FINISHED BATCH", quantity: "1000", unit: "L" },
    { item: "Zinc sulphate", quantity: "470", unit: "g" },
  ]);
});

test("normalizes semicolon-delimited decimal-comma quantities", () => {
  const result = normalizeText("Item;Quantity;Unit\nFINISHED BATCH;1000;L\nBronopol;0,1;kg");
  assert.equal(result.rows[1].quantity, "0.1");
});

test("whitespace decimal-comma amounts retain their ingredient name and full quantity", () => {
  const result = normalizeText("Vitamin C 4,5 mg\nSugar 200 mg", "pasted text", { basisRow: { quantity: "1", unit: "mL" } });
  assert.equal(result.rows[1].item, "Vitamin C");
  assert.equal(result.rows[1].quantity, "4.5");
  assert.equal(result.rows[1].unit, "mg");
  assert.equal(result.rows[1].input_source.text, "Vitamin C 4,5 mg");
  assert.equal(result.rows[2].quantity, "200");
});

test("CSV with combined amounts remains comma-delimited", () => {
  const result = normalizeText('FINISHED BATCH,1 mL\nVitamin C,4.5 mg\nSugar,200 mg');
  assert.equal(result.rows[1].item, "Vitamin C");
  assert.equal(result.rows[1].quantity, "4.5");
});

test("unsupported scientific notation requires correction instead of dropping the ingredient", () => {
  assert.throws(() => normalizeText("Vitamin B12 4e-1 mcg\nSugar 200 mg", "pasted text", { basisRow: { quantity: "1", unit: "mL" } }), /Source row 1.*decimal quantity/);
});

test("normalizes OCR-style lines and infers a quantity-only batch row", () => {
  const result = normalizeText("1000 LITRE\nFERRIC AMMONIUM CITRATE 13.4 KG\nCYANCOBALAMIN 0.085 GM", "image OCR");
  assert.deepEqual(result.rows.map(({ item, quantity, unit }) => ({ item, quantity, unit })), [
    { item: "FINISHED BATCH", quantity: "1000", unit: "L" },
    { item: "FERRIC AMMONIUM CITRATE", quantity: "13.4", unit: "kg" },
    { item: "CYANCOBALAMIN", quantity: "0.085", unit: "g" },
  ]);
});

test("normalizes JSON formula objects", () => {
  const result = normalizeJson({
    batch: { final_quantity: { value: "1000", unit: "L" } },
    ingredients: [{ ingredient: "Sugar", quantity: "500", unit: "kg" }],
  });
  assert.equal(result.rows[0].item, "FINISHED BATCH");
  assert.equal(result.rows[1].item, "Sugar");
});

test("normalizes a flat quantity and unit batch object", () => {
  const result = normalizeJson({
    batch: { item: "FINISHED BATCH", quantity: 1000, unit: "L" },
    ingredients: [{ item: "Sugar", quantity: 500, unit: "kg" }],
  });
  assert.deepEqual(result.rows.map(({ item, quantity, unit }) => ({ item, quantity, unit })), [
    { item: "FINISHED BATCH", quantity: "1000", unit: "L" },
    { item: "Sugar", quantity: "500", unit: "kg" },
  ]);
});

test("normalizes JSON rows with combined quantity and unit values", () => {
  const result = normalizeJson([
    { item: "FINISHED BATCH", amount: "1000 litres" },
    { material: "Cyanocobalamin", amount: "85 mg" },
  ]);
  assert.equal(result.rows[0].unit, "L");
  assert.equal(result.rows[1].quantity, "85");
  assert.equal(result.rows[1].unit, "mg");
});

test("normalizes spreadsheet matrices with leading blank columns", () => {
  const result = normalizeMatrix([
    [null, "Item", "Quantity", "Unit"],
    [null, "FINISHED BATCH", 1000, "litres"],
    [null, "Sugar", 500, "KG"],
  ], "spreadsheet");
  assert.equal(result.rows[1].unit, "kg");
});

test("serializes reviewed rows to canonical TSV", () => {
  assert.equal(rowsToTsv(expected), "Item\tQuantity\tUnit\nFINISHED BATCH\t1000\tL\nFerric ammonium citrate\t13.4\tkg\n");
});

test("fails visibly when no formula can be recovered", () => {
  assert.throws(() => normalizeText("hello world"), /Could not identify/);
});

test("fails visibly for malformed JSON", () => {
  assert.throws(() => normalizeText('{"batch":'), /JSON input is not valid/);
});

test("normalizes 48 deterministic unit and finished-batch alias combinations", () => {
  const batchAliases = ["FINISHED BATCH", "Final batch", "Batch size", "Final yield"];
  const units = [
    ["kilograms", "kg"], ["grams", "g"], ["milligrams", "mg"],
    ["micrograms", "ug"], ["µg", "ug"], ["μg", "ug"],
    ["litres", "L"], ["liters", "L"], ["millilitres", "mL"],
    ["milliliters", "mL"], ["mcg", "ug"], ["gms", "g"],
  ];
  for (const batchAlias of batchAliases) {
    for (const [unit, expectedUnit] of units) {
      const result = normalizeText(
        `Item\tQuantity\tUnit\n${batchAlias}\t1000\tL\nTest ingredient\t1.25\t${unit}`,
      );
      assert.equal(result.rows[0].item, "FINISHED BATCH", batchAlias);
      assert.equal(result.rows[1].unit, expectedUnit, `${batchAlias} / ${unit}`);
    }
  }
});


test("physical line coordinates survive blank lines and Markdown separators", () => {
  const result = normalizeText("\nItem | Quantity | Unit\n--- | --- | ---\n\nFINISHED BATCH | 1000 | litres\n\nSugar | 500 | grams\n");
  assert.deepEqual(result.rows.map(row => row.source_line), [5, 7]);
  assert.equal(result.rows[1].input_source.text, "Sugar | 500 | grams");
});

test("worksheet coordinates and original cells survive blank rows and edits", () => {
  const result = normalizeMatrix([[], ["Item", "Quantity", "Unit"], [], ["FINISHED BATCH", "1,000", "litres"], [], ["Sugar", "500", "grams"]], "XLSX spreadsheet", { worksheet: 1 });
  const row = result.rows[1];
  row.quantity = "400";
  row.item = "Sucrose";
  assert.equal(row.input_source.line, 6);
  assert.equal(row.input_source.worksheet, 1);
  assert.deepEqual(row.input_source.cells, ["Sugar", "500", "grams"]);
  assert.deepEqual(row.input_source.original, { item: "Sugar", quantity: "500", unit: "g" });
  assert.match(rowsToTsv(result.rows), /Sucrose\t400\tg/);
});

test("PDF page boundaries and OCR engine confidence survive normalization", () => {
  const ocr = { engine: "Tesseract.js 7 / LSTM", language: "eng", scope: "page", confidence: 73.25 };
  const result = normalizePages([{ text: "FINISHED BATCH 1000 L\n", ocr }, { text: "\nSugar 500 kg", ocr }], "PDF OCR");
  assert.deepEqual(result.rows.map(row => [row.input_source.page, row.input_source.line]), [[1, 1], [2, 2]]);
  assert.equal(result.rows[1].input_source.ocr.confidence, 73.25);
  assert.equal(result.rows[1].confidence, undefined);
});

test("JSON uses structural locations instead of invented physical lines", () => {
  const result = normalizeJson({ batch: { quantity: 1000, unit: "L" }, ingredients: [{ item: "Sugar", quantity: 500, unit: "kg" }] });
  assert.deepEqual(result.rows.map(row => row.input_source.json_path), ["batch", "ingredients[0]"]);
  assert.ok(result.rows.every(row => row.source_line === undefined));
  assert.equal(JSON.parse(result.rows[1].input_source.text).quantity, 500);
});


test("JSON provenance excludes unrelated object and nested quantity metadata", () => {
  const result = normalizeJson({
    owner_note: "PRIVATE-UNUSED",
    batch: { quantity: { value: "1000", unit: "L", private_note: "PRIVATE-UNUSED" }, customer: "PRIVATE-UNUSED" },
    ingredients: [{ item: "Sugar", quantity: { value: "500", unit: "kg", secret: "PRIVATE-UNUSED" }, supplier_contact: "PRIVATE-UNUSED" }],
  });
  assert.ok(!JSON.stringify(result.rows).includes("PRIVATE-UNUSED"));
  assert.deepEqual(JSON.parse(result.rows[1].input_source.text), { item: "Sugar", quantity: "500", unit: "kg" });
  assert.equal(result.rows[1].input_source.json_path, "ingredients[0]");
});
