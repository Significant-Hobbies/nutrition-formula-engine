import assert from "node:assert/strict";
import test from "node:test";

import {
  appendSessionVersion,
  componentDelta,
  contributionValue,
  restoreSessionVersion,
} from "../public/version-history.js";

function report(value) {
  return {
    screened_components: [{ id: "iron", name: "Iron", value, unit: "mg" }],
  };
}

test("records immutable session versions and numerical deltas", () => {
  const first = appendSessionVersion([], report("1"), "created");
  const second = appendSessionVersion(first, report("1.25"), "identity_replaced", 2);

  assert.equal(first[0].report.screened_components[0].value, "1");
  assert.equal(second[1].delta[0].change, 0.25);
  assert.equal(second[1].server_version, 2);
});

test("restoring creates a new immutable version", () => {
  const first = appendSessionVersion([], report("1"), "created");
  const second = appendSessionVersion(first, report("2"), "edited");
  const restored = restoreSessionVersion(second, 1);

  assert.equal(restored.history.length, 3);
  assert.equal(restored.history[2].cause, "restored_from_v1");
  assert.equal(restored.report.screened_components[0].value, "1");
});

test("chooses the contribution value for the report basis", () => {
  const contribution = { per_100_ml: "2", per_100_g: "3" };
  assert.equal(contributionValue(contribution, "per 100 mL"), "2");
  assert.equal(contributionValue(contribution, "per 100 g"), "3");
});

test("unchanged reports have no component delta", () => {
  assert.deepEqual(componentDelta(report("1"), report("1")), []);
});

test("keeps version numbers monotonic after bounded history drops old entries", () => {
  let history = [];
  for (let value = 1; value <= 30; value += 1) {
    history = appendSessionVersion(history, report(String(value)), "edited");
  }

  assert.equal(history.length, 25);
  assert.equal(history[0].version, 6);
  assert.equal(history.at(-1).version, 30);
});
