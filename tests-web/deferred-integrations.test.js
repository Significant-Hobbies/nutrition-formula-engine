import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { afterPageLoad, loadDeferredScripts } from "../public/deferred-integrations.js";

test("remote integrations wait for load and run outside the load event", () => {
  let onLoad;
  let scheduled;
  let started = false;
  const pageWindow = {
    addEventListener(event, callback, options) {
      assert.equal(event, "load");
      assert.equal(options.once, true);
      onLoad = callback;
    },
    setTimeout(callback, delay) {
      assert.equal(delay, 0);
      scheduled = callback;
    },
  };
  afterPageLoad(() => { started = true; }, pageWindow, { readyState: "interactive" });
  assert.equal(started, false);
  assert.equal(scheduled, undefined);
  onLoad();
  assert.equal(started, false);
  scheduled();
  assert.equal(started, true);
});

test("an already loaded page schedules integrations without waiting for another load", () => {
  let scheduled;
  afterPageLoad(() => {}, {
    setTimeout(callback) { scheduled = callback; },
    addEventListener() { assert.fail("the load event has already happened"); },
  }, { readyState: "complete" });
  assert.equal(typeof scheduled, "function");
});

test("deferred scripts preserve integration settings and activate only once", () => {
  let pending = true;
  const attributes = {
    type: "text/plain",
    "data-after-load-src": "https://health.sassmaker.com/tracker.js",
    "data-project": "nutrition-formula-engine",
    "data-endpoint": "https://ingest.sassmaker.com/v1/browser",
  };
  let activated;
  const placeholder = {
    attributes: Object.entries(attributes).map(([name, value]) => ({ name, value })),
    getAttribute(name) { return attributes[name]; },
    replaceWith(script) { activated = script; pending = false; },
  };
  const pageDocument = {
    querySelectorAll() { return pending ? [placeholder] : []; },
    createElement() {
      assert.equal(activated, undefined);
      return { attributes: {}, setAttribute(name, value) { this.attributes[name] = value; } };
    },
  };
  loadDeferredScripts(pageDocument);
  assert.equal(activated.src, attributes["data-after-load-src"]);
  assert.equal(activated.async, false);
  assert.deepEqual(activated.attributes, {
    "data-project": attributes["data-project"],
    "data-endpoint": attributes["data-endpoint"],
  });
  loadDeferredScripts(pageDocument);
});

test("entry pages preserve main studio footer and defer optional remote scripts", async () => {
  for (const path of ["index.html", "recent-formulas/index.html", "case-studies/index.html"]) {
    const html = await readFile(new URL(`../public/${path}`, import.meta.url), "utf8");
    for (const tag of html.matchAll(/<script\b[^>]*>/g)) {
      if (!tag[0].includes("health.sassmaker.com/tracker.js")) assert.doesNotMatch(tag[0], /\ssrc=["']https?:\/\//, `${path} has an eager remote script`);
      if (tag[0].includes("data-after-load-src")) {
        assert.match(tag[0], /type="text\/plain"/, `${path} must keep the placeholder inert`);
      }
    }
    assert.match(html, /studio-footer/);
  }
});
