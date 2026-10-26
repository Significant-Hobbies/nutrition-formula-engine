// Local-only regression and rendering check. Existing Playwright installation required.
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { mkdir, writeFile } from "node:fs/promises";
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
const origin = process.env.QUALIFICATION_ORIGIN || "http://127.0.0.1:43190";
assert.equal(new URL(origin).hostname, "127.0.0.1");
const output = new URL("../.qualification-nutrition/extraction/", import.meta.url);
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true, channel: "chrome" });
const evidence = [];
try {
  for (const width of [390, 768, 1440]) {
    const context = await browser.newContext({ viewport: { width, height: 900 }, serviceWorkers: "block" });
    const page = await context.newPage();
    const calculations = [];
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    await context.route("**/*", route => {
      const request = route.request();
      const url = new URL(request.url());
      if (url.origin !== origin) return route.abort();
      if (request.method() === "POST") {
        calculations.push(request.postDataJSON());
        return route.fulfill({ status: 400, json: { error: "Synthetic calculation boundary reached" } });
      }
      if (url.pathname.startsWith("/api/")) return route.fulfill({ json: { workspaces: [], profiles: [] } });
      return route.continue();
    });
    for (const kind of ["paste", "damaged", "wrapped", "text", "json", "xlsx", "pdf", "pdf-blank", "published-match"]) {
      await page.goto(origin);
      const contents = "\nItem\tQuantity\tUnit\n\nFINISHED BATCH\t1000\tL\n\nSugar\t500\tkg\n";
      let expectedLine = 6;
      if (kind === "paste") await page.locator("#formula-text").fill(contents);
      if (kind === "damaged" || kind === "wrapped") {
        await page.locator("#formula-text").fill(`FINISHED BATCH 1000 L\nSugar 500 kg\n${kind === "damaged" ? "Salt 1O g" : "Salt\n10 g"}`);
        expectedLine = 2;
      }
      if (kind === "text") await page.locator("#formula-file").setInputFiles({ name: "formula.txt", mimeType: "text/plain", buffer: Buffer.from(contents) });
      if (kind === "json") {
        const json = { batch: { quantity: "1000", unit: "L", private_note: "PRIVATE-UNUSED" }, ingredients: [{ item: "Sugar", quantity: "500", unit: "kg", private_note: "PRIVATE-UNUSED" }] };
        await page.locator("#formula-file").setInputFiles({ name: "formula.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(json)) });
        expectedLine = undefined;
      }
      if (kind === "xlsx" || kind === "pdf" || kind === "pdf-blank") {
        await page.locator("#formula-file").setInputFiles(fileURLToPath(new URL(`fixtures/${kind === "xlsx" ? "blank-rows.xlsx" : kind === "pdf-blank" ? "blank-page.pdf" : "two-pages.pdf"}`, import.meta.url)));
        expectedLine = kind === "xlsx" ? 7 : 1;
      }
      if (kind === "published-match") {
        const product = await page.evaluate(async () => (await import("/saved-products.js")).savedProducts[0]);
        await page.locator("#input-basis").selectOption("dose");
        const rows = product.report.formula_rows;
        await page.locator("#dose-volume").fill(rows[0].submitted_quantity);
        await page.locator("#formula-text").fill("Item\tQuantity\tUnit\n" + rows.slice(1).map(row => `${row.item}\t${row.submitted_quantity}\t${row.submitted_unit}`).join("\n"));
      }
      const before = calculations.length;
      await page.locator("#prepare-button").click();
      await page.waitForFunction(() => !document.querySelector("#prepare-button").disabled);
      assert.equal(await page.locator("#formula-review").isVisible(), true, `${kind}: review required`);
      assert.equal(await page.locator("#results").isVisible(), false, `${kind}: no premature result`);
      assert.equal(calculations.length, before, `${kind}: no pre-confirm request`);
      if (kind === "damaged" || kind === "wrapped") {
        assert.equal(await page.locator("#draft-body tr").count(), 2, "No fabricated batch or guessed ingredient");
        assert.equal(await page.locator("#unparsed-source-details").isVisible(), true);
        assert.match(await page.locator("#unparsed-source-text").textContent(), /line 3\nSalt/);
        if (kind === "damaged") assert.match(await page.locator("#unparsed-source-text").textContent(), /Salt 1O g/);
        else assert.match(await page.locator("#unparsed-source-text").textContent(), /line 4\n10 g/);
        await page.locator("#formula-review").screenshot({ path: fileURLToPath(new URL(`${kind}-${width}.png`, output)) });
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
        await page.locator("#add-draft-row").click();
        await page.getByRole("textbox", { name: "Item row 3", exact: true }).fill("Salt");
        await page.getByRole("textbox", { name: "Quantity row 3", exact: true }).fill("10");
        await page.getByRole("combobox", { name: "Unit row 3", exact: true }).selectOption("g");
      } else assert.equal(await page.locator("#unparsed-source-details").isVisible(), false);
      if (kind !== "published-match") {
        await page.getByRole("textbox", { name: "Quantity row 2", exact: true }).fill("400");
        if (kind === "paste") {
          await page.locator("#formula-review").screenshot({ path: fileURLToPath(new URL(`review-${width}.png`, output)) });
          const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
          assert.equal(overflow, false);
          const unitWidth = await page.locator('#draft-body select').first().evaluate(element => element.getBoundingClientRect().width);
          assert.ok(unitWidth >= 72, "Unit selection must remain legible");
        }
      }
      await page.locator("#calculate-button").click();
      await page.waitForFunction(() => document.querySelector("#review-status").textContent.includes("Synthetic calculation"));
      assert.equal(calculations.length, before + 1);
      const payload = calculations.at(-1);
      assert.equal(payload.input_provenance.version, 1);
      if (kind === "damaged" || kind === "wrapped") {
        assert.match(payload.contents, /Salt\t10\tg/);
        assert.equal(payload.input_provenance.rows[2], null, "Manual correction does not invent source provenance");
      }
      if (kind !== "published-match") {
        assert.match(payload.contents, /Sugar\t400\tkg/);
        const source = payload.input_provenance.rows[1];
        assert.equal(source.original.quantity, "500");
        assert.equal(source.line, expectedLine);
        if (kind === "json") {
          assert.equal(source.json_path, "ingredients[0]");
          assert.ok(!JSON.stringify(payload).includes("PRIVATE-UNUSED"));
        }
        if (kind === "pdf") assert.equal(source.page, 2);
        if (kind === "pdf-blank") assert.equal(source.page, 3);
        if (kind === "xlsx") assert.equal(source.worksheet, 1);
      }
      evidence.push({ width, kind, reviewRequired: true, requestsBeforeConfirmation: 0, requestsAfterConfirmation: 1 });
    }
    const publishedId = await page.evaluate(async () => (await import("/saved-products.js")).savedProducts[0].id);
    const beforePublished = calculations.length;
    await page.goto(`${origin}/?product=${encodeURIComponent(publishedId)}`);
    assert.equal(await page.locator("#results").isVisible(), true);
    assert.equal(await page.locator("#formula-review").isVisible(), false);
    await page.locator("#calculation-details > summary").click();
    const disclosure = page.getByText("Online saves are public, including source rows.", { exact: false });
    assert.equal(await disclosure.isVisible(), true);
    await page.locator(".result-actions").evaluate(element => element.scrollIntoView());
    await page.screenshot({ path: fileURLToPath(new URL(`save-disclosure-${width}.png`, output)) });
    assert.equal(calculations.length, beforePublished);
    evidence.push({ width, kind: "explicit-published-product", available: true });
    for (const [name, mimeType, size, message] of [["unsupported.gif", "image/gif", 3, "not supported"], ["oversized.txt", "text/plain", 12 * 1024 * 1024 + 1, "12 MB"]]) {
      await page.goto(origin);
      const before = calculations.length;
      await page.locator("#formula-file").setInputFiles({ name, mimeType, buffer: Buffer.alloc(size, 65) });
      if (size < 100) await page.locator("#prepare-button").click();
      await page.waitForFunction(message => document.querySelector("#status").textContent.includes(message), message);
      assert.equal(calculations.length, before);
      evidence.push({ width, kind: name, rejected: true });
    }
    assert.deepEqual(errors, []);
    await context.close();
  }
} finally {
  await browser.close();
  await writeFile(new URL("results.json", output), JSON.stringify(evidence, null, 2) + "\n");
}
console.log(`Passed ${evidence.length} extraction scenarios; ${output.pathname}`);
