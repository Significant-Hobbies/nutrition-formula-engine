import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const data = JSON.parse(
  await readFile(new URL("../public/case-studies.json", import.meta.url), "utf8"),
);

test("publishes all fifteen public validation cases", () => {
  assert.equal(data.cases.length, 15);
  assert.equal(data.cases.filter((study) => study.source === "WHO").length, 3);
  assert.equal(
    data.cases.filter((study) =>
      new URL(study.source_url).hostname.endsWith("dailymed.nlm.nih.gov"),
    ).length,
    12,
  );
});

test("marketed medicine summary matches the displayed case differences", () => {
  const medicineNames = new Set([
    "Magnesium Oxide 400 mg tablet",
    "Ferrous Sulfate 325 mg tablet",
    "Zinc Sulfate Injection",
    "Calcium Carbonate 1250 mg tablet",
    "Potassium Chloride 750 mg tablet",
  ]);
  const differences = data.cases
    .filter((study) => medicineNames.has(study.product))
    .map((study) => Number(study.difference_percent));
  const mean = differences.reduce((sum, value) => sum + value, 0) / differences.length;
  assert.equal(differences.length, 5);
  assert.equal(mean.toFixed(3), data.marketed_medicine_summary.mean_absolute_percentage_difference);
  assert.equal(
    Math.max(...differences).toFixed(3),
    data.marketed_medicine_summary.maximum_absolute_percentage_difference,
  );
});

test("overall summary exposes the food-reference variation instead of hiding it", () => {
  const differences = data.cases.map((study) => Number(study.difference_percent)).sort((a, b) => a - b);
  const mean = differences.reduce((sum, value) => sum + value, 0) / differences.length;
  assert.equal(data.overall_summary.case_count, differences.length);
  assert.equal(mean.toFixed(3), data.overall_summary.mean_absolute_percentage_difference);
  assert.equal(
    differences[Math.floor(differences.length / 2)].toFixed(3),
    data.overall_summary.median_absolute_percentage_difference,
  );
  assert.equal(
    Math.max(...differences).toFixed(3),
    data.overall_summary.maximum_absolute_percentage_difference,
  );
  assert.ok(Math.max(...differences) < 5);
});

test("case-study links use the named authoritative domains", () => {
  for (const study of data.cases) {
    const host = new URL(study.source_url).hostname;
    assert.ok(host.endsWith("who.int") || host.endsWith("dailymed.nlm.nih.gov"));
  }
});
