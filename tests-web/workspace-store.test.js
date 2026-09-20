import assert from "node:assert/strict";
import test from "node:test";

import {
  browserIngredientRecord,
  browserWorkspaceRecord,
  serverWorkspaceRecord,
} from "../public/workspace-store.js";

test("browser workspace records are bounded and detached from live history", () => {
  const history = Array.from({ length: 12 }, (_, index) => ({
    version: index + 1,
    report: { value: index + 1 },
  }));
  const record = browserWorkspaceRecord({
    history,
    latestContents: "rows",
    latestFileName: "formula.tsv",
    formulaId: "browser-1",
  });

  assert.equal(record.history.length, 10);
  assert.equal(record.history[0].version, 3);
  history[11].report.value = 99;
  assert.equal(record.history[9].report.value, 12);
});

test("browser workspace requires a calculated version", () => {
  assert.throws(
    () => browserWorkspaceRecord({ history: [] }),
    /calculated report/,
  );
});

test("database workspace pointers retain no formula or report contents", () => {
  assert.deepEqual(
    Object.keys(serverWorkspaceRecord({ formulaId: "formula-1", currentVersion: 3 })).sort(),
    ["current_version", "formula_id", "id", "saved_at", "storage"],
  );
});

test("browser ingredient records preserve alias, identity, source, and version", () => {
  const record = browserIngredientRecord({
    item: "Supplier B6™",
    material_id: "pyridoxine_hydrochloride",
    interpretation: "Pyridoxine hydrochloride",
    source: "Supplier CoA 2026-09",
    profile_version: "profile-v2",
    reusable_profile: true,
  });

  assert.equal(record.alias_key, "supplier b6");
  assert.equal(record.material_id, "pyridoxine_hydrochloride");
  assert.equal(record.canonical_name, "Pyridoxine hydrochloride");
  assert.equal(record.source, "Supplier CoA 2026-09");
  assert.equal(record.profile_version, "profile-v2");
});

test("browser ingredient records reject unresolved materials", () => {
  assert.throws(() => browserIngredientRecord({ item: "Unknown" }), /reusable profile/);
});
