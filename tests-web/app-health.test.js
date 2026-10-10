import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const home = await readFile(new URL("../public/index.html", import.meta.url), "utf8");

test("the public application loads its origin-bound App Health tracker once", () => {
  assert.equal((home.match(/health\.sassmaker\.com\/tracker\.js/g) ?? []).length, 1);
  assert.match(home, /<script\s[^>]*src="https:\/\/health\.sassmaker\.com\/tracker\.js"[^>]*\sdata-vitals(?=\s|>)[^>]*>/);
  assert.match(home, /data-key="ahk_pub_4ecc68a6c4627e5f69fabfd57fc37d72adaccc6b5a15e0d1c57047a194adfd0a"/);
  assert.match(home, /data-project="app-ec98e406-d4b2-4c9d-920a-6c9576896fa9"/);
  assert.match(home, /data-endpoint="https:\/\/ingest\.sassmaker\.com\/v1\/browser"/);
});
