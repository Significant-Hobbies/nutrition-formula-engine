// Run against a local Vite server. Supply an existing Playwright module via
// PLAYWRIGHT_MODULE; this qualification adds no production dependency.
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
const origin = process.env.QUALIFICATION_ORIGIN || "http://127.0.0.1:43189";
assert.equal(new URL(origin).hostname, "127.0.0.1", "Local fixture server required");
const output = new URL("../.qualification-nutrition/evidence/", import.meta.url);
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true, channel: process.env.QUALIFICATION_BROWSER_CHANNEL || undefined });
const evidence = [];
const record = {
  formula_id: "fixture-online", product_name: "Synthetic online formula",
  file_name: "fixture.tsv", current_version: 1, created_at: "2026-10-01T00:00:00Z",
};
try {
  for (const width of [390, 768, 1440]) {
    for (const scenario of ["empty", "503", "malformed", "invalid-record", "missing-identity", "browser-local", "browser-unavailable"]) {
      const context = await browser.newContext({ viewport: { width, height: 900 }, serviceWorkers: "block" });
      const page = await context.newPage();
      const errors = [];
      page.on("pageerror", error => errors.push(error.message));
      let release;
      const delayed = new Promise(resolve => { release = resolve; });
      let first = true;
      let requests = 0;
      await context.route("**/*", async route => {
        const request = route.request();
        const url = new URL(request.url());
        if (url.origin !== origin || !["GET", "HEAD", "OPTIONS"].includes(request.method())) return route.abort();
        // Seed on this origin without starting the calculator's background API
        // requests, which could otherwise consume the delayed history response.
        if (url.pathname === "/__fixture-seed") return route.fulfill({
          contentType: "text/html", body: "<!doctype html><title>Local fixture seed</title>",
        });
        if (url.pathname === "/api/formulas") {
          requests++;
          if (first) {
            first = false;
            await delayed;
            return route.fulfill({ status: ["503", "browser-local"].includes(scenario) ? 503 : 200,
              contentType: "application/json", body: JSON.stringify(scenario === "malformed" ? {}
                : scenario === "invalid-record" ? { workspaces: [null] }
                : scenario === "missing-identity" ? { workspaces: [{}] } : { workspaces: [] }) });
          }
          return route.fulfill({ json: { workspaces: [record] } });
        }
        if (url.pathname.startsWith("/api/")) return route.fulfill({ json: {} });
        return route.continue();
      });
      if (scenario === "browser-unavailable") await context.addInitScript(() => {
        Object.defineProperty(window, "indexedDB", { value: { open() { throw new Error("Synthetic storage unavailable"); } } });
      });
      if (scenario === "browser-local") {
        await page.goto(`${origin}/__fixture-seed`, { waitUntil: "domcontentloaded" });
        const seededId = await page.evaluate(async () => {
          const { saveBrowserWorkspace, loadBrowserWorkspace } = await import("/workspace-store.js");
          await saveBrowserWorkspace({ id: "active", formula_id: "fixture-local", saved_at: "2026-10-02T00:00:00Z",
            latest_file_name: "local.tsv", history: [{ version: 1, report: { product_name: "Synthetic browser formula" } }] });
          return (await loadBrowserWorkspace())?.formula_id;
        });
        assert.equal(seededId, "fixture-local");
        assert.equal(requests, 0, "Seeding must not consume a history response");
      }
      await page.goto(`${origin}/recent-formulas/`, { waitUntil: "domcontentloaded" });
      await page.waitForFunction(() => document.querySelector("#recent-formulas-status").textContent.includes("Loading"));
      assert.equal(await page.locator("#recent-formulas-empty").isVisible(), false);
      release();
      await page.waitForFunction(() => !document.querySelector("#recent-formulas-status").textContent.includes("Loading"));
      const settled = await page.locator("#recent-formulas-status").textContent();
      assert.equal(await page.locator("#recent-formulas-empty").isVisible(), scenario === "empty");
      assert.equal(await page.locator("#recent-formulas-retry").isVisible(), scenario !== "empty");
      if (scenario !== "empty") assert.match(settled, /could not be checked/);
      if (scenario === "browser-local") assert.equal(await page.locator(".recent-formula-card").count(), 1);
      await page.screenshot({ path: new URL(`history-${scenario}-${width}.png`, output).pathname, fullPage: true });
      if (scenario !== "empty") {
        await page.locator("#recent-formulas-retry").click();
        await page.waitForFunction(() => document.querySelector("#recent-formulas-list").textContent.includes("Synthetic online formula"));
        assert.equal(await page.locator("#recent-formulas-empty").isVisible(), false);
        assert.equal(await page.locator(".recent-formula-card").count(), scenario === "browser-local" ? 2 : 1);
      }
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
      assert.equal(overflow, false);
      assert.deepEqual(errors, []);
      evidence.push({ issue: 9, width, scenario, settled: settled.trim(), requests, recovery: scenario !== "empty", overflow, errors });
      await context.close();
    }
    const context = await browser.newContext({ viewport: { width, height: 900 }, serviceWorkers: "block" });
    await context.route("**/*", route => {
      const request = route.request();
      const url = new URL(request.url());
      if (url.origin !== origin || !["GET", "HEAD", "OPTIONS"].includes(request.method())) return route.abort();
      if (url.pathname.startsWith("/api/")) return route.fulfill({ json: { workspaces: [], ingredients: [] } });
      return route.continue();
    });
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.goto(`${origin}/`);
    await page.locator("#formula-text").fill("Item\tQuantity\tUnit\nFINISHED BATCH\t100\tg\nSugar\t20\tg\nPurified water with a deliberately longer ingredient name\t80\tg");
    await page.locator("#prepare-button").click();
    await page.locator("#draft-body tr").nth(2).waitFor();
    await page.waitForTimeout(800);
    const geometry = await page.evaluate(() => {
      const rect = element => { const r = element.getBoundingClientRect(); return { top: r.top, bottom: r.bottom, width: r.width }; };
      return { rows: [...document.querySelectorAll("#draft-body tr")].map(rect),
        controls: [...document.querySelectorAll("#draft-body input, #draft-body select")].map(rect),
        items: [...document.querySelectorAll("#draft-body td:first-child input")].map(rect),
        actions: rect(document.querySelector(".draft-actions")),
        maxHeight: getComputedStyle(document.querySelector(".draft-table-wrap")).maxHeight,
        overflow: document.documentElement.scrollWidth > innerWidth };
    });
    assert.equal(geometry.rows.length, 3);
    assert.ok(geometry.rows.every(row => row.bottom <= geometry.actions.top), "Rows overlap confirmation controls");
    assert.ok(geometry.items.every(control => control.width >= 100), "Recovered item controls are too narrow");
    assert.ok(geometry.controls.every(control => control.width >= 44), "Recovered controls are too narrow");
    assert.equal(geometry.overflow, false);
    if (width === 390) assert.equal(geometry.maxHeight, "none");
    await page.getByRole("textbox", { name: "Item row 3", exact: true }).fill("Purified water corrected locally");
    await page.getByRole("textbox", { name: "Quantity row 3", exact: true }).fill("79");
    await page.locator("#draft-body tr").nth(2).locator("select").selectOption("kg");
    assert.equal(await page.getByRole("textbox", { name: "Item row 3", exact: true }).inputValue(), "Purified water corrected locally");
    assert.equal(await page.getByRole("textbox", { name: "Quantity row 3", exact: true }).inputValue(), "79");
    assert.equal(await page.locator("#draft-body tr").nth(2).locator("select").inputValue(), "kg");
    await page.screenshot({ path: new URL(`recovered-rows-${width}.png`, output).pathname, fullPage: true });
    assert.deepEqual(errors, []);
    evidence.push({ issue: 8, width, geometry, editable: true, errors });
    await context.close();
  }
} finally {
  await browser.close();
  await writeFile(new URL("results.json", output), JSON.stringify(evidence, null, 2) + "\n");
}
console.log(`Passed ${evidence.length} fixture scenarios; evidence: ${output.pathname}`);
