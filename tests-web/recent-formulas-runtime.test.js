import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import { recentFormulaItems } from "../public/recent-formulas-model.js";

// Minimal DOM fixture exercises the shipped controller, including its async
// loading and retry path. Layout is qualified separately in tests-browser.
const source = (await readFile(new URL("../public/recent-formulas.js", import.meta.url), "utf8"))
  .replace(/^import .*;\n/gm, "");
function element() {
  return {
    hidden: false, disabled: false, textContent: "", children: [], listeners: {},
    replaceChildren() { this.children = []; },
    append(...children) { this.children.push(...children); },
    setAttribute() {},
    addEventListener(name, listener) { this.listeners[name] = listener; },
  };
}
const settle = () => new Promise(resolve => setImmediate(resolve));
function fixture({ browserWorkspace = null, browserError = false } = {}) {
  const nodes = Object.fromEntries(["list", "empty", "status", "retry"].map(name => [name, element()]));
  nodes.empty.hidden = nodes.retry.hidden = true;
  const pending = [];
  vm.runInNewContext(source, {
    document: {
      querySelector: selector => nodes[selector.replace("#recent-formulas-", "")],
      createElement: element,
    },
    recentFormulaItems,
    loadBrowserWorkspace: async () => {
      if (browserError) throw new Error("Fixture storage failure");
      return browserWorkspace;
    },
    fetch: () => new Promise(resolve => pending.push(resolve)),
  });
  return { nodes, pending, respond(payload, ok = true) {
    assert.ok(pending.length, "Expected history request");
    pending.shift()({ ok, json: async () => payload });
  } };
}
const online = { formula_id: "online-fixture", product_name: "Online fixture", current_version: 1 };
const local = { formula_id: "local-fixture", latest_file_name: "local.tsv",
  history: [{ version: 1, report: { product_name: "Local fixture" } }] };

test("delayed history does not claim empty before a successful empty response", async () => {
  const { nodes, respond } = fixture();
  await settle();
  assert.equal(nodes.status.textContent, "Loading saved formulas…");
  assert.equal(nodes.empty.hidden, true);
  respond({ workspaces: [] });
  await settle();
  assert.equal(nodes.empty.hidden, false);
  assert.equal(nodes.status.textContent, "Nothing has been saved yet.");
  assert.equal(nodes.retry.hidden, true);
});

for (const failure of ["503", "malformed", "invalid-record", "missing-identity"]) {
  test(`${failure} remains unknown and retry recovers online history`, async () => {
    const { nodes, respond } = fixture();
    await settle();
    const payload = failure === "malformed" ? {}
      : failure === "invalid-record" ? { workspaces: [null] }
      : failure === "missing-identity" ? { workspaces: [{}] } : null;
    respond(payload, failure !== "503");
    await settle();
    assert.equal(nodes.empty.hidden, true);
    assert.equal(nodes.status.textContent, "Online formulas could not be checked.");
    assert.equal(nodes.retry.hidden, false);
    const retry = nodes.retry.listeners.click();
    await settle();
    assert.equal(nodes.retry.disabled, true);
    assert.equal(nodes.status.textContent, "Loading saved formulas…");
    respond({ workspaces: [online] });
    await retry;
    assert.equal(nodes.list.children.length, 1);
    assert.equal(nodes.status.textContent, "1 saved formula");
    assert.equal(nodes.empty.hidden, true);
    assert.equal(nodes.retry.hidden, true);
    assert.equal(nodes.retry.disabled, false);
  });
}

test("online failure preserves and labels browser-local entries through retry", async () => {
  const { nodes, respond } = fixture({ browserWorkspace: local });
  await settle();
  respond(null, false);
  await settle();
  assert.equal(nodes.empty.hidden, true);
  assert.equal(nodes.list.children.length, 1);
  assert.equal(nodes.list.children[0].children[0].children[0].textContent, "Local fixture");
  assert.equal(nodes.list.children[0].children[0].children[2].textContent, "Saved in this browser");
  assert.match(nodes.status.textContent, /1 saved formula Online formulas could not be checked/);
  const retry = nodes.retry.listeners.click();
  await settle();
  respond({ workspaces: [online] });
  await retry;
  assert.equal(nodes.list.children.length, 2);
});

test("unavailable browser storage with empty online history remains unknown", async () => {
  const { nodes, respond } = fixture({ browserError: true });
  await settle();
  respond({ workspaces: [] });
  await settle();
  assert.equal(nodes.empty.hidden, true);
  assert.equal(nodes.status.textContent, "Formulas saved in this browser could not be checked.");
  assert.equal(nodes.retry.hidden, false);
});

test("online records remain available when browser storage fails", async () => {
  const { nodes, respond } = fixture({ browserError: true });
  await settle();
  respond({ workspaces: [online] });
  await settle();
  assert.equal(nodes.list.children.length, 1);
  assert.match(nodes.status.textContent, /1 saved formula Formulas saved in this browser could not be checked/);
  assert.equal(nodes.empty.hidden, true);
});
