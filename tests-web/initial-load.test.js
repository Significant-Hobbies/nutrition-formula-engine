import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const app = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
const section = (from, to) => app.slice(app.indexOf(from), app.indexOf(to));
const loaders = section("async function loadRemoteWorkspace(", "function selectFile(file)");
const initial = section("function startInitialLoad(", "if (requestedProduct) {");
const tick = () => new Promise(setImmediate);

function fixture() {
  const context = vm.createContext({
    inputGeneration: 0, savedLabelReview: null, sessionHistory: [], latestContents: "fresh input", latestFileName: "fresh.tsv", workspace: null,
    setStatus(message) { context.message = message; },
  });
  vm.runInContext(loaders, context);
  return context;
}

test("delayed browser workspace cannot replace fresh input", async () => {
  const context = fixture();
  let finish;
  context.loadBrowserWorkspace = () => new Promise((resolve) => { finish = resolve; });
  const pending = context.loadSavedBrowserFormula();
  context.inputGeneration += 1;
  finish({ storage: "browser", history: [{ report: {} }] });
  await pending;
  assert.equal(context.latestContents, "fresh input");
  assert.equal(context.workspace, null);
});

test("delayed remote versions cannot replace fresh input or label review", async () => {
  const context = fixture();
  let finish;
  context.loadBrowserWorkspace = async () => ({ formula_id: "old", label_review: { old: true } });
  let calls = 0;
  context.fetch = async () => ++calls === 1 ? new Response(JSON.stringify({ versions: [{ version: 1 }] }))
    : new Promise((resolve) => { finish = resolve; });
  const pending = context.loadRemoteWorkspace("old");
  await tick();
  context.inputGeneration += 1;
  finish(new Response(JSON.stringify({ version: 1, report: {} })));
  await pending;
  assert.equal(context.workspace, null);
  assert.equal(context.latestContents, "fresh input");
  assert.equal(context.savedLabelReview, null);
});

test("initial loading has a bounded, actionable failure and invalidates late source commits", async () => {
  let expire;
  let finish;
  let cleared = false;
  const context = fixture();
  context.setTimeout = (callback) => { expire = callback; return 1; };
  context.clearTimeout = () => { cleared = true; };
  context.loadBrowserWorkspace = () => new Promise((resolve) => { finish = resolve; });
  vm.runInContext(initial, context);
  context.startInitialLoad((generation) => context.loadSavedBrowserFormula(generation), "Opening the saved formula");
  expire();
  await tick();
  assert.equal(context.inputGeneration, 1);
  assert.match(context.message, /Opening the saved formula timed out.*Reload.*paste\/upload/);
  finish({ storage: "browser", history: [{ report: {} }] });
  await tick();
  assert.equal(context.workspace, null);
  assert.equal(cleared, true);
});

test("a late sample response cannot overwrite a newly pasted formula", async () => {
  let finish;
  let prepared = 0;
  const context = vm.createContext({
    inputGeneration: 0, window: { location: { search: "?sample=1" } }, URLSearchParams,
    formulaText: { value: "new customer formula" }, sampleTsvUrl: "sample.tsv", setTimeout: () => 1, clearTimeout() {}, setStatus() {},
    fetch: async () => new Promise((resolve) => { finish = resolve; }), prepareInput: async () => { prepared += 1; },
  });
  vm.runInContext(initial + section('if (new URLSearchParams(window.location.search).get("sample")', '// Core handlers are registered'), context);
  context.inputGeneration += 1;
  finish(new Response("old sample"));
  await tick();
  assert.equal(context.formulaText.value, "new customer formula");
  assert.equal(prepared, 0);
});

test("bootstrap notice is independent of the core module and only checks core readiness", async () => {
  const html = await readFile(new URL("../public/index.html", import.meta.url), "utf8");
  const script = html.match(/<script>\s*(setTimeout\(\(\) => \{\s*if \(!window.formulaAppReady\)[\s\S]*?)<\/script>/)[1];
  let expire;
  const notice = { hidden: true };
  const context = vm.createContext({ window: {}, document: { querySelector: () => notice }, setTimeout(callback, ms) { assert.equal(ms, 10000); expire = callback; } });
  vm.runInContext(script, context);
  expire();
  assert.equal(notice.hidden, false);
  notice.hidden = true;
  context.window.formulaAppReady = true;
  expire();
  assert.equal(notice.hidden, true);
  assert.match(html, /<noscript>/);
});
