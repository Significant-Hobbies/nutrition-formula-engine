import assert from "node:assert/strict";
import test from "node:test";
import { lineReviewPanel } from "../public/line-review.js";

class Element {
  constructor(tag) { this.tag = tag; this.children = []; this.listeners = {}; this.value = ""; }
  append(...items) {this.children.push(...items); if (this.tag === "select" && !this.value) this.value = items[0].value;}
  replaceChildren(...items) {this.children = items;}
  setAttribute() {}
  addEventListener(name, cb) {this.listeners[name] = cb;}
}

function descendants(node) {return [node, ...node.children.filter(c => typeof c === "object").flatMap(descendants)];}

test("line review preserves request across failed write, reads back, and isolates rows", async () => {
  const originalDocument = globalThis.document;
  globalThis.document = {createElement: tag => new Element(tag)};
  try {
    const records = [], writes = []; let fail = true;
    const fetcher = async (url, options) => {
      if (!options) return {ok: true, json: async () => ({rows: [{ordinal: 1, source_row_id: "first"}, {ordinal: 2, source_row_id: "second"}], decisions: records})};
      const d = JSON.parse(options.body); writes.push(d);
      if (fail) {fail = false; throw new Error("Synthetic lost response");}
      records.push(d);
      return {ok: true, json: async () => ({decision: d})};
    };
    const first = lineReviewPanel({formulaId: "fixture", version: 1, ordinal: 1, item: "duplicate", fetcher});
    const nodes = descendants(first);
    const retry = nodes.find(n => n.textContent === "Retry saved decision");
    assert.equal(retry.hidden, true);
    nodes.find(n => n.placeholder).value = "Check source";
    await nodes.find(n => n.textContent === "Search").listeners.click();
    assert.equal(writes[0].state, "search_pending");
    assert.equal(retry.hidden, false);
    await retry.listeners.click();
    assert.equal(retry.hidden, true);
    assert.deepEqual(writes[0], writes[1]);
    assert.match(nodes.find(n => n.tag === "p").textContent, /Search pending: Check source/);
    const second = lineReviewPanel({formulaId: "fixture", version: 1, ordinal: 2, item: "duplicate", fetcher});
    second.open = true; second.listeners.toggle(); await new Promise(resolve => setImmediate(resolve));
    assert.equal(descendants(second).find(n => n.tag === "p").textContent, "No source decisions recorded.");
  } finally {globalThis.document = originalDocument;}
});
