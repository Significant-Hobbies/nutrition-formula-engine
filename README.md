# Formula Composition Engine

A local web app and calculation engine that turn a pasted formula or common
formula file into a traceable theoretical macro- and micronutrient profile or a
chemical-composition ledger for medicinal formulas.

The public app is available at <https://formula.significanthobbies.com>. The browser
accepts pasted text, TSV, CSV, TXT, JSON, XLSX, images, and PDFs.
OCR and document parsing happen locally in the browser and always produce an
editable draft for review before calculation. FSSAI rules, label formatting,
accounts, and regulatory workflow remain outside this version.

## Run the upload app locally

```bash
pnpm install
pnpm build
uv run pywrangler dev
```

Open `http://localhost:8787`, paste a formula or choose a supported file, then
review the recovered `Item`, `Quantity`, and `Unit` rows. The first reviewed row
must be `FINISHED BATCH`; every later row is an ingredient. Only the reviewed,
canonical TSV is sent to the calculation endpoint. Users can then confirm,
replace, remove, or add ingredient identities and recalculate immediately.
An identified ingredient can be saved once and reused automatically when the
same submitted name appears in later formulas. Saved formulas, immutable
versions, and reusable ingredient profiles are stored in Cloudflare D1 under a
high-entropy recovery key. Importing that key reconnects the same private
workspace on another device.
Every recalculation creates an immutable in-session report version. The history
shows component deltas and can restore an earlier result as a new version.
Use `public/sample-tonic.tsv` as the reference input. The web report shows only
non-zero components; the API retains all 30 screened fields.

Image OCR uses Tesseract.js. PDFs use embedded text when available and fall back
to OCR for scanned pages. XLSX parsing, PDF rendering, and OCR are lazy-loaded
only when the selected file needs them. The original image, PDF, or spreadsheet
does not need to leave the browser.

## Audit and privacy

The interface keeps a session-scoped audit trail of ingestion, row review,
calculation, correction, source-opening, and export events. **Download audit
log** exports timestamped JSON containing event metadata, durations, API request
IDs, counts, and SHA-256 input/result fingerprints. It excludes raw formula
text, OCR text, ingredient names, and report contents.

The log is capped at 500 events and disappears when the page session ends, so
download it before closing the tab when a run should be retained for review.

When the user explicitly selects **Save versioned workspace**, the reviewed
formula, report snapshots, and decisions are stored in D1. The browser retains
only the recovery key and active-workspace pointer. If D1 is unavailable, the
app visibly falls back to browser IndexedDB and keeps the latest ten versions.
The original image, PDF, or spreadsheet is not stored; the reviewed normalized
formula is.

The Worker emits structured start, success, client-error, and server-error logs.
Every `/api/analyze` response includes `X-Request-ID` so a browser audit event
can be matched to Cloudflare Logs and Traces. Server logs retain only operational
metadata such as status, file extension, counts, and coverage—not the submitted
formula. Cloudflare may attach its standard request/network metadata to a trace.
Cloudflare Traces provide the authoritative wall and CPU durations;
runtime clocks are intentionally unsuitable for timing CPU-only Worker work.

## What it calculates

- Total nutrients in the batch
- Nutrients per 100 g, per 100 mL, and per serving
- Recursive composition of compound ingredients and premixes
- Mixed mass units (`kg`, `g`, `mg`, `ug`)
- Mixed volume units (`L`, `mL`) when density is supplied
- Final-yield concentration and nutrient-specific retention factors
- Per-nutrient coverage and source provenance
- A per-result contribution ledger that reconciles every displayed total to
  its formula lines, material paths, profile values, retention factors, and
  source metadata
- An engine and catalog-fingerprint receipt on each calculation
- Local fuzzy ingredient search with visible, correctable assumptions
- Chemical identities, molecular formulas, counterions, bound constituents,
  elemental actives, preservatives, and excipients

All numeric inputs should be JSON strings. The engine uses Python `Decimal` and
rejects JSON floating-point values at calculation boundaries. Ingredient and
final-yield quantities may include `minimum` and `maximum`; ingredient profiles
may use the same fields for assay or composition ranges. These bounds propagate
to batch, per-100-g, and per-100-mL results.

```json
{"value": "13.5", "minimum": "13", "maximum": "14", "unit": "g"}
```

## Run the two manufacturing-style examples

```bash
PYTHONPATH=src uv run python -m nutrition_formula \
  --catalog src/nutrition_formula/data/catalog.json \
  --formula examples/formulas/electrolyte_beverage_1000l.json

PYTHONPATH=src uv run python -m nutrition_formula \
  --catalog src/nutrition_formula/data/catalog.json \
  --formula examples/formulas/chocolate_protein_beverage_1000l.json
```

Use `--format json` for machine-readable output.

Run the submitted 1,000 L medicinal-tonic scenario:

```bash
PYTHONPATH=src uv run python -m nutrition_formula \
  --catalog src/nutrition_formula/data/chemical_catalog.json \
  --formula examples/formulas/user_tonic_1000l.json
```

The chemical report intentionally includes both a weighed chemical and its
contained moieties. For example, zinc sulphate monohydrate, zinc, sulphate, and
water of crystallization are overlapping descriptions of the same input and
must not be added together.

Generate the product-specific top-30 macro/micronutrient report:

```bash
PYTHONPATH=src uv run python -m nutrition_formula \
  --product-report src/nutrition_formula/data/user_tonic_top30.json
```

The earlier mixed composition ledger remains available when medicinal
ingredients and preservatives need to appear in the same ranked table:

```bash
PYTHONPATH=src uv run python -m nutrition_formula \
  --product-report examples/product_reports/user_tonic_top20.json
```

The product-report manifest owns the selected fields and their order. A
different product can use a different manifest while sharing the same exact
calculation engine.

Each product row distinguishes three different quality signals:

- Missing profiles are reported by ingredient name and requested source
  document. The internal coverage measurement is not shown as accuracy.
- `confidence.score` is a deterministic 0–1 evidence-quality score derived
  from identity, composition, input-quantity, and final-yield evidence. It is
  not a probability or regulatory confidence interval.
- `range` is a specification or scenario envelope. If assay limits, process
  tolerances, or measurement uncertainty are absent, the range is explicitly
  `not_estimated` instead of being invented.

The current tonic report uses the JECFA green/brown assay envelope for ferric
ammonium citrate and hydrate scenarios for zinc sulphate. Production-grade
uncertainty should incorporate supplier CoA assay ranges, scale tolerances,
actual final yield, sampling uncertainty, and laboratory method uncertainty.

Search the local catalog before preparing a formula:

```bash
PYTHONPATH=src uv run python -m nutrition_formula \
  --catalog src/nutrition_formula/data/catalog.json \
  --search "WPI 90"
```

## Verify

```bash
pnpm check
pnpm build
PYTHONPATH=src uv run python -m unittest discover -s tests -v
uvx ruff check src tests
```

The public-product suite includes WHO ORS, WHO F-75 and F-100 therapeutic-milk
recipes, a USDA MyPlate smoothie, five marketed electrolyte solutions, two
dextrose strengths, and fifteen
marketed-medicine active-moiety checks. It now exercises simple and compound
foods, energy and protein, single- and multi-salt solutions, six-ion balancing,
and salt-to-active conversions. The medicine cases calculate elemental
magnesium, iron, zinc, calcium, potassium, copper, or selenium from the declared
salt and compare the prediction with the corresponding DailyMed label. The
fifteen medicine checks currently show 0.226% mean absolute percentage difference and 0.976% maximum
observed difference.
These cases verify arithmetic against independently published label values;
they are not laboratory validation, government acceptance, or proof that an
unknown supplier lot matches a reference profile. See `DATA_SOURCES.md` for
label set IDs and exact basis assumptions.

The frozen pilot benchmark contains 66 stage-specific cases: 20 extraction
cases, 20 identity-ranking cases, and the 26 public calculation cases. The
current local suite contains 83 Python engine/API tests and 32 browser/data
tests. Thresholds and fixtures are recorded in `benchmarks/manifest.json`.

## Versioned workspace status

The public Worker binds the `nutrition-formula-engine` D1 database. Formula
history and reusable ingredient profiles are scoped by an opaque SHA-256 owner
identifier derived from a browser-generated recovery key; the raw key is not
stored in D1 or application logs. The repository contract is also exercised
against a local SQLite-compatible test binding, including cross-owner isolation.
Browser IndexedDB remains an explicit availability fallback.

`GET /api/ingredients/search` currently searches the versioned local food and
chemical catalogs and returns candidates without applying them. FoodData
Central and PubChem live adapters remain unconfigured; supplier specifications
or lot CoAs remain necessary for production-grade profiles.

## Data model

The catalog defines reported-component units and reusable ingredient profiles. An
ingredient may contain either a direct nutrient profile or mass-fraction
components. Compound ingredients are recursively expanded before calculation.

A formula line may supply an exact `material_id` or ordinary text in
`ingredient`. Text is matched against names and aliases. The selected match,
confidence, alternatives, and correction instruction are included in the
result. Low-scoring unknowns stop calculation because silently substituting a
different food would make the result look more accurate than it is.

Missing and zero are different:

- A value of `0` means the source explicitly reports zero.
- An omitted value means unknown and produces partial coverage.
- `unlisted_nutrients_are_zero` is reserved for fully characterized materials
  such as purified water or a pure mineral salt. It must never be used merely
  to make a report appear complete.

## Accuracy contract

The engine is exact relative to its inputs; it does not claim that reference
food or chemical data equals a supplier's current lot. For production calculations, replace
the example profiles with approved supplier specifications or lot CoAs, provide
actual final yield/density, and apply process-specific retention factors.

The included electrolyte formulation reaches complete coverage because every
input has a fully specified validation profile. The protein beverage
intentionally leaves unavailable whey micronutrients as unknown, demonstrating
that the engine fails visibly instead of turning missing data into zero.

Reference profiles in the examples cite their USDA FoodData Central identifiers.
They are validation data, not commercial formulation advice.

The chemical example uses public identity and molecular-weight data plus
explicit scenario assumptions. It is a composition calculation, not a potency
assay, stability study, safety assessment, or regulatory approval.
