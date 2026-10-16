import test from "node:test";
import assert from "node:assert/strict";
import { normalizeText } from "../public/input-normalizer.js";
import { inputProvenance, sourceMarkdown } from "../public/input-provenance.js";

test("edited, removed and added rows keep exact source alignment", () => {
  const rows = normalizeText("FINISHED BATCH 1000 L\nSugar 500 kg\nWater 1 L").rows;
  rows[1].item = "Sucrose";
  rows.splice(2, 1);
  rows.push({ item: "Salt", quantity: "1", unit: "g" });
  const payload = inputProvenance(rows);
  assert.equal(payload.rows[1].original.item, "Sugar");
  assert.equal(payload.rows[1].line, 2);
  assert.equal(payload.rows[2], null);
  assert.equal(payload.rows.length, rows.length);
  assert.match(sourceMarkdown(rows), /Sugar 500 kg/);
});


test("source Markdown renders links, images and backslashes as literal evidence", () => {
  const row = normalizeText("FINISHED BATCH 1000 L\nSugar 500 kg").rows[1];
  row.input_source.text = String.raw`[label](https://example.test) ![image](https://example.test/a) \* <script>`;
  const markdown = sourceMarkdown([row]);
  assert.ok(!markdown.includes("[label]"));
  assert.ok(!markdown.includes("![image]"));
  assert.ok(!markdown.includes("<script>"));
  assert.match(markdown, /&#91;label&#93;&#40;https&#58;\/\/example.test&#41;/);
  assert.match(markdown, /&#92;&#42;/);
});


test("legacy reports omit provenance instead of changing their input fingerprint", () => {
  assert.equal(inputProvenance([{ item: "FINISHED BATCH" }, { item: "Sugar" }]), undefined);
});
