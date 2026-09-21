import { resolve } from "node:path";
import { defineConfig } from "vite";

export default defineConfig({
  root: "public",
  publicDir: false,
  build: {
    outDir: "../dist",
    emptyOutDir: true,
    rollupOptions: {
      input: {
        calculator: resolve(import.meta.dirname, "public/index.html"),
        caseStudies: resolve(import.meta.dirname, "public/case-studies/index.html"),
      },
    },
  },
});
