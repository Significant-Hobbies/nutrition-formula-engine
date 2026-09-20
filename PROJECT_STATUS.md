# Formula Composition Engine — Project Status

Last updated: 2026-09-21

## Purpose

Calculate either a traceable theoretical macro- and micronutrient profile or a
medicinal chemical-composition ledger from a batch formula and exact ingredient
specifications. The first release is public but request-scoped and does not
perform FSSAI classification, label formatting, or regulatory approval.

## Current scope

- Unit-safe batch quantities using exact decimal arithmetic
- Mass and volume formulas with explicit density conversion
- Recursive compound ingredients and premixes
- Per-batch, per-100 g, per-100 mL, and per-serving nutrient totals
- Nutrient retention factors and final manufacturing yield
- Per-nutrient source provenance and missing-data coverage
- Free-text ingredient matching with aliases, confidence, alternatives, and a correction path
- Pasted text and TSV, CSV, TXT, JSON, XLSX, image, and PDF inputs
- Browser-local PDF extraction, image OCR, and spreadsheet parsing
- Mandatory editable row review before any extracted formula is calculated
- Local Cloudflare Worker-compatible API and responsive Static Assets interface
- Browser review to confirm, replace, remove, or add ingredients with immediate recalculation
- Per-result contribution ledgers that exactly reconcile displayed totals to
  formula lines, profile values, material paths, retention, and sources
- Calculation receipts with engine version and catalog fingerprints
- Immutable session report versions with component deltas and restore-as-new-version
- Explicit browser IndexedDB save/resume fallback with the latest ten versions
- D1 schema and authenticated Worker repository endpoints, verified through a
  local D1-compatible SQLite harness but not bound to a deployed database
- Local catalog candidate search across food and chemical profiles
- Downloadable Markdown composition report and structured JSON
- Downloadable privacy-safe browser audit log with timings, actions, counts,
  request IDs, and input/result fingerprints
- Structured Cloudflare Logs and Traces correlated by `X-Request-ID`, without
  raw formula or OCR contents
- JSON and Markdown CLI output
- Chemical identities, formulas, counterions, active moieties, and excipients
- Present-components macro/micronutrient report backed by a complete 30-field calculation
- Separate coverage, evidence-confidence, and bounded-range reporting
- Named missing-information requests instead of user-facing coverage percentages
- Decimal propagation of ingredient quantity, assay, and final-yield ranges
- Fifteen public-formula checks against WHO and DailyMed published compositions,
  including F-75/F-100 macros, a six-ion solution, sodium bicarbonate, and five
  marketed-medicine salt-to-active-moiety comparisons
- Three 1,000 L manufacturing-style reference formulations and regression tests
- A frozen 35-case benchmark: 10 extraction, 10 identity, and 15 calculation cases
- 51 Python engine/API tests and 28 browser/data tests

## Public release

- Canonical URL: <https://formula.significanthobbies.com>
- Cloudflare Worker version: `08bcbd54-f960-4eb2-8a4d-508603205418`
- Traffic: 100% on the version above, verified 2026-09-21
- Source state: deployed from the current uncommitted, untagged local tree;
  commit and push were not performed
- Validation-suite state: the four additional external formulas are verified
  locally and are not part of the deployed Worker version above
- Current next-level workspace changes are local only and are not part of the
  deployed Worker version above

## Not yet configured or implemented

- A provisioned and migrated Cloudflare D1 database with a `FORMULA_DB` binding
- Live PubChem and FoodData Central candidate adapters and accepted-profile cache
- Line-level reject/search decision persistence against the server repository
- Additional OCR languages, handwriting support, and proprietary document formats
- A commit-tagged reproducible deployment

## Boundaries

- Results are theoretical calculations from supplied data, not laboratory assays.
- Reference-database values cannot represent supplier- or lot-specific variation.
- Unknown nutrient values remain unknown and are never silently treated as zero.
- Whole substances and their contained moieties overlap and must not be summed.
- Trade names, salt/hydrate forms, assay, purity, and final density require source documents.
