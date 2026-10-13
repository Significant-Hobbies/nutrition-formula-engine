# Issues #20 and #21: offline implementation and qualification

Review branch starts at main `99bdf1f` and merges reviewed `7ed79e6` (merge
`b441ec7`). Both commits are ancestors. Current main's studio footer, tracker,
case-study rendering, telemetry, build checks and Python deployment tooling are
retained; reviewed label/source and saved-product work is preserved. The reviewed
remote branch is untouched. The combined PR necessarily includes that previously
unmerged work as well as these two issues.

## Provider discovery and acceptance

`GET /api/ingredients/search?provider=pubchem|fdc&q=...&refresh=true|false`
returns candidate-only results with provider ID, source URL, raw observation,
retrieval timestamp and evidence fingerprint. Outcome is `matches`, `ambiguous`,
`no_result`, `unavailable` or `malformed`. FDC's total hit count preserves ambiguity
when the returned page is truncated. A candidate never resolves an input line.

The transport makes one request per cache miss or explicit refresh, without
automatic retries. Queries are limited to 160 characters, results to eight,
response JSON to 256 KiB, and requests to five seconds. Cache is process-local,
64 entries, expires after 300 seconds, and reports `cached` with the original
retrieval time. Explicit refresh evicts existing evidence before requesting;
expired/failed/malformed requests never return stale candidates. Isolate eviction
loses the cache. No distributed cache, production credentials, or services are
added. PubChem is a public identity endpoint; FDC reports unavailable unless an
existing `FDC_API_KEY` binding is present. No binding was created or read here.

Owner acceptance posts provider/query/candidate_id/evidence_id/submitted_alias to
the existing `/api/ingredients` route. Current evidence must match; changed or
expired evidence requires a new search/confirmation. Saves use
`D1MaterialProfileRepository.save` and verify active-profile readback. Identity-only
PubChem results cannot become nutrient composition. FDC maps a conservative set
of nutrient IDs and validates units and decimal values. Missing/null/unmapped
nutrients remain absent, raw evidence is retained, and
`unlisted_nutrients_are_zero` is false. No supplier assay or purity is inferred.

## Line decisions and resume

The saved server formula UI exposes a per-row source-search/rejection panel.
A rationale is required. `GET|POST /api/formulas/{id}/versions/{version}/review`
reads/writes append-only decisions using local migration 0005. Owner/formula
access follows existing public-workspace semantics. Row identities hash formula,
immutable input fingerprint and ordinal, distinguishing identical duplicate rows.
They survive reload/retry and identical input snapshots; edited/reordered input
creates a different snapshot. Decisions are intentionally not automatically
transferred to edited rows. Resume reads only that snapshot's rows. Source report
values are stored without editing calculation inputs or accepted aliases.

States distinguish rejected candidate, no candidate, pending search, provider
failure, malformed response, ambiguity and search results. Rejection records keep
candidate identity/evidence/retrieval time/source. Request IDs are unique per
owner/formula: identical retry returns the existing record, different payload
with the same ID fails, and readback verifies the exact payload. The UI retains
the exact failed write for retry, serializes its actions and shows persistence
errors. Search/reject recording requires a saved server workspace; browser-only
workspaces retain their existing behavior. This is append-only audit history,
not a last-writer overwriting another line.

## Qualification

Committed fixtures under `tests/fixtures/providers/` are wholly synthetic and
mocked, not live responses or private datasets. Tests run actual parsers, cache,
acceptance, repositories, Worker route logic with stubbed runtime modules, and
SQLite migration/persistence. UI tests exercise failed-write retry/readback and
line isolation. Main's history test harness was updated for the reviewed
saved-products import; footer integration assertions reflect main's studio footer.

Commands (workspace cache directories avoid modifying the home directory):

- `pnpm@10.33.2 install --frozen-lockfile`
- `pnpm@10.33.2 check` (includes web tests, JS syntax checks and Vite build)
- `PYTHONPATH=src uv run --frozen python -m unittest discover -s tests -v`
- `node --test --test-isolation=none tests-web/*.test.js` for individual test counts
- `git diff --check`

Results: 110 Python tests and 63 individual web tests passed; pinned pnpm check/build
and all nine footer asset hash checks passed; `git diff --check` passed.

Exact pnpm 10.33.2 is selected for nested scripts as well. Node is 24.19.0 and uv
is 0.12.23 in this environment; CI separately uses Node 22. Existing Vite large
chunk warning and ignored Tesseract install script are reported by the tools;
assets/build checks pass.

Pending acceptance gates: live PubChem/FDC qualification (issue #20 remains
partially open), actual optional Worker runtime, browser layout qualification,
and remote migration/deployed workflow qualification. No live provider call,
paid qualification, deployment, merge, remote migration, production credential
change, or issue #22 work was performed. Offline implementation evidence does
not establish those pending gates.
