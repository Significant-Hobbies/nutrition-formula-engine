import test from "node:test";
import assert from "node:assert/strict";

import { normalizeJson, normalizeMatrix, normalizeText, rowsToTsv } from "../public/input-normalizer.js";

const expected = [
  { item: "FINISHED BATCH", quantity: "1000", unit: "L", source_line: 2 },
  { item: "Ferric ammonium citrate", quantity: "13.4", unit: "kg", source_line: 3 },
];

test("normalizes a TSV table", () => {
  const result = normalizeText("Item\tQuantity\tUnit\nFINISHED BATCH\t1000\tL\nFerric ammonium citrate\t13.4\tkg");
  assert.deepEqual(result.rows, expected);
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
