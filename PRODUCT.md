# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Food, nutraceutical, supplement, and medicinal-product formulation teams that
receive batch formulas as tables and need a reviewable composition result before
label and regulatory work begins.

## Product Purpose

Turn one submitted manufacturing formula into a traceable list of macro- and
micronutrients, active moieties, preservatives, and unresolved ingredients,
with units normalized and assumptions made visible for correction.

## Positioning

The product separates exact arithmetic from source uncertainty: it calculates
only from identified ingredient profiles, ranks plausible identities for
ambiguous trade names, and never converts missing composition data into zero.

## Operating Context

Users start by pasting a formula or selecting a common text, spreadsheet, image,
or PDF file for a fixed batch size. Units may be mixed, trade names may be
misspelled, and the exact grade, salt, hydrate, carrier, assay, density, or final
yield may be missing. The primary workflow is recover editable rows, review
them, calculate, review identity assumptions, correct exceptions, and export a
concise report.

## Capabilities and Constraints

- Accept pasted text, TSV, CSV, TXT, JSON, XLSX, image, and PDF inputs through
  one control. Normalize every input into editable `Item`, `Quantity`, and
  `Unit` rows. The first reviewed row is `FINISHED BATCH`; every later row is an
  ingredient.
- Keep OCR, PDF extraction, and spreadsheet parsing in the browser. Never send
  an extracted draft for calculation until the user has reviewed it.
- Normalize mass and volume units and calculate batch, per-100-g, per-100-mL,
  and per-serving values when the required density or volume basis exists.
- Show nominal results, defensible ranges, evidence confidence, source
  provenance, and named missing information separately.
- Keep the primary composition table focused on non-zero results. Preserve the
  full screened nutrient set for auditability and a future regulatory view.
- Show each proposed ingredient identity and its confidence. Let the user
  confirm it, reject and replace it, remove the row, or add another ingredient;
  recalculate immediately after a formula change.
- Let the operator save a confirmed ingredient interpretation once and
  automatically reuse that alias in later formulas. Label browser-only storage
  honestly until authenticated shared persistence is configured.
- Let the user inspect how each result was calculated, including every
  contributing formula line, material path, profile value, retention factor,
  source, and normalized amount.
- Keep immutable in-session versions with numerical deltas and restore an older
  result by creating a new version. On explicit save, use server persistence
  when configured and otherwise label the browser-only IndexedDB fallback.
- Support food/nutraceutical and medicinal composition workflows, while
  keeping regulatory classification and label formatting outside the first
  calculation step.
- Theoretical calculations do not replace supplier specifications, lot CoAs,
  finished-product assays, stability studies, or regulatory review.
- Additional OCR languages, handwriting support, proprietary spreadsheet
  formats, formatting-model fallback, live external ingredient search, and a
  configured production D1 database are future capabilities.

## Evidence on Hand

- A Decimal-based formulation engine with 81 passing Python engine/API tests
  and 31 passing browser/data tests.
- Twenty-six public-product checks against WHO, USDA MyPlate, and DailyMed
  compositions.
- A frozen 66-case benchmark split across extraction, identity ranking, and
  independently published calculation targets.
- Fifteen marketed-medicine salt-to-active-moiety comparisons with 0.226% mean
  absolute percentage difference and 0.976% maximum observed difference.
- A worked 1,000 L formulation with a present-components report backed by a
  30-field calculation, ranges, confidence signals, and ranked identity candidates.

## Product Principles

- One submission first; corrections only where uncertainty is material.
- Missing is not zero.
- Candidate identities are suggestions, never silent substitutions.
- Every calculated value should be traceable to an input and source basis.
- Regulatory formatting follows product classification; it does not contaminate
  the underlying composition calculation.

## Accessibility & Inclusion

The web workflow should be keyboard-operable, use text in addition to colour
for confidence and warnings, support zoom and narrow screens, and provide
downloadable text/CSV output in addition to visual tables.
