import { resolve } from "node:path";
import { readFileSync } from "node:fs";
import { defineConfig } from "vite";
import { caseStudyCounts, renderCaseStudyCards } from "./public/case-studies-render.js";

export default defineConfig({
  root: "public",
  publicDir: false,
  plugins: [{
    name: "case-study-evidence",
    transformIndexHtml: {
      order: "pre",
      handler(html, context) {
        if (context.filename !== resolve(import.meta.dirname, "public/case-studies/index.html")) return html;
        const data = JSON.parse(readFileSync(new URL("./public/case-studies.json", import.meta.url), "utf8"));
        const placeholder = '<div id="case-study-list" class="case-study-list"></div>';
        if (!html.includes(placeholder)) throw new Error("Case-study results placeholder is missing");
        const counts = caseStudyCounts(data);
        return html.replace(placeholder, `<div id="case-study-list" class="case-study-list">${renderCaseStudyCards(data)}</div>`)
          .replace(/(id="product-count">)\d+/, (_match, prefix) => prefix + counts.products)
          .replace(/(id="comparison-count">)\d+/, (_match, prefix) => prefix + counts.comparisons)
          .replace(/(id="source-count">)\d+/, (_match, prefix) => prefix + counts.sources);
      },
    },
  }],
  build: {
    outDir: "../dist",
    emptyOutDir: true,
    rollupOptions: {
      input: {
        calculator: resolve(import.meta.dirname, "public/index.html"),
        recentFormulas: resolve(import.meta.dirname, "public/recent-formulas/index.html"),
        caseStudies: resolve(import.meta.dirname, "public/case-studies/index.html"),
      },
    },
  },
});
