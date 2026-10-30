import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const source = await readFile(new URL("../public/ingestion.js", import.meta.url), "utf8");
const controller = source.slice(source.indexOf("function abortable("), source.indexOf("async function recognizeImage("));

function fixture(createWorker) {
  const context = vm.createContext({
    createWorker, OEM: { LSTM_ONLY: 1 }, PSM: { SINGLE_BLOCK: 6 },
    progressLabel: String, console,
  });
  vm.runInContext(`let ocrWorkerPromise = null; let ocrProgress = () => {};\n${controller}`, context);
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

function recognitionFixture(createWorker) {
  const context = vm.createContext({ createWorker, OEM: { LSTM_ONLY: 1 }, PSM: { SINGLE_BLOCK: 6 }, progressLabel: (message) => message.status, console });
  const functions = source.slice(source.indexOf("function abortable("), source.indexOf("function pdfPageText("));
  vm.runInContext(`let ocrWorkerPromise = null; let ocrProgress = () => {};\n${functions}`, context);
  return context;
}

test("a recognition failure terminates the failed worker and the next image retries", async () => {
  let creations = 0;
  let terminations = 0;
  const context = recognitionFixture(async () => ({
    setParameters: async () => {}, terminate: async () => { terminations += 1; },
    recognize: async () => { if (++creations === 1) throw new Error("Recognition failed"); return { data: { text: "Sugar 2 mg" } }; },
  }));
  await assert.rejects(context.recognizeImage({}, () => {}), /Recognition failed/);
  assert.equal(terminations, 1);
  assert.equal((await context.recognizeImage({}, () => {})).text, "Sugar 2 mg");
});

test("a cached OCR worker sends progress to the current image callback", async () => {
  let logger;
  const context = recognitionFixture(async (_language, _mode, options) => {
    logger = options.logger;
    return { setParameters: async () => {}, recognize: async () => { logger({ status: "Recognizing" }); return { data: { text: "Sugar 2 mg" } }; } };
  });
  const first = [];
  const next = [];
  await context.recognizeImage({}, (message) => first.push(message));
  await context.recognizeImage({}, (message) => next.push(message));
  assert.equal(first.filter((message) => message === "Recognizing").length, 1);
  assert.equal(next.filter((message) => message === "Recognizing").length, 1);
});

test("aborted OCR initialization releases a retry and a late failure cannot reset its replacement", async () => {
  let failOld;
  let terminations = 0;
  let creations = 0;
  const ready = { setParameters: async () => {} };
  const context = recognitionFixture(async () => {
    if (++creations > 1) return ready;
    return { setParameters: async () => new Promise((_resolve, reject) => { failOld = reject; }), terminate: async () => { terminations += 1; } };
  });
  const abort = new AbortController();
  const old = context.getOcrWorker(() => {}, abort.signal);
  await new Promise(setImmediate);
  abort.abort();
  await assert.rejects(old, /abort/i);
  assert.equal(terminations, 1);
  assert.equal(await context.getOcrWorker(() => {}), ready);
  failOld(new Error("Late old failure"));
  await new Promise(setImmediate);
  assert.equal(await context.getOcrWorker(() => {}), ready);
  assert.equal(creations, 2);
});

test("aborting a hanging recognition terminates it and leaves the next image usable", async () => {
  let creations = 0;
  let terminations = 0;
  const context = recognitionFixture(async () => {
    const attempt = ++creations;
    return { setParameters: async () => {}, terminate: async () => { terminations += 1; }, recognize: async () => attempt === 1 ? new Promise(() => {}) : { data: { text: "Sugar 2 mg" } } };
  });
  const abort = new AbortController();
  const old = context.recognizeImage({}, () => {}, abort.signal);
  await new Promise(setImmediate);
  abort.abort();
  await assert.rejects(old, /abort/i);
  assert.equal(terminations, 1);
  assert.equal((await context.recognizeImage({}, () => {})).text, "Sugar 2 mg");
});

test("an OCR worker created after abort is terminated before configuration without disturbing its replacement", async () => {
  let finishOld;
  let creations = 0;
  let terminations = 0;
  let configurations = 0;
  const ready = { setParameters: async () => {} };
  const context = recognitionFixture(async () => ++creations === 1 ? new Promise((resolve) => { finishOld = resolve; }) : ready);
  const abort = new AbortController();
  const old = context.getOcrWorker(() => {}, abort.signal);
  abort.abort();
  await assert.rejects(old, /abort/i);
  assert.equal(await context.getOcrWorker(() => {}), ready);
  finishOld({ setParameters: async () => { configurations += 1; }, terminate: async () => { terminations += 1; } });
  await new Promise(setImmediate);
  assert.equal(terminations, 1);
  assert.equal(configurations, 0);
  assert.equal(await context.getOcrWorker(() => {}), ready);
  assert.equal(creations, 2);
});
