# Backend and correction workflow

## Decision

Use a Cloudflare Python Worker so the web service reuses the tested `Decimal`
calculation engine rather than creating a second implementation. The repository
now contains an immutable formula-version repository and D1 migration alongside
the request-scoped analysis endpoint. No D1 resource or `FORMULA_DB` binding has
been configured, so the current UI labels and uses its IndexedDB fallback.

The interface accepts pasted text, TSV, CSV, TXT, JSON, XLSX, images, and PDFs
through one input surface. Deterministic browser normalizers convert text and
structured files to three columns. PDF.js extracts embedded PDF text and renders
scanned pages; Tesseract.js performs browser-local OCR; `read-excel-file` reads
XLSX workbooks. The first reviewed row is the finished batch and every later
row is an ingredient.

```text
Item                         Quantity  Unit
FINISHED BATCH               1000      L
Ferric ammonium citrate      13.4      kg
Cyanocobalamin               0.085     g
Sugar                        500       kg
```

Tabs remain the canonical API delimiter. Regardless of the input source, the
browser displays editable `Item / Quantity / Unit` rows and requires explicit
review before sending canonical TSV to the calculation endpoint. The API stays
independent of the capture method, and the original image, PDF, or spreadsheet
does not need to leave the browser. Identity-review choices create immutable
session versions. An explicit save stores the latest ten versions in browser
IndexedDB when D1 is unavailable; the original upload is not retained. Server
durability becomes active only after a D1 database is created, migrated, and
bound.

### OCR/model decision

The default extractor is deterministic Tesseract.js rather than a generative
vision-language model. The quantized SmolVLM-256M browser components are roughly
264 MB before runtime overhead and may generate plausible but incorrect text;
TrOCR Small is lighter but expects cropped text lines rather than full tables.
For formula quantities, the safer default is document text extraction followed
by OCR and mandatory human review. A future model may help propose row structure,
but it must never silently alter quantities or bypass review.

## Audit and observability

The browser keeps audit events in memory for the current page session and lets
the operator download them as JSON. Events cover ingestion, editable-row
changes, calculation, identity decisions, ingredient additions/removals, source
links, and exports. SHA-256 fingerprints allow two inputs or results to be
compared without placing their contents in the log.

The Worker creates a request ID for every `/api/analyze` request, returns it in
`X-Request-ID`, and includes it in structured JSON logs for request start and
outcome. Workers Logs and Traces are enabled in `wrangler.jsonc`. Central logs
must not contain raw formula text, OCR output, ingredient names, uploaded file
names, Markdown reports, or JSON reports in application-generated fields.
Cloudflare may attach standard request and network metadata to its trace.
Cloudflare's native trace wall and CPU times are the server-duration source of
truth; browser audit events separately measure end-to-end ingestion and API latency.

## Source hierarchy

1. User-confirmed supplier or lot profile
2. Existing versioned local profile
3. USDA FoodData Central candidate for foods and food ingredients
4. PubChem candidate for chemical identity, formula, molecular weight, salts,
   and synonyms
5. Unresolved candidate requiring user confirmation

External search results are candidates, not formula changes. Public database
records do not override a supplier specification or lot CoA.

## Correction contract

Every unresolved or assumed formula line returns ranked candidates with source,
external identifier, match reason, and expected effect on the result.

- **Confirm** pins the chosen source record/profile version to the formula line,
  writes an identity-decision event, and recalculates immediately.
- **Reject** records that the candidate must not be proposed again for that
  formula line, then returns the next candidates without changing the formula.
- **Search** queries the local catalog first and then the appropriate public API.
  It does not change the formula until the user confirms a result.
- **Undo** restores the prior formula version and recalculates it.

Each recalculation produces a new immutable report version. The UI may show the
latest version, but the underlying decision history remains auditable.

## HTTP surface

### Current: `POST /api/analyze`

Accepts `{file_name, contents}`, parses the reviewed canonical TSV batch and ingredient lines,
resolves local matches, and returns the present-components report plus the full
screened result, assumptions, missing information, and Markdown export.

### Implemented versioned-workspace endpoints

- `POST /api/formulas` creates a formula, version 1, and a random access token.
- `GET /api/formulas/{formula_id}` returns the current immutable version.
- `GET /api/formulas/{formula_id}/versions/{version}` returns a named version.
- `POST /api/formulas/{formula_id}/versions` appends a version using an
  `expected_version` precondition.
- `POST /api/formulas/{formula_id}/restore` copies an earlier snapshot into a
  new current version.

All reads and mutations require the bearer access token. Only its SHA-256 hash
is stored. When `FORMULA_DB` is absent, these endpoints return a visible 503
`persistence_unavailable` response rather than pretending a server save worked.

### Implemented candidate-search endpoint

`GET /api/ingredients/search?q=...&kind=food|chemical|all` searches the local
food and chemical catalogs. Results include their source, profile status, and a
mandatory-confirmation flag. Results are candidates only and never mutate a
formula. Live external search is reported as unavailable in this increment.

### Planned line-level correction endpoint

#### `GET /api/ingredients/search?q=...&kind=food|chemical`

Searches the accepted local catalog first. If needed, it queries FoodData
Central for foods or PubChem for chemicals and returns normalized candidates.

#### `POST /api/formulas/{formula_id}/lines/{line_id}/decisions`

```json
{
  "action": "confirm",
  "candidate_id": "pubchem:23663626",
  "expected_formula_version": 3
}
```

Accepted actions are `confirm`, `reject`, and `undo`. A version precondition
prevents two browser tabs from silently overwriting one another. A successful
confirmation returns the new parsed formula, top-30 result, assumptions, and
the numerical changes from the previous report.

## D1 records

- `formulas`: formula identity and current version
- `formula_versions`: immutable normalized input snapshots
- `identity_decisions`: confirm, reject, and undo events with timestamps
- `material_profiles`: normalized nutrient or chemical profiles and provenance
- `reports`: immutable calculated result snapshots

`migrations/0001_formula_history.sql` defines the tables and indexes. Normalized
formula lines live inside the immutable formula-version JSON snapshot rather
than a mutable `formula_lines` table. Uploaded source files do not need durable
object storage, so R2 remains unnecessary. The migration and repository are
tested through a D1-compatible SQLite harness; production provisioning remains
an explicit deployment step.

## Public database adapters

### USDA FoodData Central

- Use `POST /fdc/v1/foods/search` for candidate search and
  `GET /fdc/v1/food/{fdcId}` for the selected record.
- Keep the API key only in a Worker secret; never send it to the browser.
- Cache normalized confirmed records in D1 with FDC ID, data type, publication
  date, nutrient IDs, units, derivation fields, and retrieval timestamp.
- Prefer Foundation Foods or SR Legacy for ingredient profiles. Branded records
  are label-derived and should not be treated as analytical supplier data.

### PubChem PUG REST

- Resolve a name to CID, then fetch molecular formula, molecular weight,
  InChIKey, synonyms, and charge.
- Keep parent compounds, salts, and hydrates as different candidates.
- Observe PubChem's five-requests-per-second limit and cache confirmed records.
- PubChem establishes chemical identity and molecular properties; it does not
  establish the actual raw-material assay or nutrient potency.

## Failure behavior

- If the search is unavailable or rate-limited, return cached/local candidates
  and mark live search unavailable. Do not guess a match.
- If no candidate is confirmed, retain the submitted trade name as unresolved
  and preserve its exact quantity in the report.
- If a selected external record lacks a usable composition profile, identify
  the material but keep affected nutrient values unknown.
- Recalculation must fail visibly if a confirmed change would violate unit,
  compound-fraction, or formula-version constraints.

## Calculation receipt and contribution contract

Every analysis response includes the engine version, SHA-256 fingerprints of
the nutrition and chemical catalogs, and the exact arithmetic mode. Every
non-zero component can expose a contribution ledger with the originating
formula line, nested material path, input range, profile value and basis,
retention, normalized result bases, and source metadata. The engine verifies
that contribution totals reconcile exactly with calculated totals before a
report is returned.
