import assert from "node:assert/strict";
import test from "node:test";

import { recentFormulaItems } from "../public/recent-formulas-model.js";

test("recent formulas map online records to links that reopen the calculator", () => {
  const items = recentFormulaItems([
    {
      formula_id: "formula/one",
      product_name: "Oral haematinic syrup",
      file_name: "tonic.tsv",
      current_version: 3,
      created_at: "2026-09-20T10:00:00Z",
    },
  ]);

  assert.deepEqual(items[0], {
    id: "formula/one",
    name: "Oral haematinic syrup",
    fileName: "tonic.tsv",
    version: 3,
    savedAt: "2026-09-20T10:00:00Z",
    storage: "online",
    href: "/?formula=formula%2Fone",
  });
});

test("a browser-only formula appears in recents and sorts by save time", () => {
  const items = recentFormulaItems(
    [{
      formula_id: "online-1",
      product_name: "Older formula",
      file_name: "older.tsv",
      current_version: 1,
      created_at: "2026-09-19T10:00:00Z",
    }],
    {
      formula_id: "browser-1",
      saved_at: "2026-09-21T10:00:00Z",
      latest_file_name: "local.tsv",
      history: [{
        version: 2,
        report: {
          product_name: "Uploaded formula",
          product_inference: { name: "Browser formula" },
        },
      }],
    },
  );

  assert.equal(items[0].name, "Browser formula");
  assert.equal(items[0].href, "/?resume=browser");
  assert.equal(items[0].storage, "browser");
  assert.equal(items[1].name, "Older formula");
});

test("an online browser pointer is not shown as a duplicate formula", () => {
  const items = recentFormulaItems([], {
    storage: "server",
    formula_id: "online-1",
    current_version: 2,
    saved_at: "2026-09-21T10:00:00Z",
  });

  assert.deepEqual(items, []);
});

test("the recent formulas page describes one public list without access keys", async () => {
  const html = await import("node:fs/promises").then(({ readFile }) =>
    readFile(new URL("../public/recent-formulas/index.html", import.meta.url), "utf8"));

  assert.match(html, /Saved formulas are public and appear here on every device/);
  assert.doesNotMatch(html, /access key/i);
});
