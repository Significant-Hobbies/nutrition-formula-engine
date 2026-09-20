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
- D1-backed formula history and reusable ingredient profiles that reconnect on
  another device with a high-entropy recovery key
- Immutable, source-retaining D1 ingredient-profile versions with
  confirm-before-save and explicit deactivate controls
- Owner-scoped D1 schema and Worker repository endpoints, verified through a
  local D1-compatible SQLite harness and local Worker integration tests
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
- Twenty-six public-formula checks against WHO, USDA MyPlate, and DailyMed
  published compositions, including F-75/F-100 macros, a food recipe, a six-ion
  solution, sodium bicarbonate, and fifteen
  marketed-medicine salt-to-active-moiety comparisons
- Three 1,000 L manufacturing-style reference formulations and regression tests
- A frozen 66-case benchmark: 20 extraction, 20 identity, and 26 calculation cases
- 83 Python engine/API tests and 32 browser/data tests, plus 220 deterministic
  generated arithmetic trials and 48 parser-alias combinations

## Public release

- Canonical URL: <https://formula.significanthobbies.com>
- Traffic: 100% on the current release, verified 2026-09-21
- Source state: committed and pushed to `origin/main`; the active Worker version
  receives 100% of traffic and is tagged with the same full Git SHA
- Validation-suite state: the release contains the frozen 66-case benchmark
  and 115 automated tests
- Production smoke state: root and health routes, valid sample calculation,
  malformed JSON, local candidate search, browser calculation, D1 save, reload,
  resume, recovery-key import, owner isolation, and reusable-ingredient flow
  were verified against the public domain
- Persistence state: `FORMULA_DB` is migrated and bound; formulas and accepted
  profiles are scoped by a recovery-key-derived opaque owner ID

## Not yet configured or implemented

- Live PubChem and FoodData Central candidate adapters and accepted-profile cache
- Line-level reject/search decision persistence against the server repository
- Additional OCR languages, handwriting support, and proprietary document formats

## Boundaries

- Results are theoretical calculations from supplied data, not laboratory assays.
- Reference-database values cannot represent supplier- or lot-specific variation.
- Unknown nutrient values remain unknown and are never silently treated as zero.
- Whole substances and their contained moieties overlap and must not be summed.
- Trade names, salt/hydrate forms, assay, purity, and final density require source documents.
