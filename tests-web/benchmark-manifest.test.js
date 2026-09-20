import assert from "node:assert/strict";
import test from "node:test";

import manifest from "../benchmarks/manifest.json" with { type: "json" };
import { normalizeText } from "../public/input-normalizer.js";

test("frozen extraction benchmark recovers all expected rows exactly", () => {
  for (const benchmark of manifest.extraction_cases) {
    const result = normalizeText(benchmark.input);
    assert.equal(result.rows.length, benchmark.expected_rows, benchmark.id);
    const last = result.rows.at(-1);
    assert.deepEqual(
      { item: last.item, quantity: last.quantity, unit: last.unit },
      benchmark.expected_last,
      benchmark.id,
    );
  }
});

test("benchmark stages and thresholds stay explicit", () => {
  assert.equal(manifest.calculation_cases.length, 26);
  assert.equal(manifest.identity_cases.length, 20);
  assert.equal(manifest.extraction_cases.length, 20);
  assert.equal(manifest.thresholds.calculation_maximum_difference_percent, 5);
});
