import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const source = await readFile(new URL("../public/ingestion.js", import.meta.url), "utf8");
const controller = source.slice(source.indexOf("async function getOcrWorker("), source.indexOf("async function recognizeImage("));

function fixture(createWorker) {
  const context = vm.createContext({
    createWorker, OEM: { LSTM_ONLY: 1 }, PSM: { SINGLE_BLOCK: 6 },
    progressLabel: String, console,
  });
  vm.runInContext(`let ocrWorkerPromise = null;\n${controller}`, context);
  return () => context.getOcrWorker(() => {});
}

for (const failureStage of ["creation", "parameters"]) {
  test(`OCR initialization can retry after ${failureStage} fails`, async () => {
    const failure = new Error("Synthetic initialization failure");
    let creations = 0;
    let configurations = 0;
    let failedTerminations = 0;
    let readyTerminations = 0;
    const worker = {
      setParameters: async () => { configurations += 1; },
      terminate: async () => { readyTerminations += 1; },
    };
    const getWorker = fixture(async () => {
      creations += 1;
      if (creations === 1) {
        if (failureStage === "creation") throw failure;
        return {
          setParameters: async () => { throw failure; },
          terminate: async () => { failedTerminations += 1; },
        };
      }
      return worker;
    });

    await assert.rejects(getWorker(), error => error === failure);
    assert.equal(await getWorker(), worker);
    assert.equal(await getWorker(), worker, "successful initialization remains cached");
    assert.equal(creations, 2);
    assert.equal(configurations, 1);
    assert.equal(failedTerminations, failureStage === "parameters" ? 1 : 0);
    assert.equal(readyTerminations, 0);
  });
}

test("concurrent retries share one pending OCR initialization", async () => {
  const failure = new Error("Synthetic startup failure");
  let creations = 0;
  let configurations = 0;
  let finishCreation;
  const pendingWorker = new Promise(resolve => { finishCreation = resolve; });
  const worker = { setParameters: async () => { configurations += 1; } };
  const getWorker = fixture(async () => {
    creations += 1;
    if (creations === 1) throw failure;
    return pendingWorker;
  });

  const failed = await Promise.allSettled([getWorker(), getWorker()]);
  assert.ok(failed.every(result => result.status === "rejected" && result.reason === failure));
  assert.equal(creations, 1, "initial callers share the failed attempt");
  const retries = [getWorker(), getWorker(), getWorker()];
  const settled = Promise.allSettled(retries);
  finishCreation(worker);
  const results = await settled;
  assert.ok(results.every(result => result.status === "fulfilled" && result.value === worker));
  assert.equal(creations, 2, "all retries share one replacement worker");
  assert.equal(configurations, 1);
});

test("failed worker cleanup cannot mask the initialization error or prevent retry", async () => {
  const failure = new Error("Synthetic parameter failure");
  let creations = 0;
  let terminations = 0;
  const readyWorker = { setParameters: async () => {} };
  const getWorker = fixture(async () => {
    creations += 1;
    if (creations > 1) return readyWorker;
    return {
      setParameters: async () => { throw failure; },
      terminate: async () => {
        terminations += 1;
        throw new Error("Synthetic cleanup failure");
      },
    };
  });

  await assert.rejects(getWorker(), error => error === failure);
  assert.equal(terminations, 1);
  assert.equal(await getWorker(), readyWorker);
  assert.equal(creations, 2);
});
