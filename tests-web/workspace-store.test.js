import assert from "node:assert/strict";
import test from "node:test";

import { browserWorkspaceRecord } from "../public/workspace-store.js";

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
