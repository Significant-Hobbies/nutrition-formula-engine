import assert from "node:assert/strict";
import test from "node:test";
import { createCalculationRequests } from "../public/calculation-request.js";

const report = { product_name: "Formula", formula_rows: [{ item: "FINISHED BATCH" }, { item: "Sugar" }], screened_components: [], present_components: [], report_assumptions: [], missing_information: [], coverage: {}, label_batch_quantity: "1", basis_label: "per 100 mL" };
const response = (data = report, status = 200) => new Response(JSON.stringify(data), { status });

for (const status of [404, 408, 429, 500, 503]) test(`HTTP ${status} allows an honest input-only fallback`, async () => {
  const runner = createCalculationRequests({ fetchImpl: async () => response({ error: "Unavailable" }, status) });
  await assert.rejects(runner.start().fetchJson("/api/analyze"), (error) => error.fallback && error.status === status);
});
for (const status of [400, 401, 403, 409, 422]) test(`HTTP ${status} preserves authoritative corrections`, async () => {
  const runner = createCalculationRequests({ fetchImpl: async () => response({ error: "Row 2 needs a valid unit" }, status) });
  await assert.rejects(runner.start().fetchJson("/api/analyze"), (error) => !error.fallback && error.message === "Row 2 needs a valid unit");
});
test("network failure permits fallback and retry can succeed", async () => {
  let fail = true;
  const runner = createCalculationRequests({ fetchImpl: async () => { if (fail) throw new TypeError("offline"); return response(); } });
  await assert.rejects(runner.start().fetchJson("/api/analyze"), (error) => error.fallback);
  fail = false;
  assert.deepEqual((await runner.start().fetchJson("/api/analyze")).data, report);
});
test("timeout bounds a stalled service and aborts its signal", async () => {
  let signal;
  const runner = createCalculationRequests({ timeoutMs: 10, fetchImpl: async (_url, options) => { signal = options.signal; return new Promise(() => {}); } });
  await assert.rejects(runner.start().fetchJson("/api/analyze"), (error) => error.fallback && /timed out/.test(error.message));
  assert.equal(signal.aborted, true);
});
test("latest submission wins even when the previous service ignores abort", async () => {
  let finishFirst;
  let calls = 0;
  const runner = createCalculationRequests({ fetchImpl: async () => ++calls === 1 ? new Promise((resolve) => { finishFirst = resolve; }) : response() });
  const first = runner.start();
  const old = first.fetchJson("/api/analyze").catch((error) => error);
  const second = runner.start();
  assert.equal(first.isCurrent(), false);
  assert.deepEqual((await second.fetchJson("/api/analyze")).data, report);
  assert.equal((await old).fallback, false);
  finishFirst(response({ ...report, product_name: "stale" }));
  assert.equal(second.isCurrent(), true);
});
test("editing input cancels an in-flight request without generating a fallback for obsolete rows", async () => {
  const runner = createCalculationRequests({ fetchImpl: async () => new Promise(() => {}) });
  const request = runner.start();
  const promise = request.fetchJson("/api/analyze");
  runner.cancel();
  await assert.rejects(promise, (error) => !error.fallback);
  assert.equal(request.isCurrent(), false);
});
for (const [name, data] of [["unreadable JSON", "not JSON"], ["malformed successful payload", "{}"]]) {
  test(`${name} cannot leave a blank result`, async () => {
    const runner = createCalculationRequests({ fetchImpl: async () => new Response(data) });
    await assert.rejects(runner.start().fetchJson("/api/analyze"), (error) => error.fallback);
  });
}
