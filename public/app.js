import { inputProvenance, sourceLabel as inputSourceLabel, sourceMarkdown } from "./input-provenance.js";
import { lineReviewPanel } from "./line-review.js";
import { normalizeText, rowsToTsv, normalizeUnit, hasExplicitBatchSource } from "./input-normalizer.js";
import { createAuditLog, sha256 } from "./audit-log.js";
import { buildNutritionLabel, identityReviewKey, multiplyDivideDecimal, pendingIdentityRows } from "./nutrition-label.js";
import { buildResultReadiness, componentEvidence, readinessMarkdown, senderChecklist } from "./result-readiness.js";
import { buildAssumptionScenario, scenarioEligibility, scenarioAssumptions } from "./assumption-scenario.js";
import { LABEL_DETAIL_FIELDS } from "./label-details.js";
import { savedProduct, bestEstimateAliases } from "./saved-products.js";
import { buildInputOnlyResult, defaultIdentityRows, validateReviewedRows, validateCalculationSource } from "./draft-result.js";
import { createCalculationRequests } from "./calculation-request.js";
import { createPreparationTasks } from "./preparation-task.js";
import sampleTsvUrl from "./sample-tonic.tsv?url";
import {
  appendSessionVersion,
  contributionValue,
  restoreSessionVersion,
} from "./version-history.js";
import {
  browserIngredientRecord,
  browserWorkspaceRecord,
  deleteBrowserIngredient,
  loadBrowserIngredients,
  loadBrowserWorkspace,
  saveBrowserIngredient,
  saveBrowserWorkspace,
  serverWorkspaceRecord,
} from "./workspace-store.js";

const MAX_INPUT_BYTES = 12 * 1024 * 1024;

const fileInput = document.querySelector("#formula-file");
const formulaText = document.querySelector("#formula-text");
const dropZone = document.querySelector("#drop-zone");
const fileSummary = document.querySelector("#file-summary");
const fileName = document.querySelector("#file-name");
const fileSize = document.querySelector("#file-size");
const prepareButton = document.querySelector("#prepare-button");
const calculateButton = document.querySelector("#calculate-button");
const status = document.querySelector("#status");
const reviewStatus = document.querySelector("#review-status");
const formulaReview = document.querySelector("#formula-review");
const results = document.querySelector("#results");
const uploadPanel = document.querySelector("#upload-panel");
const auditButton = document.querySelector("#download-audit");

document.querySelector(".sample-link").href = sampleTsvUrl;

let selectedFile = null;
let latestResult = null;
let latestFileName = "formula.tsv";
let currentRows = [];
let draftRows = [];
let latestContents = "";
let sessionHistory = [];
let workspace = null;
let savedIngredients = [];
let sharedIngredientProfiles = [];
let sharedIngredientLibraryAvailable = false;
let savedLabelReview = null;
let publishedProduct = null;
let publishedReviewSignature = null;
let currentInputBasis = "dose";
const confirmedIdentities = new Set();
const auditLog = createAuditLog();
const calculationRequests = createCalculationRequests();
const preparationTasks = createPreparationTasks();
let inputGeneration = 0;

function cancelCalculation() {
  inputGeneration += 1;
  preparationTasks.cancel();
  prepareButton.disabled = false;
  prepareButton.textContent = "Prepare formula for review";
  calculationRequests.cancel();
  calculateButton.disabled = false;
  calculateButton.textContent = "Confirm and calculate";
}

function labelReviewOptions() {
  return {
    inputBasis: currentInputBasis,
    productName: document.querySelector("#label-product-name").value,
    servingSize: document.querySelector("#label-serving-size").value,
    servingsPerPack: document.querySelector("#label-servings-per-pack").value,
    amountBasis: document.querySelector("#label-amount-basis").value,
    waterBase: document.querySelector("#label-base").value === "water",
    assumptionEstimate: document.querySelector("#label-assumption-estimate").checked,
    productDetails: Object.fromEntries(Object.keys(LABEL_DETAIL_FIELDS).map((key) => [key, document.querySelector(`#label-detail-${key}`).value])),
    confirmedIdentities,
  };
}

function displayedResult() {
  return buildAssumptionScenario(latestResult, labelReviewOptions());
}

function updateScenarioControl() {
  const eligibility = scenarioEligibility(latestResult, labelReviewOptions());
  const input = document.querySelector("#label-assumption-estimate");
  input.disabled = !eligibility.allowed;
  document.querySelector("#assumption-estimate-status").textContent = input.checked && eligibility.allowed
    ? "Working estimate selected. Results, label and downloads use these assumptions. Supplier requests remain open."
    : eligibility.reason;
  renderList("#assumption-estimate-terms", scenarioAssumptions(latestResult), "");
  document.querySelector("#assumption-estimate-terms").hidden = !eligibility.allowed;
}

function reviewSignature(result) {
  return JSON.stringify([result.basis_label, result.label_batch_quantity,
    result.calculation?.nutrition_catalog_fingerprint, result.formula_rows.map(identityReviewKey)]);
}

function labelReviewSnapshot() {
  if (!latestResult) return null;
  return { signature: reviewSignature(latestResult), ...labelReviewOptions(), confirmedIdentities: [...confirmedIdentities] };
}

function restoreLabelReview(result) {
  const review = savedLabelReview;
  savedLabelReview = null;
  if (!review || review.signature !== reviewSignature(result)) return;
  currentInputBasis = review.inputBasis || result.input_basis || "batch";
  document.querySelector("#input-basis").value = currentInputBasis;
  updateInputBasis();
  const validKeys = new Set(result.formula_rows.filter((row) => !row.unresolved).map(identityReviewKey));
  confirmedIdentities.clear();
  for (const key of review.confirmedIdentities || []) if (validKeys.has(key)) confirmedIdentities.add(key);
  for (const [selector, value] of [["#label-product-name", review.productName], ["#label-serving-size", review.servingSize],
    ["#label-servings-per-pack", review.servingsPerPack], ["#label-amount-basis", review.amountBasis]]) {
    if (typeof value === "string") document.querySelector(selector).value = value;
  }
  document.querySelector("#label-base").value = review.waterBase && result.basis_label === "per 100 mL" ? "water" : "unspecified";
  document.querySelector("#label-assumption-estimate").checked = review.assumptionEstimate === true;
  for (const key of Object.keys(LABEL_DETAIL_FIELDS)) {
    document.querySelector(`#label-detail-${key}`).value = typeof review.productDetails?.[key] === "string" ? review.productDetails[key] : "";
  }
}

function persistLabelReview() {
  if (!workspace || !latestResult) return;
  persistBrowserWorkspace().catch(() => updateStatus(document.querySelector("#label-status"),
    "The label is updated, but its review settings could not be saved in this browser. Download JSON to retain them.", true));
}

function renderReadiness() {
  if (!latestResult) return;
  const active = displayedResult();
  const readiness = buildResultReadiness(active, labelReviewOptions());
  document.querySelector("#result-state").textContent = active.input_only ? "Input-only draft · nutrition not calculated" : readiness.scenario ? "Calculation finished · assumption estimate" : readiness.partial ? "Calculation finished · partial result" : "Calculation finished · draft result";
  document.querySelector("#inference-name").textContent = readiness.title;
  document.querySelector("#inference-reason").textContent = readiness.summary;
  document.querySelector("#inference-boundary").textContent = readiness.nextAction;
  document.querySelector("#inference-confidence").textContent = `${readiness.requests.length} information requests · ${readiness.pendingIdentityCount} identities to review`;
  document.querySelector("#component-legend").textContent = readiness.scenario || active.input_only ? readiness.legend
    : `${readiness.legend} Only nonzero known contributions appear in this table; omitted values are not confirmed zeros.`;
  renderList("#assumptions-list", active.report_assumptions, "No extra assumptions were used.");
  renderList("#missing-list", readiness.requests, "No additional information requests.");
  return readiness;
}

async function persistBrowserWorkspace() {
  if (latestResult?.input_only) return;
  if (workspace?.mode === "server") {
    await saveBrowserWorkspace({ ...serverWorkspaceRecord({
      formulaId: workspace.formulaId,
      currentVersion: workspace.currentVersion,
    }), label_review: labelReviewSnapshot() });
    return;
  }
  if (workspace?.mode !== "browser") return;
  await saveBrowserWorkspace({ ...browserWorkspaceRecord({
    history: sessionHistory,
    latestContents,
    latestFileName,
    formulaId: workspace.formulaId,
  }), label_review: labelReviewSnapshot() });
  workspace.currentVersion = sessionHistory.at(-1)?.version || workspace.currentVersion;
}

function durationSince(startedAt) {
  return Math.round((performance.now() - startedAt) * 100) / 100;
}

function recordAudit(type, details = {}) {
  const event = auditLog.record(type, details);
  auditButton.textContent = `Download activity log (${event.sequence})`;
  return event;
}

function downloadBlob(blob, fileName) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  link.click();
  URL.revokeObjectURL(url);
}

recordAudit("session_started", {
  page_path: window.location.pathname,
  sample_mode: new URLSearchParams(window.location.search).get("sample") === "1",
});

function updateStatus(element, message, isError = false) {
  element.textContent = message;
  element.classList.toggle("is-error", isError);
}

function setStatus(message, isError = false) {
  updateStatus(status, message, isError);
}

function setReviewStatus(message, isError = false) {
  updateStatus(reviewStatus, message, isError);
}

function aliasKey(value) {
  return String(value || "").toLocaleLowerCase("en").replace(/[^a-z0-9]+/g, " ").trim();
}

function ingredientIsSaved(row) {
  const key = aliasKey(row.item);
  return savedIngredients.some((item) => item.alias_key === key && item.material_id === row.material_id)
    || sharedIngredientProfiles.some((profile) => profile.id === row.material_id
      && [profile.name, ...(profile.aliases || [])].some((alias) => aliasKey(alias) === key));
}

function acceptedAliasPayload() {
  const acceptedRows = currentRows.slice(1).filter((row) => row.material_id && !row.unresolved &&
    confirmedIdentities.has(identityReviewKey(row)));
  return [...new Map([
    ...savedIngredients.map((item) => ({ alias: item.alias, material_id: item.material_id })),
    ...acceptedRows.map((row) => ({ alias: row.item, material_id: row.material_id })),
  ].map((item) => [aliasKey(item.alias), item])).values()];
}

function setIngredientLibraryStatus(message, isError = false) {
  updateStatus(document.querySelector("#ingredient-library-status"), message, isError);
}

function renderIngredientLibrary() {
  const list = document.querySelector("#ingredient-library-list");
  const entries = [
    ...sharedIngredientProfiles.map((profile) => ({
      storage: "shared",
      key: `${profile.id}:${profile.version}`,
      material_id: profile.id,
      version: profile.version,
      name: profile.name,
      detail: `${profile.aliases.length} names · online version ${profile.version}`,
    })),
    ...savedIngredients.map((profile) => ({
      storage: "browser",
      key: profile.alias_key,
      material_id: profile.material_id,
      name: profile.alias,
      detail: `${profile.canonical_name} · saved in this browser`,
    })),
  ];
  document.querySelector("#ingredient-library-count").textContent = `${entries.length} saved`;
  list.replaceChildren();
  for (const entry of entries) {
    const item = document.createElement("div");
    item.className = "ingredient-library-item";
    const name = document.createElement("strong");
    name.textContent = entry.name;
    const detail = document.createElement("span");
    detail.textContent = entry.detail;
    const remove = reviewButton("Remove", async () => {
      if (entry.storage === "shared") {
        const response = await fetch(`/api/ingredients/${encodeURIComponent(entry.material_id)}/${encodeURIComponent(entry.version)}`, {
          method: "DELETE",
        });
        const payload = await response.json();
        if (!response.ok) {
          setIngredientLibraryStatus(payload.error || "The saved ingredient could not be removed.", true);
          return;
        }
      } else {
        await deleteBrowserIngredient(entry.key);
      }
      await refreshIngredientLibrary();
      if (latestResult) renderFormula(currentRows);
      recordAudit("ingredient_profile_deactivated", { storage: entry.storage });
    });
    remove.setAttribute("aria-label", `Remove ${entry.name} from saved ingredients`);
    item.append(name, detail, remove);
    list.append(item);
  }
}

async function refreshIngredientLibrary() {
  try {
    savedIngredients = await loadBrowserIngredients();
  } catch {
    savedIngredients = [];
  }
  try {
    const response = await fetch("/api/ingredients");
    if (response.ok) {
      const payload = await response.json();
      sharedIngredientProfiles = payload.profiles || [];
      sharedIngredientLibraryAvailable = true;
    } else {
      sharedIngredientProfiles = [];
      sharedIngredientLibraryAvailable = false;
    }
  } catch {
    sharedIngredientProfiles = [];
    sharedIngredientLibraryAvailable = false;
  }
  renderIngredientLibrary();
}

async function saveIngredientForReuse(row) {
  if (!row.material_id || !row.reusable_profile) {
    setIngredientLibraryStatus("This ingredient does not have saved details yet.", true);
    return;
  }
  if (sharedIngredientLibraryAvailable) {
    const response = await fetch("/api/ingredients", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        material_id: row.material_id,
        submitted_alias: row.item,
        kind: "food",
      }),
    });
    const payload = await response.json();
    if (response.ok) {
      await refreshIngredientLibrary();
      renderFormula(currentRows);
      setIngredientLibraryStatus(`${row.item} is saved for future formulas.`);
      recordAudit("ingredient_profile_saved", { storage: "shared" });
      return;
    }
    if (response.status !== 503) {
      setIngredientLibraryStatus(payload.error || "The ingredient could not be saved.", true);
      return;
    }
  }
  const record = browserIngredientRecord(row);
  await saveBrowserIngredient(record);
  await refreshIngredientLibrary();
  renderFormula(currentRows);
  document.querySelector("#ingredient-library").open = true;
  setIngredientLibraryStatus(
    `${row.item} is saved for every formula in this browser. Online save is not available right now.`,
  );
  recordAudit("ingredient_profile_saved", { storage: "browser" });
}

async function migrateBrowserIngredients() {
  if (!sharedIngredientLibraryAvailable || savedIngredients.length === 0) return;
  for (const ingredient of [...savedIngredients]) {
    const response = await fetch("/api/ingredients", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        material_id: ingredient.material_id,
        submitted_alias: ingredient.alias,
        kind: "food",
      }),
    });
    if (!response.ok) continue;
    await deleteBrowserIngredient(ingredient.alias_key);
  }
}

async function refreshDatabaseSync() {
  try {
    const response = await fetch("/api/formulas");
    if (!response.ok) throw new Error("D1 unavailable");
    sharedIngredientLibraryAvailable = true;
    await migrateBrowserIngredients();
    await refreshIngredientLibrary();
  } catch {
    sharedIngredientLibraryAvailable = false;
  }
}

async function loadRemoteWorkspace(formulaId, generation = inputGeneration) {
  const savedReview = await loadBrowserWorkspace().catch(() => null);
  const historyResponse = await fetch(`/api/formulas/${encodeURIComponent(formulaId)}`);
  const historyPayload = await historyResponse.json();
  if (!historyResponse.ok) throw new Error(historyPayload.error || "The saved work could not be opened.");
  const metadata = new Map(historyPayload.versions.map((item) => [item.version, item]));
  const versions = await Promise.all(historyPayload.versions.map(async (item) => {
    const response = await fetch(`/api/formulas/${encodeURIComponent(formulaId)}/versions/${item.version}`);
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || "A saved version could not be opened.");
    return payload;
  }));
  if (generation !== inputGeneration) return;
  if (savedReview?.formula_id === formulaId) savedLabelReview = savedReview.label_review;
  versions.sort((left, right) => left.version - right.version);
  sessionHistory = versions.map((version) => ({
    version: version.version,
    server_version: version.version,
    created_at: version.created_at,
    cause: version.cause,
    delta: metadata.get(version.version)?.delta || [],
    report: version.report,
  }));
  const latest = versions.at(-1);
  latestContents = latest.normalized_input.contents;
  latestFileName = latest.normalized_input.file_name;
  workspace = {
    mode: "server",
    formulaId,
    currentVersion: historyPayload.current_version,
  };
  formulaReview.hidden = true;
  currentInputBasis = latest.report.input_basis || "batch";
  renderResult(latest.report);
  if (!document.querySelector("#label-serving-size").value) applyBestLabelDefaults();
  await persistBrowserWorkspace();
  recordAudit("workspace_resumed", { storage: "database", version: workspace.currentVersion });
}

async function loadSavedBrowserFormula(generation = inputGeneration) {
  const saved = await loadBrowserWorkspace();
  if (generation !== inputGeneration) return;
  if (!saved) throw new Error("No formula is saved in this browser.");
  if (saved.storage === "server") {
    await loadRemoteWorkspace(saved.formula_id, generation);
    return;
  }
  if (!saved.history?.length) throw new Error("The saved formula has no calculated result.");
  sessionHistory = saved.history;
  latestContents = saved.latest_contents;
  latestFileName = saved.latest_file_name;
  workspace = {
    mode: "browser",
    formulaId: saved.formula_id,
    currentVersion: saved.history.at(-1).version,
  };
  currentInputBasis = saved.label_review?.inputBasis || saved.history.at(-1).report.input_basis || "batch";
  savedLabelReview = saved.label_review;
  formulaReview.hidden = true;
  renderResult(saved.history.at(-1).report);
  if (!document.querySelector("#label-serving-size").value) applyBestLabelDefaults();
  recordAudit("workspace_resumed", {
    storage: "browser",
    version: workspace.currentVersion,
  });
}

function selectFile(file) {
  if (!file) return;
  cancelCalculation();
  if (file.size > MAX_INPUT_BYTES) {
    selectedFile = null;
    fileSummary.hidden = true;
    setStatus("The input must be 12 MB or smaller.", true);
    recordAudit("input_rejected", { reason: "size_limit", bytes: file.size });
    return;
  }
  selectedFile = file;
  formulaText.value = "";
  fileName.textContent = file.name;
  fileSize.textContent = `${Math.max(1, Math.round(file.size / 1024))} KB · Processed in this browser`;
  fileSummary.hidden = false;
  setStatus("");
  recordAudit("input_selected", {
    input_kind: "file",
    extension: file.name.split(".").pop()?.toLowerCase() || "unknown",
    mime_type: file.type || "unknown",
    bytes: file.size,
  });
}

fileInput.addEventListener("change", () => selectFile(fileInput.files[0]));
formulaText.addEventListener("input", () => {
  cancelCalculation();
  if (!formulaText.value.trim()) return;
  selectedFile = null;
  fileInput.value = "";
  fileSummary.hidden = true;
  setStatus("");
});

for (const eventName of ["dragenter", "dragover"]) {
  dropZone.addEventListener(eventName, (event) => {
    event.preventDefault();
    dropZone.classList.add("is-dragging");
  });
}

for (const eventName of ["dragleave", "drop"]) {
  dropZone.addEventListener(eventName, (event) => {
    event.preventDefault();
    dropZone.classList.remove("is-dragging");
  });
}

dropZone.addEventListener("drop", (event) => selectFile(event.dataTransfer.files[0]));

function cell(label, value) {
  const element = document.createElement("td");
  element.dataset.label = label;
  element.textContent = value;
  return element;
}

function confidenceBadge(confidence) {
  const badge = document.createElement("span");
  badge.className = `confidence-label ${confidence === "low" ? "low" : ""}`;
  badge.textContent = confidence;
  return badge;
}

function formatNumber(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return value;
  return new Intl.NumberFormat("en-IN", { maximumSignificantDigits: 7 }).format(number);
}

function draftInput(value, label, onInput, auditDetails) {
  const input = document.createElement("input");
  input.value = value;
  input.required = true;
  input.setAttribute("aria-label", label);
  input.addEventListener("input", () => { cancelCalculation(); onInput(input.value); });
  input.addEventListener("change", () => recordAudit("draft_field_edited", auditDetails));
  return input;
}

function renderDraftRows() {
  const body = document.querySelector("#draft-body");
  body.replaceChildren();
  draftRows.forEach((row, index) => {
    const tr = document.createElement("tr");
    if (index === 0) tr.className = "finished-batch-row";
    const itemCell = document.createElement("td");
    itemCell.dataset.label = "Item";
    itemCell.append(draftInput(
      index === 0 && currentInputBasis === "dose" ? "DOSE BASIS" : row.item,
      `Item row ${index + 1}`,
      (value) => { row.item = value; },
      { row_index: index + 1, field: "item" },
    ));
    if (row.input_source) {
      const source = document.createElement("small");
      source.className = "input-source";
      source.textContent = inputSourceLabel(row.input_source);
      const original = document.createElement("span");
      original.textContent = `Recovered: ${["item", "quantity", "unit"].map((key) => row.input_source.original[key]).join(" · ")}`;
      source.append(original);
      itemCell.append(source);
    }
    if (index === 0 && currentInputBasis === "dose") itemCell.querySelector("input").readOnly = true;
    const quantityCell = document.createElement("td");
    quantityCell.dataset.label = "Quantity";
    const quantity = draftInput(
      row.quantity,
      `Quantity row ${index + 1}`,
      (value) => { row.quantity = value; },
      { row_index: index + 1, field: "quantity" },
    );
    quantity.inputMode = "decimal";
    quantityCell.append(quantity);
    const unitCell = document.createElement("td");
    unitCell.dataset.label = "Unit";
    const unit = document.createElement("select");
    unit.setAttribute("aria-label", `Unit row ${index + 1}`);
    for (const value of ["kg", "g", "mg", "ug", "L", "mL"]) {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = value === "ug" ? "µg" : value;
      option.selected = value === row.unit;
      unit.append(option);
    }
    unit.addEventListener("change", () => {
      cancelCalculation();
      row.unit = unit.value;
      recordAudit("draft_field_edited", { row_index: index + 1, field: "unit" });
    });
    unitCell.append(unit);
    const actionCell = document.createElement("td");
    actionCell.dataset.label = "Action";
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "row-remove";
    remove.textContent = "Remove";
    remove.setAttribute("aria-label", `Remove row ${index + 1}`);
    remove.addEventListener("click", () => {
      cancelCalculation();
      draftRows.splice(index, 1);
      recordAudit("draft_row_removed", { row_index: index + 1, remaining_rows: draftRows.length });
      renderDraftRows();
    });
    actionCell.append(remove);
    tr.append(itemCell, quantityCell, unitCell, actionCell);
    body.append(tr);
  });
}

function renderPreparedFormula(extraction) {
  draftRows = extraction.rows.map((row) => ({ ...row }));
  renderDraftRows();
  document.querySelector("#ingestion-method").textContent = extraction.method;
  const sourceDetails = document.querySelector("#source-text-details");
  document.querySelector("#recovered-source-text").textContent = extraction.rawText || "";
  sourceDetails.hidden = !extraction.rawText;
  const unparsedRows = extraction.unparsedRows || [];
  const unparsedDetails = document.querySelector("#unparsed-source-details");
  unparsedDetails.hidden = !unparsedRows.length;
  unparsedDetails.open = true;
  document.querySelector("#unparsed-source-text").textContent = unparsedRows.map(source => `${inputSourceLabel(source)}\n${source.text ?? source.cells?.join(" · ") ?? ""}`).join("\n\n");
  formulaReview.hidden = false;
  results.hidden = true;
  setReviewStatus(`${draftRows.length} rows found. Check every value before calculation.`);
  formulaReview.scrollIntoView({ behavior: "smooth", block: "start" });
  document.querySelector("#formula-review-title").focus();
}

async function prepareInput() {
  cancelCalculation();
  const startedAt = performance.now();
  const task = preparationTasks.start();
  const sourceFile = selectedFile;
  const sourceText = formulaText.value;
  const inputKind = sourceFile ? "file" : "paste";
  const inputBytes = sourceFile?.size ?? new TextEncoder().encode(sourceText).byteLength;
  currentInputBasis = document.querySelector("#input-basis").value;
  const normalization = currentInputBasis === "dose" ? { basisRow: { quantity: document.querySelector("#dose-volume").value, unit: "mL" } } : {};
  document.querySelector("#failed-source-details").hidden = true;
  document.querySelector("#failed-source-text").textContent = "";
  prepareButton.disabled = true;
  prepareButton.textContent = "Reading…";
  setStatus("Reading the formula in your browser…");
  recordAudit("ingestion_started", {
    input_kind: inputKind,
    extension: sourceFile?.name.split(".").pop()?.toLowerCase() || null,
    bytes: inputBytes,
  });
  try {
    if (inputBytes > MAX_INPUT_BYTES) throw new Error("The input must be 12 MB or smaller. Shorten the pasted formula or upload a smaller file; your input is retained.");
    const { inputHash, extraction } = await task.run(async (signal) => {
      const inputHash = await sha256(sourceFile ? await sourceFile.arrayBuffer() : sourceText).catch(() => null);
      signal.throwIfAborted();
      const extraction = sourceFile
        ? await import("./ingestion.js").then(({ ingestFile }) =>
            ingestFile(sourceFile, (message) => { if (task.isCurrent() && !signal.aborted) setStatus(message); }, { ...normalization, signal }))
        : { ...normalizeText(sourceText, "pasted text", normalization), rawText: sourceText };
      return { inputHash, extraction };
    });
    if (!task.isCurrent()) return;
    if (hasExplicitBatchSource(extraction)) currentInputBasis = "batch";
    document.querySelector("#input-basis").value = currentInputBasis;
    if (currentInputBasis === "dose" && extraction.rows[0].unit === "mL") document.querySelector("#dose-volume").value = extraction.rows[0].quantity;
    updateInputBasis();
    latestFileName = sourceFile?.name || "pasted-formula.tsv";
    renderPreparedFormula(extraction);
    recordAudit("ingestion_completed", {
      input_kind: inputKind,
      method: extraction.method,
      row_count: extraction.rows.length,
      duration_ms: durationSince(startedAt),
      input_sha256: inputHash,
    });
    setStatus("Check the recovered rows, then confirm and calculate.");
  } catch (error) {
    if (!task.isCurrent()) return;
    recordAudit("ingestion_failed", {
      input_kind: inputKind,
      error_type: error?.constructor?.name || "Error",
      duration_ms: durationSince(startedAt),
    });
    if (error.recoveredRows?.length) {
      document.querySelector("#failed-source-text").textContent = error.recoveredRows.map(source => `${inputSourceLabel(source)}\n${source.text ?? source.cells?.join(" · ") ?? ""}`).join("\n\n");
      document.querySelector("#failed-source-details").hidden = false;
      document.querySelector("#failed-source-details").open = true;
    }
    setStatus(error.message, true);
  } finally {
    if (task.isCurrent()) {
      prepareButton.disabled = false;
      prepareButton.textContent = "Prepare formula for review";
    }
  }
}

prepareButton.addEventListener("click", prepareInput);

function updateInputBasis() {
  const dose = document.querySelector("#input-basis").value === "dose";
  document.querySelector("#dose-volume-field").hidden = !dose;
  document.querySelector("#input-basis-note").textContent = dose
    ? "Enter amounts per dose. A dose-volume line is optional; this is not a production batch."
    : "Enter the finished batch quantity followed by ingredient amounts for that entire batch.";
}
document.querySelector("#input-basis").addEventListener("change", () => { cancelCalculation(); updateInputBasis(); });
document.querySelector("#dose-volume").addEventListener("input", cancelCalculation);

document.querySelector("#add-draft-row").addEventListener("click", () => {
  cancelCalculation();
  draftRows.push({ item: "", quantity: "", unit: "kg" });
  recordAudit("draft_row_added", { row_index: draftRows.length, row_count: draftRows.length });
  renderDraftRows();
  document.querySelector(`#draft-body tr:nth-child(${draftRows.length}) input`).focus();
});

document.querySelector("#edit-source").addEventListener("click", () => {
  cancelCalculation();
  recordAudit("source_edit_requested", { existing_row_count: draftRows.length });
  formulaReview.hidden = true;
  results.hidden = true;
  uploadPanel.scrollIntoView({ behavior: "smooth", block: "start" });
  formulaText.focus();
  refreshSavedWorkspaceOffer();
});

function validateDraftRows() {
  validateReviewedRows(draftRows);
}

function renderFormula(rows) {
  const body = document.querySelector("#formula-body");
  body.replaceChildren();
  for (const [index, row] of rows.entries()) {
    const tr = document.createElement("tr");
    tr.append(
      cell("Item", index === 0 && currentInputBasis === "dose" ? "DOSE BASIS" : row.item),
      cell("Given", `${row.submitted_quantity} ${row.submitted_unit}`),
      cell("Converted to", row.normalized_equivalent),
    );
    const interpretation = document.createElement("td");
    interpretation.dataset.label = "Read as";
    const name = document.createElement("div");
    name.textContent = index === 0 && currentInputBasis === "dose" ? "Amounts per dose" : row.interpretation;
    interpretation.append(name);
    if (row.input_source) {
      const source = document.createElement("small");
      source.className = "input-source";
      source.textContent = inputSourceLabel(row.input_source);
      interpretation.append(source);
    }
    if (row.confidence && row.confidence !== "exact") interpretation.append(confidenceBadge(row.confidence));
    if (index > 0 && row.material_id && row.reusable_profile) {
      const save = reviewButton("Save for reuse", () => saveIngredientForReuse(row));
      save.className = "ingredient-save-button";
      save.setAttribute("aria-label", `Save ${row.item} for reuse`);
      const confirmed = !row.needs_review || confirmedIdentities.has(identityReviewKey(row));
      if (!confirmed) {
        save.textContent = "Confirm before saving";
        save.disabled = true;
      } else if (ingredientIsSaved(row)) {
        save.textContent = "Saved for reuse";
        save.disabled = true;
      }
      interpretation.append(save);
    }
    if (index > 0 && workspace?.mode === "server") {
      interpretation.append(lineReviewPanel({formulaId: workspace.formulaId,
        version: workspace.currentVersion, ordinal: index, item: row.item}));
    }
    tr.append(interpretation);
    body.append(tr);
  }
}

function analysisRowsToTsv(rows) {
  return rowsToTsv(rows.map((row) => ({
    item: row.item,
    quantity: row.submitted_quantity,
    unit: row.submitted_unit,
  })));
}

async function reanalyzeCurrentRows(trigger = "formula_corrected", decisions = []) {
  if (currentRows.length < 2) {
    setReviewStatus("Keep at least one ingredient in the formula.", true);
    recordAudit("correction_rejected", { trigger, reason: "no_ingredients" });
    return false;
  }
  return analyzeContents(analysisRowsToTsv(currentRows), latestFileName, trigger, decisions);
}

function reviewButton(label, action) {
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = label;
  button.addEventListener("click", action);
  return button;
}

function renderIdentityReview(rows) {
  const section = document.querySelector("#identity-review");
  const list = document.querySelector("#identity-review-list");
  const uncertain = rows.map((row, index) => ({ row, index })).filter(({ row }) => row.needs_review);
  section.hidden = uncertain.length === 0;
  list.replaceChildren();
  const pending = pendingIdentityRows({ formula_rows: rows }, confirmedIdentities).length;
  document.querySelector("#review-count").textContent = `${pending} to review`;

  for (const { row, index } of uncertain) {
    const key = identityReviewKey(row);
    const card = document.createElement("div");
    card.className = "identity-review-row";
    if (confirmedIdentities.has(key)) card.classList.add("is-confirmed");
    const copy = document.createElement("div");
    copy.className = "identity-copy";
    const submitted = document.createElement("strong");
    submitted.textContent = row.item;
    const interpreted = document.createElement("span");
    interpreted.textContent = row.unresolved ? "Not identified · nutrient composition unknown"
      : `Read as ${row.interpretation} · ${row.confidence} confidence`;
    copy.append(submitted, interpreted);
    if (row.identity_note) {
      const note = document.createElement("span");
      note.textContent = row.identity_note;
      copy.append(note);
    }
    const actions = document.createElement("div");
    actions.className = "identity-actions";
    const replacement = document.createElement("div");
    replacement.className = "replacement-controls";
    replacement.hidden = true;
    if (!confirmedIdentities.has(key) || row.unresolved) {
      if (!row.unresolved) actions.append(
        reviewButton("Confirm", async () => {
          confirmedIdentities.add(key);
          recordAudit("identity_confirmed", { row_index: index + 1 });
          renderIdentityReview(currentRows);
          renderFormula(currentRows);
          renderReadiness();
          renderComponents(latestResult.present_components, latestResult.basis_label);
          renderNutritionLabel();
          persistLabelReview();
          if (workspace) {
            await reanalyzeCurrentRows("identity_confirmed", [
              { action: "confirm", line_index: index, candidate_id: row.material_id },
            ]);
          }
        }),
      );
      actions.append(
        reviewButton("Reject / replace", () => {
          replacement.hidden = !replacement.hidden;
          recordAudit("identity_alternatives_toggled", {
            row_index: index + 1,
            open: !replacement.hidden,
          });
        }),
      );
    } else {
      const confirmed = document.createElement("span");
      confirmed.className = "confidence-label";
      confirmed.textContent = "Interpretation accepted · composition still requires review";
      actions.append(confirmed, reviewButton("Review again", () => {
        confirmedIdentities.delete(key);
        renderIdentityReview(currentRows);
        renderFormula(currentRows);
        renderComponents(latestResult.present_components, latestResult.basis_label);
        renderNutritionLabel();
        persistLabelReview();
      }));
    }
    const alternatives = document.createElement("select");
    alternatives.setAttribute("aria-label", `Alternative for ${row.item}`);
    const emptyOption = document.createElement("option");
    emptyOption.value = "";
    emptyOption.textContent = row.alternatives.length ? "Choose a suggested alternative" : "No local alternatives";
    alternatives.append(emptyOption);
    for (const name of row.alternatives) {
      const option = document.createElement("option");
      option.value = name;
      option.textContent = name;
      alternatives.append(option);
    }
    const custom = document.createElement("input");
    custom.placeholder = "Or type another ingredient";
    custom.setAttribute("aria-label", `Custom replacement for ${row.item}`);
    const apply = reviewButton("Apply and recalculate", async () => {
      const replacementName = custom.value.trim() || alternatives.value;
      if (!replacementName) {
        setReviewStatus("Choose or type a replacement ingredient.", true);
        custom.focus();
        return;
      }
      confirmedIdentities.delete(key);
      const previousName = currentRows[index].item;
      currentRows[index].item = replacementName;
      const source = custom.value.trim() ? "custom" : "suggested";
      const calculated = await reanalyzeCurrentRows("identity_replaced");
      if (calculated === false) {
        currentRows[index].item = previousName;
        renderIdentityReview(currentRows);
      } else if (calculated) {
        recordAudit("identity_replacement_applied", { row_index: index + 1, source });
      }
    });
    const remove = reviewButton("Remove row", async () => {
      confirmedIdentities.delete(key);
      const [removedRow] = currentRows.splice(index, 1);
      const calculated = await reanalyzeCurrentRows("identity_row_removed");
      if (calculated === false) {
        currentRows.splice(index, 0, removedRow);
        renderIdentityReview(currentRows);
      } else if (calculated) {
        recordAudit("identity_row_removal_applied", { row_index: index + 1 });
      }
    });
    replacement.append(alternatives, custom, apply, remove);
    card.append(copy, actions, replacement);
    list.append(card);
  }
}

function sourceLabel(contribution) {
  return contribution.source?.reference || contribution.source?.kind || "Unspecified source";
}

function renderComponents(components, basisLabel) {
  const active = displayedResult();
  const options = labelReviewOptions();
  let label;
  try { label = buildNutritionLabel(active, { ...options, servingSize: options.servingSize || "100" }); } catch { label = null; }
  const useServing = options.amountBasis === "serving" && Boolean(options.servingSize) && Boolean(label);
  const amounts = new Map((label?.nutrients || []).map((nutrient) => [nutrient.id, nutrient]));
  components = active.present_components;
  document.querySelector("#basis-label").textContent = `${active.assumption_scenario?.active ? "Estimated" : "Calculated"} ${useServing ? label.servingLabel.toLowerCase() : active.basis_label}`;
  const body = document.querySelector("#components-body");
  body.replaceChildren();
  for (const component of components) {
    const valueEvidence = componentEvidence(component, active, confirmedIdentities);
    const tr = document.createElement("tr");
    const componentCell = cell("Component", component.name);
    const nonZeroContributions = (component.contributions || []).filter((item) => {
      const value = contributionValue(item, basisLabel);
      return value !== null && Number(value) !== 0;
    });
    if (nonZeroContributions.length) {
      const details = document.createElement("details");
      details.className = "contribution-details";
      const summary = document.createElement("summary");
      summary.textContent = `Show calculation · ${nonZeroContributions.length} source${nonZeroContributions.length === 1 ? "" : "s"}`;
      const list = document.createElement("ul");
      for (const contribution of nonZeroContributions) {
        const item = document.createElement("li");
        const value = useServing && contribution.total_batch != null
          ? multiplyDivideDecimal(contribution.total_batch, options.servingSize, active.label_batch_quantity, 6)
          : contributionValue(contribution, basisLabel);
        item.textContent = `${contribution.material_name}: ${formatNumber(value)} ${contribution.unit.replace("ug", "µg")} (${useServing ? label.servingLabel : active.basis_label}) · ${sourceLabel(contribution)}`;
        list.append(item);
      }
      details.append(summary, list);
      componentCell.append(details);
    }
    const amount = valueEvidence.incomplete
      ? multiplyDivideDecimal(component.value, "1", "1", 6, "down") : formatNumber(component.value);
    const shared = amounts.get(component.id);
    const sharedAmount = shared ? useServing ? shared.perServing : shared.perBasis : null;
    tr.append(
      componentCell,
      cell("Amount", `${sharedAmount || (valueEvidence.incomplete ? amount === "0" ? "Known contribution <0.000001" : `≥${amount}` : amount)} ${component.unit.replace("ug", "µg")}`),
      cell("Possible range", component.assumption ? component.range_label : useServing ? `Source bounds ${active.basis_label} in JSON` : component.range_label || "—"),
    );
    const evidence = document.createElement("td");
    evidence.dataset.label = "Value basis";
    evidence.append(confidenceBadge(valueEvidence.label));
    const note = document.createElement("span");
    note.className = "quiet";
    note.textContent = component.assumption ? " · assumed, not measured" : shared?.status === "declared"
      ? " · entered active amount" : shared?.status === "estimated" ? " · purity/conversion assumption"
      : valueEvidence.incomplete ? " · total incomplete" : " · source-based total";
    evidence.append(note);
    tr.append(evidence);
    body.append(tr);
  }
}

function causeLabel(cause) {
  return cause.replaceAll("_", " ").replace(/^./, (value) => value.toUpperCase());
}

async function restoreVersion(record) {
  try {
    if (workspace?.mode === "server" && record.server_version) {
      const response = await fetch(`/api/formulas/${workspace.formulaId}/restore`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          expected_version: workspace.currentVersion,
          target_version: record.server_version,
        }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "The saved version could not be restored.");
      workspace.currentVersion = payload.version.version;
      sessionHistory = appendSessionVersion(
        sessionHistory,
        payload.report,
        payload.version.cause,
        payload.version.version,
      );
      renderResult(payload.report);
      recordAudit("report_version_restored", { source: "saved_workspace", version: record.version });
      return;
    }
    const restored = restoreSessionVersion(sessionHistory, record.version);
    sessionHistory = restored.history;
    renderResult(restored.report);
    await persistBrowserWorkspace();
    recordAudit("report_version_restored", { source: "browser_session", version: record.version });
  } catch (error) {
    updateStatus(document.querySelector("#history-status"), error.message, true);
  }
}

function renderHistory() {
  const list = document.querySelector("#history-list");
  list.replaceChildren();
  for (const record of [...sessionHistory].reverse()) {
    const item = document.createElement("li");
    const heading = document.createElement("div");
    const title = document.createElement("strong");
    title.textContent = `Version ${record.version}`;
    const meta = document.createElement("span");
    meta.textContent = `${causeLabel(record.cause)} · ${new Date(record.created_at).toLocaleString()}`;
    heading.append(title, meta);
    const delta = document.createElement("p");
    delta.textContent = record.delta.length
      ? `${record.delta.length} calculated component${record.delta.length === 1 ? "" : "s"} changed.`
      : "No calculated component changed.";
    const restore = reviewButton("Restore as new version", () => restoreVersion(record));
    if (record.version === sessionHistory.at(-1)?.version) restore.disabled = true;
    item.append(heading, delta, restore);
    list.append(item);
  }
  document.querySelector("#history-count").textContent = `${sessionHistory.length} version${sessionHistory.length === 1 ? "" : "s"}`;
  document.querySelector("#report-version").textContent = workspace
    ? `${workspace.mode === "server" ? "Online" : "Browser"} version ${workspace.currentVersion}`
    : `Current version ${sessionHistory.at(-1)?.version || 1}`;
  document.querySelector("#history-status").textContent = workspace
    ? workspace.mode === "server"
      ? "This formula and its earlier versions are saved online."
      : "This formula and its earlier versions are saved in this browser."
    : "Save this formula to keep it and its earlier versions.";
  if (latestResult?.input_only) {
    document.querySelector("#report-version").textContent = "Input-only draft · not saved";
    document.querySelector("#history-status").textContent = "This input-only draft is available for download and print. It has not been saved as a calculated version.";
  }
}

function renderList(selector, items, fallback) {
  const list = document.querySelector(selector);
  list.replaceChildren();
  const values = items.length ? items : [fallback];
  for (const item of values) {
    const li = document.createElement("li");
    if (typeof item === "string") li.textContent = item;
    else {
      const strong = document.createElement("strong");
      strong.textContent = `${item.item}: `;
      li.append(strong, document.createTextNode(item.needed));
      if (item.affects?.length) {
        const details = document.createElement("details");
        const affected = document.createElement("summary");
        const blocksMacros = item.affects.some((name) => ["Energy", "Protein", "Carbohydrate", "Total sugars", "Added sugars", "Total fat"].includes(name));
        affected.textContent = blocksMacros ? "Needed for complete macro totals · show affected values" : "Show affected values";
        const names = document.createElement("p");
        names.textContent = item.affects.join(", ");
        details.append(affected, names);
        li.append(details);
      }
    }
    list.append(li);
  }
}

function renderNutritionLabel() {
  const download = document.querySelector("#download-saved-label");
  download.hidden = !publishedProduct?.pdfUrl || !publishedReviewSignature ||
    JSON.stringify(labelReviewSnapshot()) !== publishedReviewSignature;
  if (publishedProduct?.pdfUrl) {
    download.href = publishedProduct.pdfUrl;
    download.download = `${publishedProduct.id}-label.pdf`;
  }
  if (!latestResult) return;
  updateScenarioControl();
  const active = displayedResult();
  renderComponents(active.present_components, active.basis_label);
  const labelStatus = document.querySelector("#label-status");
  const pending = pendingIdentityRows(latestResult, confirmedIdentities);
  const preview = document.querySelector("#nutrition-label");
  const printButton = document.querySelector("#print-label");
  const readiness = renderReadiness();
  preview.hidden = false;
  printButton.disabled = false;
  try {
    if (!document.querySelector("#label-serving-size").value.trim()) throw new Error("Enter the intended serving size or dose to calculate amounts and RDA.");
    const label = buildNutritionLabel(active, {
      ...labelReviewOptions(),
      waterBase: document.querySelector("#label-base").value === "water",
    });
    preview.hidden = false;
    printButton.disabled = false;
    document.querySelector("#label-preview-status").textContent = active.input_only
      ? "Input-only draft — ingredient quantities, nutrition not calculated" : readiness.scenario
      ? "Assumption-based working estimate — supplier data needed" : readiness.partial
      ? "Partial draft — macros/nutrient totals incomplete" : "Calculated draft — source and regulatory review required";
    document.querySelector("#label-preview-name").textContent = label.productName;
    document.querySelector("#label-info-title").textContent = active.input_only
      ? "Supplied ingredient quantities" : "Nutritional Information (Approximate Values)";
    document.querySelector("#label-nutrient-heading").textContent = active.input_only ? "Ingredient" : "Nutrient";
    document.querySelector("#label-nutrition-reference").hidden = Boolean(active.input_only);
    document.querySelector("#label-preview-serving").textContent = active.input_only
      ? `${active.label_batch_quantity} ${label.servingUnit} entered ${active.input_basis === "dose" ? "dose" : "batch"}`
      : `${label.servingSize} ${label.servingUnit}`;
    const perServing = document.querySelector("#label-amount-basis").value === "serving";
    const amountHeading = perServing ? label.servingLabel : label.basisLabel;
    document.querySelector("#label-amount-heading").textContent = amountHeading;
    document.querySelector("#label-serving-unit").textContent = label.servingUnit;
    document.querySelector("#label-ingredients").textContent = label.ingredients.join(", ") || "Not established";
    document.querySelector("#label-ins-summary").textContent = label.ingredientIdentifierSummary;
    const details = label.productDetails;
    const description = document.querySelector("#label-preview-description");
    description.textContent = details.values.description;
    description.hidden = !details.values.description;
    document.querySelector("#label-preview-category").textContent = `Category: ${details.category} · Dietary status: ${details.dietary}`;
    document.querySelector("#label-detail-count").textContent = details.missing.length ? `(${details.missing.length} to complete)` : "(completed)";
    const productSections = document.querySelector("#label-product-sections");
    productSections.replaceChildren();
    for (const section of details.sections) {
      const paragraph = document.createElement("p");
      const heading = document.createElement("strong");
      heading.textContent = `${section.title}: `;
      paragraph.append(heading, section.text);
      if (section.pending) paragraph.className = "label-detail-pending";
      productSections.append(paragraph);
    }
    const declaration = document.querySelector("#label-category-declaration");
    declaration.textContent = details.categoryDeclaration;
    declaration.hidden = !details.categoryDeclaration;
    const packDetails = document.querySelector("#label-pack-details");
    packDetails.replaceChildren();
    for (const item of details.pack) {
      const row = document.createElement("div");
      const title = document.createElement("dt");
      const value = document.createElement("dd");
      title.textContent = item.title;
      value.textContent = item.text;
      if (item.pending) row.className = "label-detail-pending";
      row.append(title, value);
      packDetails.append(row);
    }
    const barcodeBox = document.querySelector("#label-barcode");
    barcodeBox.replaceChildren();
    if (details.barcode.valid) {
      const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      svg.setAttribute("viewBox", "0 0 113 85");
      svg.setAttribute("role", "img");
      svg.setAttribute("aria-label", `EAN-13 ${details.barcode.digits}`);
      const background = document.createElementNS(svg.namespaceURI, "rect");
      background.setAttribute("width", "113"); background.setAttribute("height", "85"); background.setAttribute("fill", "white");
      svg.append(background);
      for (const bar of details.barcode.bars) {
        const rect = document.createElementNS(svg.namespaceURI, "rect");
        rect.setAttribute("x", String(bar.x)); rect.setAttribute("y", "1");
        rect.setAttribute("width", "1"); rect.setAttribute("height", String(bar.height)); rect.setAttribute("fill", "black");
        svg.append(rect);
      }
      for (const [text, x] of [[details.barcode.digits[0], 4], [details.barcode.digits.slice(1, 7), 32], [details.barcode.digits.slice(7), 79]]) {
        const caption = document.createElementNS(svg.namespaceURI, "text");
        caption.textContent = text; caption.setAttribute("x", String(x)); caption.setAttribute("y", "83");
        caption.setAttribute("font-family", "monospace"); caption.setAttribute("font-size", "8"); caption.setAttribute("text-anchor", "middle");
        svg.append(caption);
      }
      barcodeBox.append(svg);
    } else {
      const note = document.createElement("p");
      note.className = "label-detail-pending";
      note.textContent = `Barcode: ${details.barcode.issue}.`;
      barcodeBox.append(note);
    }
    const additiveReview = document.querySelector("#label-additive-review");
    additiveReview.replaceChildren();
    for (const issue of label.additiveIssues) {
      const item = document.createElement("li");
      item.textContent = `${issue.ingredient}: ${issue.needed}`;
      additiveReview.append(item);
    }
    document.querySelector("#label-ins-reference").href = label.additiveReference.url;
    document.querySelector("#label-print-review").textContent = [
      readiness.scenario ? "Estimated macros assume water and pure ingredients without nutritive carriers; ≈0 is assumed, not measured. Active forms and assays require confirmation." : "Composition totals and ingredient grades require supplier confirmation.",
      pending.length ? `${pending.length} ingredient interpretations are provisional; supplier identification is required.` : "",
      label.unavailableSummary,
      label.additiveIssues.length ? `Supplier identity / permitted use to confirm: ${label.additiveIssues.map((issue) => issue.ingredient).join(", ")}. Full details are in the ingredient review.` : "",
      active.label_draft_note || (active.formula_rows.some((row) => row.material_id === "iodine_potassium_iodide_declared")
        ? "Vitamin C, B3, B2, B1, B6 and B12 are assumed declared active amounts; zinc and iodine are elemental amounts, not salt weights. B5 is the theoretical equivalent of pure D-panthenol. Sugar is assumed pure sucrose at 4 kcal/g; sodium includes the B2 sodium counterion. Confirm assays and actual ingredient weights; ingredient order is provisional."
        : active.formula_rows.some((row) => ["iron_fac_declared", "zinc_sulphate_declared"].includes(row.material_id))
        ? "Iron and zinc are treated as declared elemental amounts, not salt weights; confirm that basis, salt assay and actual salt weights. Macro estimates exclude unreported citrate energy; ingredient order is provisional." : ""),
      details.missing.length ? `Incomplete product declarations: ${details.missing.length}. Fields marked “To be confirmed” must be completed before final artwork.` : "Category-specific declarations, additive use permissions and artwork require review.",
    ].filter(Boolean).join(" ");

    const servingsRow = document.querySelector("#label-preview-servings-row");
    servingsRow.hidden = !label.servingsPerPack;
    document.querySelector("#label-preview-servings").textContent = label.servingsPerPack;

    const nutrientBody = document.querySelector("#label-nutrients");
    nutrientBody.replaceChildren();
    for (const group of label.groups) {
      const band = document.createElement("tr");
      band.className = "nutrition-label-category";
      const heading = document.createElement("th");
      heading.colSpan = 5;
      heading.scope = "rowgroup";
      heading.textContent = group.name;
      band.append(heading);
      nutrientBody.append(band);
      for (const nutrient of group.nutrients) {
        const row = document.createElement("tr");
        if (nutrient.status === "partial") row.className = "is-partial";
        const name = document.createElement("th");
        name.scope = "row";
        name.textContent = nutrient.name;
        if (nutrient.sourceLabel) {
          const source = document.createElement("span");
          source.className = "nutrition-label-source";
          source.textContent = `(${nutrient.sourceLabel})`;
          name.append(source);
        }
        const amount = document.createElement("td");
        amount.dataset.label = amountHeading;
        const value = perServing ? nutrient.perServing : nutrient.perBasis;
        amount.textContent = `${value} ${nutrient.unit}${nutrient.supplied ? " (as supplied)" : ""}`;
        row.append(name, amount);
        for (const [key, title] of [["men", "Men"], ["women", "Women"], ["children", "10–12 years"]]) {
          const rda = document.createElement("td");
          rda.dataset.label = `% RDA ${title}`;
          rda.textContent = value === "Not established" ? "—" : nutrient.rda[key];
          row.append(rda);
        }
        nutrientBody.append(row);
      }
    }

    const warnings = [];
    if (readiness.scenario) warnings.push(...active.assumption_scenario.assumptions,
      ...(latestResult.formula_rows.some((row) => row.material_id === "lysine_hcl_pure_assumed") ? ["Chloride shown is the lysine-HCl contribution only; unreported vitamin salts may add chloride. B5 percentages use adequate intake (AI)."] : []),
      "Original composition data remains unchanged. Obtain the sender specifications before finalizing declarations.");
    if (!readiness.scenario && !active.input_only && label.hasIncompleteData) {
      warnings.push("≥ is the known contribution under the selected ingredient profiles, with incomplete composition coverage; unverified purity and identities can change it.");
    }
    if (label.unavailableSummary) warnings.push(label.unavailableSummary);
    if (label.hasDeclaredActives) {
      warnings.push("Vitamin amounts use the entered active-quantity assumption.");
    }
    if (label.hasEstimatedActives) {
      warnings.push("≈ uses theoretical conversions under the selected pure-ingredient assumptions; B5 assumes pure D-panthenol. Assays are unverified.");
    }
    if (label.waterBase && !readiness.scenario) {
      warnings.push("Base assumption: water sufficient to make the finished volume; no sugar syrup added. Other ingredients may still contribute energy or macronutrients.");
    }
    else if (!label.waterBase && label.servingUnit === "mL") warnings.push("Liquid base not confirmed: request the water, syrup, sorbitol or carrier composition and finished yield.");
    if (label.hasIdentityReview) {
      warnings.push("Resolve the flagged ingredient identities before using this draft externally.");
    }
    if (label.hasDeclaredActiveAssumptions) {
      warnings.push("Vitamin quantities use the entered amounts as active nutrient amounts; confirm chemical forms, dilutions and supplier assays.");
    }
    const warning = document.querySelector("#label-data-warning");
    warning.hidden = warnings.length === 0;
    warning.textContent = warnings.join(readiness.scenario ? "\n\n" : " ");
    updateStatus(labelStatus, `${readiness.title}. ${readiness.requests.length} supplier information requests; ${details.missing.length} product declarations to complete. Print produces draft artwork.`);
    recordAudit("label_preview_updated", {
      serving_size: label.servingSize,
      serving_unit: label.servingUnit,
      nutrient_count: label.nutrients.length,
      incomplete_data: label.hasIncompleteData,
      assumption_estimate: Boolean(active.assumption_scenario?.active),
    });
    return true;
  } catch (error) {
    preview.hidden = true;
    printButton.disabled = true;
    updateStatus(labelStatus, error.message, true);
    return false;
  }
}

function renderResult(result) {
  const hadResult = Boolean(latestResult);
  latestResult = result;
  currentInputBasis = result.input_basis || currentInputBasis;
  document.querySelector("#input-basis").value = currentInputBasis;
  updateInputBasis();
  currentRows = result.formula_rows.map((row) => ({ ...row }));
  const known = formatNumber(result.coverage.characterized_percent);
  const unknown = formatNumber(result.coverage.uncharacterized_percent);
  document.querySelector("#coverage-known").textContent = known;
  document.querySelector("#coverage-bar").style.width = `${Math.min(100, Number(known))}%`;
  document.querySelector("#coverage-note").textContent = `${unknown}% of explicitly weighed input has no composition profile. A profile may cover just one nutrient; this percentage does not measure complete macros, accuracy or the unlisted liquid base.`;
  if (result.input_only) {
    document.querySelector("#coverage-known").textContent = "Not calculated";
    document.querySelector("#coverage-bar").style.width = "0%";
    document.querySelector("#coverage-note").textContent = "Input-only draft: no ingredient composition, mass coverage or nutrient totals have been calculated.";
  }
  document.querySelector("#basis-label").textContent = `Calculated ${result.basis_label}`;
  document.querySelector("#engine-version").textContent = `Calculator ${result.calculation?.engine_version || "version not shown"}`;
  document.querySelector("#report-fingerprint").textContent = result.calculation?.nutrition_catalog_fingerprint
    ? `Data set ${result.calculation.nutrition_catalog_fingerprint.slice(0, 10)}`
    : "Data set ID unavailable";
  renderHistory();
  renderList("#assumptions-list", result.report_assumptions, "No extra assumptions were used.");
  const labelUnit = result.basis_label === "per 100 mL" ? "mL" : "g";
  const labelUnitElement = document.querySelector("#label-serving-unit");
  if (labelUnitElement.textContent !== labelUnit) {
    document.querySelector("#label-serving-size").value = "";
  }
  labelUnitElement.textContent = labelUnit;
  document.querySelector("#label-base").disabled = labelUnit !== "mL";
  if (labelUnit !== "mL") document.querySelector("#label-base").value = "unspecified";
  if (!hadResult) document.querySelector("#label-product-name").value = result.product_name;
  restoreLabelReview(result);
  renderFormula(result.formula_rows);
  renderIdentityReview(currentRows);
  renderNutritionLabel();
  const saveButton = document.querySelector("#save-workspace");
  saveButton.disabled = Boolean(workspace) || Boolean(result.input_only);
  saveButton.textContent = result.input_only ? "Input-only draft · download to keep" : workspace ? workspace.mode === "browser" ? "Saved in this browser" : "Saved online" : "Save formula";
  results.hidden = false;
  results.scrollIntoView({ behavior: "smooth", block: "start" });
  document.querySelector("#results-title").focus();
}

async function analyzeContents(contents, uploadedName, trigger = "review_confirmed", decisions = []) {
  const request = calculationRequests.start();
  const startedAt = performance.now();
  let inputHash = null;
  const reviewedRows = structuredClone(trigger === "review_confirmed" ? draftRows : currentRows);
  const inputBasis = currentInputBasis;
  const acceptedRows = currentRows.filter((row) => confirmedIdentities.has(identityReviewKey(row)));
  let requestId = null;
  let responseStatus = null;
  latestFileName = uploadedName;
  latestContents = contents;
  calculateButton.disabled = true;
  calculateButton.textContent = "Calculating…";
  setReviewStatus("Checking units, ingredient names, ranges, and totals…");
  recordAudit("calculation_started", {
    trigger,
    row_count: contents.split("\n").filter(Boolean).length - 1,
    input_sha256: inputHash,
  });
  try {
    validateReviewedRows(reviewedRows);
    inputHash = await sha256(contents).catch(() => null);
    if (!request.isCurrent()) return null;
    const endpoint = workspace?.mode === "server"
      ? `/api/formulas/${workspace.formulaId}/versions`
      : "/api/analyze";
    const requestBody = {
      file_name: uploadedName.endsWith(".tsv") ? uploadedName : `${uploadedName}.tsv`,
      contents,
      accepted_aliases: acceptedAliasPayload(),
      input_basis: inputBasis,
      input_provenance: inputProvenance(reviewedRows),
    };
    if (trigger === "review_confirmed") {
      requestBody.accepted_aliases = [...new Map([...bestEstimateAliases(draftRows), ...requestBody.accepted_aliases].map((item) => [item.alias, item])).values()];
    }
    if (workspace?.mode === "server") {
      requestBody.expected_version = workspace.currentVersion;
      requestBody.cause = trigger;
      requestBody.decisions = decisions;
    }
    const response = await request.fetchJson(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(requestBody),
    });
    if (!request.isCurrent()) return null;
    responseStatus = response.status;
    requestId = response.requestId;
    const payload = response.data;
    const data = payload.report || payload;
    validateCalculationSource(data.formula_rows, reviewedRows);
    if (workspace?.mode === "server" && payload.version) {
      workspace.currentVersion = payload.version.version;
      refreshDatabaseSync().catch(() => {});
    }
    sessionHistory = appendSessionVersion(
      sessionHistory,
      data,
      trigger === "review_confirmed" && sessionHistory.length === 0 ? "created" : trigger,
      payload.version?.version || null,
    );
    // Alias acceptance can change source wording; retain the exact accepted input
    // and material through recalculation, without accepting a new interpretation.
    for (const row of data.formula_rows) {
      if (!row.unresolved && acceptedRows.some((accepted) => accepted.item === row.item &&
        accepted.material_id === row.material_id && accepted.submitted_quantity === row.submitted_quantity &&
        accepted.submitted_unit === row.submitted_unit)) confirmedIdentities.add(identityReviewKey(row));
    }
    formulaReview.hidden = true;
    renderResult(data);
    if (trigger === "review_confirmed") applyBestLabelDefaults();
    let saveWarning = "";
    try { await persistBrowserWorkspace(); }
    catch {
      if (!request.isCurrent()) return null;
      saveWarning = " The result is calculated, but could not be saved in this browser. Download JSON to keep it.";
      updateStatus(document.querySelector("#history-status"), saveWarning.trim(), true);
      document.querySelector("#save-workspace").textContent = workspace?.mode === "server"
        ? "Saved online · browser copy unavailable" : "Latest result not saved · download JSON";
    }
    if (!request.isCurrent()) return null;
    try { window.appHealth?.track('formula_checked'); } catch { /* Optional telemetry must not discard a result. */ }
    const resultForHash = { ...data };
    delete resultForHash.markdown;
    const resultHash = await sha256(JSON.stringify(resultForHash)).catch(() => null);
    if (!request.isCurrent()) return null;
    recordAudit("calculation_completed", {
      trigger,
      request_id: requestId,
      http_status: responseStatus,
      duration_ms: durationSince(startedAt),
      ingredient_count: data.formula_rows.length - 1,
      present_component_count: data.present_components.length,
      screened_component_count: data.screened_components.length,
      identity_review_count: data.formula_rows.filter((row) => row.needs_review).length,
      characterized_percent: data.coverage.characterized_percent,
      input_sha256: inputHash,
      result_sha256: resultHash,
    });
    setReviewStatus(`Calculated ${data.formula_rows.length - 1} ingredients from the reviewed rows.${saveWarning}`);
    return true;
  } catch (error) {
    if (!request.isCurrent()) return null;
    responseStatus ||= error.status || null;
    recordAudit("calculation_failed", {
      trigger,
      request_id: requestId,
      http_status: responseStatus,
      duration_ms: durationSince(startedAt),
      error_type: error?.constructor?.name || "Error",
      input_sha256: inputHash,
    });
    if (error.fallback || error.status) {
      const draft = buildInputOnlyResult(reviewedRows, { fileName: uploadedName, inputBasis, reason: error.message });
      publishedProduct = null;
      publishedReviewSignature = null;
      savedLabelReview = null;
      renderResult(draft);
      applyBestLabelDefaults();
      draftRows = reviewedRows.map((row) => ({ item: row.item,
        quantity: String(row.submitted_quantity ?? row.quantity), unit: normalizeUnit(row.submitted_unit ?? row.unit),
        ...(row.input_source ? { input_source: row.input_source } : {}) }));
      renderDraftRows();
      formulaReview.hidden = false;
      setReviewStatus(`${error.message} Print or download the input-only sheet below, or retry Confirm and calculate.`, true);
      return true;
    }
    if (!latestResult) results.hidden = true;
    setReviewStatus(error.message, true);
    return false;
  } finally {
    if (request.isCurrent()) {
      calculateButton.disabled = false;
      calculateButton.textContent = "Confirm and calculate";
    }
  }
}

document.querySelector("#save-workspace").addEventListener("click", async () => {
  if (!latestResult || latestResult.input_only || !latestContents || workspace) return;
  const button = document.querySelector("#save-workspace");
  button.disabled = true;
  button.textContent = "Saving…";
  try {
    let response;
    let payload;
    try {
      response = await fetch("/api/formulas", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          file_name: latestFileName,
          contents: latestContents,
          accepted_aliases: acceptedAliasPayload(),
          input_basis: currentInputBasis,
          input_provenance: inputProvenance(latestResult.formula_rows),
        }),
      });
      payload = await response.json();
      if (response.status >= 500) payload = { code: "persistence_unavailable" };
    } catch {
      payload = { code: "persistence_unavailable" };
    }
    if (response && !response.ok && payload.code !== "persistence_unavailable") {
      throw new Error(payload.error || "Your work could not be saved.");
    }
    if (payload.code === "persistence_unavailable") {
      workspace = {
        mode: "browser",
        formulaId: crypto.randomUUID(),
        currentVersion: sessionHistory.at(-1)?.version || 1,
      };
      await persistBrowserWorkspace();
      button.textContent = "Saved in this browser";
      renderHistory();
      recordAudit("workspace_saved", {
        storage: "browser",
        version: workspace.currentVersion,
      });
      return;
    }
    workspace = {
      mode: "server",
      formulaId: payload.version.formula_id,
      currentVersion: payload.version.version,
    };
    if (sessionHistory.length) sessionHistory.at(-1).server_version = payload.version.version;
    await persistBrowserWorkspace();
    button.textContent = "Saved";
    renderFormula(currentRows);
    renderHistory();
    await refreshDatabaseSync();
    recordAudit("workspace_saved", { version: workspace.currentVersion });
  } catch (error) {
    button.disabled = false;
    button.textContent = "Save formula";
    updateStatus(document.querySelector("#history-status"), error.message, true);
    recordAudit("workspace_save_failed", { error_type: error?.constructor?.name || "Error" });
  }
});

calculateButton.addEventListener("click", async () => {
  try {
    validateDraftRows();
    workspace = null;
    publishedProduct = null;
    publishedReviewSignature = null;
    sessionHistory = [];
    confirmedIdentities.clear();
    document.querySelector("#label-options").reset();
    document.querySelector("#calculation-details").open = false;
    await analyzeContents(rowsToTsv(draftRows), latestFileName, "review_confirmed");
  } catch (error) {
    recordAudit("review_validation_failed", { error_type: error?.constructor?.name || "Error" });
    setReviewStatus(error.message, true);
  }
});

function currentOutputSnapshot() {
  const options = labelReviewOptions();
  const active = displayedResult();
  const exportResult = structuredClone(active);
  exportResult.readiness = buildResultReadiness(active, options);
  exportResult.label_review = labelReviewSnapshot();
  try { exportResult.label = buildNutritionLabel(active, options); }
  catch { exportResult.label = null; }
  delete exportResult.markdown;
  if (active.assumption_scenario?.active) {
    exportResult.source_result = structuredClone(latestResult);
    delete exportResult.source_result.markdown;
  }
  return exportResult;
}

function currentOutputMarkdown(snapshot) {
  const label = snapshot.label;
  const basis = snapshot.label_review.amountBasis === "serving" ? "perServing" : "perBasis";
  const lines = [`# ${label?.productName || snapshot.product_name}`, "",
    readinessMarkdown(snapshot.readiness, snapshot.product_name), "", "## Output assumptions", "",
    ...(snapshot.report_assumptions || []).map((assumption) => `- ${assumption}`), ""];
  if (label) {
    lines.push(`## ${label.inputOnly ? "Input-only ingredient sheet" : "Nutrition label"} — ${basis === "perServing" ? label.servingLabel : label.basisLabel}`, "",
      label.inputOnly ? "Original ingredient quantities and units are shown as supplied. Nutrient totals and RDA have not been calculated."
        : `RDA percentages use the ${label.servingSize} ${label.servingUnit} dose. Men/women: moderate work; child reference: boys aged 10–12. B5 uses adequate intake (AI).`, "",
      `| ${label.inputOnly ? "Ingredient" : "Nutrient"} | Amount | Men | Women | Boys 10–12 |`, "|---|---:|---:|---:|---:|");
    for (const group of label.groups) {
      lines.push(`| **${group.name}** | | | | |`);
      for (const nutrient of group.nutrients) lines.push(`| ${nutrient.name}${nutrient.sourceLabel ? ` (${nutrient.sourceLabel})` : ""} | ${nutrient[basis]} ${nutrient.unit} | ${nutrient.rda.men} | ${nutrient.rda.women} | ${nutrient.rda.children} |`);
    }
    if (label.unavailableSummary) lines.push("", label.unavailableSummary);
    lines.push("", "## Ingredient statement", "", label.ingredients.join(", "), "");
    lines.push("## Ingredient INS status", "", "| Ingredient | INS status |", "|---|---|",
      ...label.ingredientDetails.map((item) => `| ${item.name} | ${item.insStatusLabel} |`), "");
    lines.push("## Product declarations", "", `Category: ${label.productDetails.category}. Dietary status: ${label.productDetails.dietary}.`, "",
      ...label.productDetails.sections.map((section) => `**${section.title}:** ${section.text}`), "",
      ...label.productDetails.pack.map((item) => `**${item.title}:** ${item.text}`), "",
      `**Barcode:** ${label.productDetails.barcode.valid ? label.productDetails.barcode.digits : label.productDetails.barcode.issue}`, "",
      label.productDetails.categoryDeclaration, label.productDetails.note, "",
      "## Additive identity review", "", ...label.additiveIssues.map((issue) => `- ${issue.ingredient}: ${issue.needed}`), "",
      `[${label.additiveReference.title}](${label.additiveReference.url})`, label.additiveReference.scope, "");
  } else lines.push("Serving details are invalid or missing; specify the dose before finalizing per-serving output.", "");
  if (snapshot.assumption_scenario?.active) lines.push("Original source results are retained separately in the JSON download. Assumed zero macros are not measured zeros.", "");
  lines.push(sourceMarkdown(snapshot.formula_rows));
  return lines.join("\n");
}

document.querySelector("#download-report").addEventListener("click", () => {
  if (!latestResult) return;
  try { window.appHealth?.track('report_downloaded'); } catch { /* Download remains available without telemetry. */ }
  recordAudit("report_downloaded", { format: "markdown" });
  const snapshot = currentOutputSnapshot();
  const blob = new Blob([currentOutputMarkdown(snapshot)], { type: "text/markdown;charset=utf-8" });
  downloadBlob(blob, `${latestResult.product_name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-report.md`);
});

document.querySelector("#download-json").addEventListener("click", () => {
  if (!latestResult) return;
  recordAudit("report_downloaded", { format: "json" });
  const exportResult = currentOutputSnapshot();
  const blob = new Blob([`${JSON.stringify(exportResult, null, 2)}\n`], { type: "application/json;charset=utf-8" });
  downloadBlob(blob, `${latestResult.product_name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}.json`);
});

document.querySelector("#download-requests").addEventListener("click", () => {
  if (!latestResult) return;
  const readiness = buildResultReadiness(displayedResult(), labelReviewOptions());
  const label = currentOutputSnapshot().label;
  const labelRequests = label ? ["", "ADDITIVE IDENTITY / SUITABILITY", ...label.additiveIssues.map((issue) => `- ${issue.ingredient}: ${issue.needed}`),
    "", "PRODUCT DECLARATIONS TO COMPLETE", ...label.productDetails.missing.map((item) => `- ${item}`), "", label.productDetails.note].join("\n") : "";
  downloadBlob(new Blob([senderChecklist(readiness, document.querySelector("#label-product-name").value || latestResult.product_name), labelRequests], { type: "text/plain;charset=utf-8" }), "sender-information-needed.txt");
  recordAudit("sender_checklist_downloaded", { request_count: readiness.requests.length });
});

document.querySelector("#label-options").addEventListener("submit", (event) => {
  event.preventDefault();
  renderNutritionLabel();
  persistLabelReview();
});

for (const selector of ["#label-amount-basis", "#label-base", "#label-assumption-estimate"]) {
  document.querySelector(selector).addEventListener("change", () => { renderNutritionLabel(); persistLabelReview(); });
}
for (const id of ["#label-serving-size", "#label-servings-per-pack", "#label-product-name"]) {
  document.querySelector(id).addEventListener("input", () => { renderNutritionLabel(); persistLabelReview(); });
}
for (const key of Object.keys(LABEL_DETAIL_FIELDS)) {
  const input = document.querySelector(`#label-detail-${key}`);
  input.addEventListener(input.tagName === "SELECT" ? "change" : "input", () => { renderNutritionLabel(); persistLabelReview(); });
}

document.querySelector("#print-label").addEventListener("click", () => {
  if (!latestResult) return;
  if (!renderNutritionLabel()) return;
  const savedPdf = document.querySelector("#download-saved-label");
  if (savedPdf.hasAttribute("href") && publishedReviewSignature &&
    JSON.stringify(labelReviewSnapshot()) === publishedReviewSignature) {
    savedPdf.click();
    recordAudit("label_downloaded", { format: "saved_pdf" });
    return;
  }
  document.body.classList.add("printing-label");
  recordAudit("label_print_opened", { format: "browser_print" });
  window.print();
});

window.addEventListener("afterprint", () => {
  document.body.classList.remove("printing-label");
});

auditButton.addEventListener("click", () => {
  recordAudit("audit_log_downloaded", { event_count_before_download: auditLog.snapshot().event_count });
  const snapshot = auditLog.snapshot();
  downloadBlob(
    new Blob([`${JSON.stringify(snapshot, null, 2)}\n`], { type: "application/json;charset=utf-8" }),
    `formula-audit-${auditLog.sessionId}.json`,
  );
});

document.querySelector("#start-over").addEventListener("click", () => {
  cancelCalculation();
  recordAudit("new_analysis_started", { previous_result_present: Boolean(latestResult) });
  selectedFile = null;
  latestResult = null;
  currentRows = [];
  draftRows = [];
  latestContents = "";
  sessionHistory = [];
  workspace = null;
  confirmedIdentities.clear();
  savedLabelReview = null;
  document.querySelector("#label-options").reset();
  document.querySelector("#calculation-details").open = false;
  fileInput.value = "";
  formulaText.value = "";
  fileSummary.hidden = true;
  formulaReview.hidden = true;
  results.hidden = true;
  document.querySelector("#save-workspace").disabled = false;
  document.querySelector("#save-workspace").textContent = "Save formula";
  setStatus("");
  setReviewStatus("");
  uploadPanel.scrollIntoView({ behavior: "smooth", block: "start" });
  formulaText.focus();
});

const addIngredientForm = document.querySelector("#add-ingredient-form");
document.querySelector("#show-add-ingredient").addEventListener("click", () => {
  addIngredientForm.hidden = false;
  recordAudit("ingredient_add_form_opened", { current_row_count: currentRows.length });
  document.querySelector("#new-item").focus();
});

document.querySelector("#cancel-add-ingredient").addEventListener("click", () => {
  addIngredientForm.hidden = true;
  addIngredientForm.reset();
  recordAudit("ingredient_add_cancelled");
});

addIngredientForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const item = document.querySelector("#new-item").value.trim();
  const quantity = document.querySelector("#new-quantity").value.trim();
  const unit = document.querySelector("#new-unit").value;
  const addedRow = { item, submitted_quantity: quantity, submitted_unit: unit };
  currentRows.push(addedRow);
  addIngredientForm.hidden = true;
  addIngredientForm.reset();
  const calculated = await reanalyzeCurrentRows("ingredient_added");
  if (calculated === false) {
    currentRows.pop();
    document.querySelector("#new-item").value = item;
    document.querySelector("#new-quantity").value = quantity;
    document.querySelector("#new-unit").value = unit;
    addIngredientForm.hidden = false;
    renderIdentityReview(currentRows);
  } else if (calculated) {
    recordAudit("ingredient_addition_applied", { row_count: currentRows.length });
  }
});

refreshIngredientLibrary().then(refreshDatabaseSync);

const requestedFormula = new URLSearchParams(window.location.search).get("formula");
const requestedProduct = new URLSearchParams(window.location.search).get("product");
const resumeBrowserFormula = new URLSearchParams(window.location.search).get("resume") === "browser";
function applyBestLabelDefaults() {
  for (const row of defaultIdentityRows(latestResult))
    confirmedIdentities.add(identityReviewKey(row));
  const liquid = latestResult.basis_label === "per 100 mL";
  const smallDose = currentInputBasis === "dose";
  document.querySelector("#label-serving-size").value = smallDose ? latestResult.label_batch_quantity : "100";
  document.querySelector("#label-amount-basis").value = smallDose ? "serving" : "100";
  document.querySelector("#label-base").value = liquid && !latestResult.input_only ? "water" : "unspecified";
  document.querySelector("#label-assumption-estimate").checked = scenarioEligibility(latestResult, labelReviewOptions()).allowed;
  renderNutritionLabel();
}

function openPublishedProduct(product) {
  workspace = null;
  confirmedIdentities.clear();
  document.querySelector("#label-options").reset();
  document.querySelector("#calculation-details").open = false;
  publishedProduct = product;
  currentInputBasis = "dose";
  document.querySelector("#input-basis").value = "dose";
  document.querySelector("#dose-volume").value = product.labelReview.servingSize;
  updateInputBasis();
  latestContents = product.contents;
  latestFileName = product.fileName;
  sessionHistory = appendSessionVersion([], product.report, "published_product");
  savedLabelReview = product.labelReview;
  formulaReview.hidden = true;
  renderResult(structuredClone(product.report));
  publishedReviewSignature = JSON.stringify(labelReviewSnapshot());
  renderNutritionLabel();
  setStatus("Your label is ready. Download PDF saves this sheet; after edits, choose Save as PDF in the print dialog.");
  document.querySelector("#label-builder").scrollIntoView({ block: "start" });
}

function startInitialLoad(load, label) {
  const generation = inputGeneration;
  let timer;
  Promise.race([
    load(generation),
    new Promise((_, reject) => {
      timer = setTimeout(() => {
        if (generation === inputGeneration) {
          inputGeneration += 1; // Late initial data must not replace a retry.
          setStatus(`${label} timed out. Your input is retained. Reload to retry, or paste/upload a formula.`, true);
        }
        reject(new Error("Initial load timed out."));
      }, 10000);
    }),
  ]).catch((error) => {
    if (generation === inputGeneration) setStatus(error.message, true);
  }).finally(() => clearTimeout(timer));
}

if (requestedProduct) {
  const product = savedProduct(requestedProduct);
  if (!product) setStatus("This published product could not be found.", true);
  else {
    openPublishedProduct(product);
  }
} else if (requestedFormula || resumeBrowserFormula) {
  startInitialLoad((generation) => requestedFormula
    ? loadRemoteWorkspace(requestedFormula, generation) : loadSavedBrowserFormula(generation), "Opening the saved formula");
}

if (new URLSearchParams(window.location.search).get("sample") === "1") {
  startInitialLoad(async (generation) => {
    const response = await fetch(sampleTsvUrl);
    if (!response.ok) throw new Error("The sample formula could not be loaded. Reload to retry, or paste/upload a formula.");
    const contents = await response.text();
    if (generation !== inputGeneration) return;
    formulaText.value = contents;
    // The initial download deadline does not include the separate preparation job.
    void prepareInput();
  }, "Loading the sample formula");
}

// Core handlers are registered; optional integrations do not control readiness.
window.formulaAppReady = true;
document.querySelector("#app-load-status")?.setAttribute("hidden", "");
