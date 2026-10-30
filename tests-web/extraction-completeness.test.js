import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { normalizeText, rowsToTsv } from "../public/input-normalizer.js";
import { inputProvenance, sourceMarkdown } from "../public/input-provenance.js";
import { buildNutritionLabel, identityReviewKey } from "../public/nutrition-label.js";
import { buildResultReadiness } from "../public/result-readiness.js";
import { scenarioEligibility, buildAssumptionScenario } from "../public/assumption-scenario.js";

const root = new URL("../", import.meta.url);
const projectPython = fileURLToPath(new URL(".venv/bin/python", root));
const python = process.env.PYTHON || (existsSync(projectPython) ? projectPython : "python3");

for (const ingredient of ["Water 1 g", "Sugar 200 mg"]) test(`actual extraction → Python engine → label retains excluded OCR source with ${ingredient}`, () => {
  const extraction = normalizeText(`FINISHED BATCH 1 mL\n${ingredient}\nSalt 1O g`, "image OCR");
  assert.equal(extraction.unparsedRows.length, 1);
  const payload = { contents: rowsToTsv(extraction.rows), provenance: inputProvenance(extraction.rows, extraction.unparsedRows) };
  const report = JSON.parse(execFileSync(python, ["-c", "import json,sys; from nutrition_formula.upload_analysis import analyze_formula_upload; p=json.load(sys.stdin); print(json.dumps(analyze_formula_upload(p['contents'],'ocr.tsv',input_provenance=p['provenance'])))"], {
    cwd: root, input: JSON.stringify(payload), encoding: "utf8", env: { ...process.env, PYTHONPATH: "src" },
  }));
  const options = { servingSize: "1", waterBase: true, assumptionEstimate: true,
    confirmedIdentities: new Set(report.formula_rows.map(identityReviewKey)) };
  const label = buildNutritionLabel(report, options);
  assert.equal(label.nutrients.find((row) => row.id === "sodium").perServing, "Not established");
  assert.equal(label.nutrients.find((row) => row.id === "sodium").rdaPercent, "Not established");
  assert.equal(label.hasIncompleteData, true);
  assert.match(label.unavailableSummary, /1 source line not included; correct it/);
  assert.equal(buildResultReadiness(report, options).partial, true);
  assert.equal(scenarioEligibility(report, options).allowed, false);
  assert.equal(buildAssumptionScenario(report, options), report);
  assert.equal(report.input_provenance.unparsed_rows[0].text, "Salt 1O g");
  assert.match(report.markdown, /Salt 1O g/);
  assert.match(sourceMarkdown(report.formula_rows, report.input_provenance.unparsed_rows), /Salt 1O g/);
  if (ingredient.startsWith("Sugar")) assert.match(label.nutrients.find((row) => row.id === "carbohydrate").perServing, /^≥/);
  else assert.equal(label.groups.at(-1).nutrients[0].perServing, "1");
});
