import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const data = JSON.parse(
  await readFile(new URL("../public/case-studies.json", import.meta.url), "utf8"),
);

test("publishes all twenty-six public validation cases", () => {
  assert.equal(data.cases.length, 26);
  assert.equal(data.cases.filter((study) => study.source === "WHO").length, 3);
  assert.equal(
    data.cases.filter((study) =>
      new URL(study.source_url).hostname.endsWith("dailymed.nlm.nih.gov"),
    ).length,
    22,
  );
});

test("publishes every available comparison instead of one headline value", () => {
  const comparisons = data.cases.flatMap((study) => study.components || [{
    component: study.component,
    declared: study.declared,
    predicted: study.predicted,
    difference_percent: study.difference_percent,
  }]);

  assert.equal(comparisons.length, 55);
  assert.equal(comparisons.length, data.overall_summary.comparison_count);
  assert.equal(
    data.cases.find((study) => study.product === "Plasma-Lyte A").components.length,
    6,
  );
  assert.equal(
    data.cases.find((study) => study.product === "USDA MyPlate Yogurt Smoothie in a Bag").components.length,
    6,
  );
  for (const comparison of comparisons) {
    assert.ok(comparison.component);
    assert.ok(comparison.declared);
    assert.ok(comparison.predicted);
    assert.ok(Number.isFinite(Number(comparison.difference_percent)));
  }
});

test("case studies have a separate plain-English page", async () => {
  const html = await readFile(
    new URL("../public/case-studies/index.html", import.meta.url),
    "utf8",
  );
  const home = await readFile(new URL("../public/index.html", import.meta.url), "utf8");
  assert.match(html, /Every product and value/);
  assert.match(html, /never guess a missing amount/);
  assert.match(home, /href="\/case-studies\/"/);
  assert.match(home, /<dt>122<\/dt><dd>tests<\/dd>/);
  assert.doesNotMatch(home, /id="case-study-body"/);
});

test("marketed medicine summary matches the displayed case differences", () => {
  const medicineNames = new Set([
    "Magnesium Oxide 400 mg tablet",
    "Ferrous Sulfate 325 mg tablet",
    "Zinc Sulfate Injection",
    "Calcium Carbonate 1250 mg tablet",
    "Potassium Chloride 750 mg tablet",
    "Magnesium Sulfate Injection 500 mg/mL",
    "Calcium Chloride Injection 100 mg/mL",
    "Calcium Gluconate Injection 100 mg/mL",
    "Zinc Chloride Injection 2.09 mg/mL",
    "Cupric Chloride Injection 1.07 mg/mL",
    "Selenious Acid Injection 65.4 mcg/mL",
    "Potassium Phosphates Injection",
    "Sodium Phosphates Injection",
    "Manganese Chloride Injection 0.36 mg/mL",
    "Chromic Chloride Injection 20.5 mcg/mL",
  ]);
  const differences = data.cases
    .filter((study) => medicineNames.has(study.product))
    .map((study) => Number(study.difference_percent));
  const mean = differences.reduce((sum, value) => sum + value, 0) / differences.length;
  assert.equal(differences.length, 15);
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
    assert.ok(
      host.endsWith("who.int")
      || host.endsWith("dailymed.nlm.nih.gov")
      || host.endsWith("myplate.gov"),
    );
  }
});
