import { normalizeText, rowsToTsv } from "./input-normalizer.js";
import { createAuditLog, sha256 } from "./audit-log.js";
import { buildNutritionLabel } from "./nutrition-label.js";
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
const confirmedIdentities = new Set();
const auditLog = createAuditLog();

async function persistBrowserWorkspace() {
  if (workspace?.mode === "server") {
    await saveBrowserWorkspace(serverWorkspaceRecord({
      formulaId: workspace.formulaId,
      currentVersion: workspace.currentVersion,
    }));
    return;
  }
  if (workspace?.mode !== "browser") return;
  await saveBrowserWorkspace(browserWorkspaceRecord({
    history: sessionHistory,
    latestContents,
    latestFileName,
    formulaId: workspace.formulaId,
  }));
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
  return savedIngredients.map((item) => ({
    alias: item.alias,
    material_id: item.material_id,
  }));
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

async function loadRemoteWorkspace(formulaId) {
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
  await persistBrowserWorkspace();
  formulaReview.hidden = true;
  renderResult(latest.report);
  recordAudit("workspace_resumed", { storage: "database", version: workspace.currentVersion });
}

async function loadSavedBrowserFormula() {
  const saved = await loadBrowserWorkspace();
  if (!saved) throw new Error("No formula is saved in this browser.");
  if (saved.storage === "server") {
    await loadRemoteWorkspace(saved.formula_id);
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
  formulaReview.hidden = true;
  renderResult(saved.history.at(-1).report);
  recordAudit("workspace_resumed", {
    storage: "browser",
    version: workspace.currentVersion,
  });
}

function selectFile(file) {
  if (!file) return;
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
  input.addEventListener("input", () => onInput(input.value));
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
      row.item,
      `Item row ${index + 1}`,
      (value) => { row.item = value; },
      { row_index: index + 1, field: "item" },
    ));
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
  formulaReview.hidden = false;
  results.hidden = true;
  setReviewStatus(`${draftRows.length} rows found. Check every value before calculation.`);
  formulaReview.scrollIntoView({ behavior: "smooth", block: "start" });
  document.querySelector("#formula-review-title").focus();
}

async function prepareInput() {
  const startedAt = performance.now();
  const inputKind = selectedFile ? "file" : "paste";
  prepareButton.disabled = true;
  prepareButton.textContent = "Reading…";
  setStatus("Reading the formula in your browser…");
  recordAudit("ingestion_started", {
    input_kind: inputKind,
    extension: selectedFile?.name.split(".").pop()?.toLowerCase() || null,
    bytes: selectedFile?.size || new TextEncoder().encode(formulaText.value).byteLength,
  });
  try {
    const inputHash = await sha256(selectedFile ? await selectedFile.arrayBuffer() : formulaText.value);
    const extraction = selectedFile
      ? await import("./ingestion.js").then(({ ingestFile }) =>
          ingestFile(selectedFile, (message) => setStatus(message)))
      : { ...normalizeText(formulaText.value), rawText: formulaText.value };
    latestFileName = selectedFile?.name || "pasted-formula.tsv";
    renderPreparedFormula(extraction);
    recordAudit("ingestion_completed", {
      input_kind: inputKind,
      method: extraction.method,
      row_count: extraction.rows.length,
      duration_ms: durationSince(startedAt),
      input_sha256: inputHash,
    });
    setStatus("");
  } catch (error) {
    recordAudit("ingestion_failed", {
      input_kind: inputKind,
      error_type: error?.constructor?.name || "Error",
      duration_ms: durationSince(startedAt),
    });
    setStatus(error.message, true);
  } finally {
    prepareButton.disabled = false;
    prepareButton.textContent = "Check formula";
  }
}

prepareButton.addEventListener("click", prepareInput);

document.querySelector("#add-draft-row").addEventListener("click", () => {
  draftRows.push({ item: "", quantity: "", unit: "kg" });
  recordAudit("draft_row_added", { row_index: draftRows.length, row_count: draftRows.length });
  renderDraftRows();
  document.querySelector(`#draft-body tr:nth-child(${draftRows.length}) input`).focus();
});

document.querySelector("#edit-source").addEventListener("click", () => {
  recordAudit("source_edit_requested", { existing_row_count: draftRows.length });
  formulaReview.hidden = true;
  results.hidden = true;
  uploadPanel.scrollIntoView({ behavior: "smooth", block: "start" });
  formulaText.focus();
  refreshSavedWorkspaceOffer();
});

function validateDraftRows() {
  if (draftRows.length < 2) throw new Error("Keep a finished-batch row and at least one ingredient.");
  if (draftRows.some((row) => !row.item.trim() || !row.quantity.trim() || !row.unit)) {
    throw new Error("Every reviewed row needs an item, quantity, and unit.");
  }
  if (!/^finished\s+batch$/i.test(draftRows[0].item.trim())) {
    throw new Error("The first row must be FINISHED BATCH. Correct the recovered item before calculating.");
  }
}

function renderFormula(rows) {
  const body = document.querySelector("#formula-body");
  body.replaceChildren();
  for (const [index, row] of rows.entries()) {
    const tr = document.createElement("tr");
    tr.append(
      cell("Item", row.item),
      cell("Given", `${row.submitted_quantity} ${row.submitted_unit}`),
      cell("Converted to", row.normalized_equivalent),
    );
    const interpretation = document.createElement("td");
    interpretation.dataset.label = "Read as";
    const name = document.createElement("div");
    name.textContent = row.interpretation;
    interpretation.append(name);
    if (row.confidence && row.confidence !== "exact") interpretation.append(confidenceBadge(row.confidence));
    if (index > 0 && row.material_id && row.reusable_profile) {
      const save = reviewButton("Save for reuse", () => saveIngredientForReuse(row));
      save.className = "ingredient-save-button";
      save.setAttribute("aria-label", `Save ${row.item} for reuse`);
      const confirmed = !row.needs_review || confirmedIdentities.has(row.item.toLowerCase());
      if (!confirmed) {
        save.textContent = "Confirm before saving";
        save.disabled = true;
      } else if (ingredientIsSaved(row)) {
        save.textContent = "Saved for reuse";
        save.disabled = true;
      }
      interpretation.append(save);
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
  const pending = uncertain.filter(({ row }) => !confirmedIdentities.has(row.item.toLowerCase())).length;
  document.querySelector("#review-count").textContent = `${pending} to review`;

  for (const { row, index } of uncertain) {
    const key = row.item.toLowerCase();
    const card = document.createElement("div");
    card.className = "identity-review-row";
    if (confirmedIdentities.has(key)) card.classList.add("is-confirmed");
    const copy = document.createElement("div");
    copy.className = "identity-copy";
    const submitted = document.createElement("strong");
    submitted.textContent = row.item;
    const interpreted = document.createElement("span");
    interpreted.textContent = `Read as ${row.interpretation} · ${row.confidence} confidence`;
    copy.append(submitted, interpreted);
    const actions = document.createElement("div");
    actions.className = "identity-actions";
    const replacement = document.createElement("div");
    replacement.className = "replacement-controls";
    replacement.hidden = true;
    if (!confirmedIdentities.has(key)) {
      actions.append(
        reviewButton("Confirm", async () => {
          confirmedIdentities.add(key);
          recordAudit("identity_confirmed", { row_index: index + 1 });
          renderIdentityReview(currentRows);
          renderFormula(currentRows);
          if (workspace) {
            await reanalyzeCurrentRows("identity_confirmed", [
              { action: "confirm", line_index: index, candidate_id: row.material_id },
            ]);
          }
        }),
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
      confirmed.textContent = "Confirmed for this review";
      actions.append(confirmed);
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
      if (!(await reanalyzeCurrentRows("identity_replaced"))) {
        currentRows[index].item = previousName;
        renderIdentityReview(currentRows);
      } else {
        recordAudit("identity_replacement_applied", { row_index: index + 1, source });
      }
    });
    const remove = reviewButton("Remove row", async () => {
      confirmedIdentities.delete(key);
      const [removedRow] = currentRows.splice(index, 1);
      if (!(await reanalyzeCurrentRows("identity_row_removed"))) {
        currentRows.splice(index, 0, removedRow);
        renderIdentityReview(currentRows);
      } else {
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
  const body = document.querySelector("#components-body");
  body.replaceChildren();
  for (const component of components) {
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
        const value = contributionValue(contribution, basisLabel);
        item.textContent = `${contribution.material_name}: ${formatNumber(value)} ${contribution.unit.replace("ug", "µg")} · ${sourceLabel(contribution)}`;
        list.append(item);
      }
      details.append(summary, list);
      componentCell.append(details);
    }
    tr.append(
      componentCell,
      cell("Amount", `${formatNumber(component.value)} ${component.unit.replace("ug", "µg")}`),
      cell("Possible range", component.range_label || "—"),
    );
    const evidence = document.createElement("td");
    evidence.dataset.label = "Confidence";
    evidence.append(confidenceBadge(`${component.confidence.score} ${component.confidence.band}`));
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
    await persistBrowserWorkspace();
    renderResult(restored.report);
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
    }
    list.append(li);
  }
}

function renderNutritionLabel() {
  if (!latestResult) return;
  const labelStatus = document.querySelector("#label-status");
  try {
    const label = buildNutritionLabel(latestResult, {
      productName: document.querySelector("#label-product-name").value,
      servingSize: document.querySelector("#label-serving-size").value,
      servingsPerPack: document.querySelector("#label-servings-per-pack").value,
    });
    document.querySelector("#label-preview-name").textContent = label.productName;
    document.querySelector("#label-preview-serving").textContent = `${label.servingSize} ${label.servingUnit}`;
    document.querySelector("#label-basis-heading").textContent = label.basisLabel;
    document.querySelector("#label-serving-heading").textContent = label.servingLabel;
    document.querySelector("#label-serving-unit").textContent = label.servingUnit;
    document.querySelector("#label-ingredients").textContent = label.ingredients.join(", ") || "Not established";

    const servingsRow = document.querySelector("#label-preview-servings-row");
    servingsRow.hidden = !label.servingsPerPack;
    document.querySelector("#label-preview-servings").textContent = label.servingsPerPack;

    const nutrientBody = document.querySelector("#label-nutrients");
    nutrientBody.replaceChildren();
    for (const nutrient of label.nutrients) {
      const row = document.createElement("tr");
      if (nutrient.status === "partial") row.className = "is-partial";
      const name = document.createElement("th");
      name.scope = "row";
      name.textContent = nutrient.name;
      const basis = document.createElement("td");
      basis.dataset.label = label.basisLabel;
      basis.textContent = `${nutrient.perBasis} ${nutrient.unit}`;
      const serving = document.createElement("td");
      serving.dataset.label = label.servingLabel;
      serving.textContent = `${nutrient.perServing} ${nutrient.unit}`;
      const rda = document.createElement("td");
      rda.dataset.label = "%RDA";
      rda.textContent = nutrient.rdaPercent;
      row.append(name, basis, serving, rda);
      nutrientBody.append(row);
    }

    const warnings = [];
    if (label.hasIncompleteData) {
      warnings.push("≥ marks a lower bound because one or more ingredient profiles are incomplete.");
    }
    if (label.hasIdentityReview) {
      warnings.push("Resolve the flagged ingredient identities before using this draft externally.");
    }
    const warning = document.querySelector("#label-data-warning");
    warning.hidden = warnings.length === 0;
    warning.textContent = warnings.join(" ");
    updateStatus(labelStatus, "Label preview updated.");
    recordAudit("label_preview_updated", {
      serving_size: label.servingSize,
      serving_unit: label.servingUnit,
      nutrient_count: label.nutrients.length,
      incomplete_data: label.hasIncompleteData,
    });
    return true;
  } catch (error) {
    updateStatus(labelStatus, error.message, true);
    return false;
  }
}

function renderResult(result) {
  latestResult = result;
  currentRows = result.formula_rows.map((row) => ({ ...row }));
  document.querySelector("#inference-name").textContent = result.product_inference.name;
  document.querySelector("#inference-reason").textContent = result.product_inference.reason;
  document.querySelector("#inference-boundary").textContent = result.product_inference.boundary;
  document.querySelector("#inference-confidence").textContent = `Confidence: ${result.product_inference.confidence}`;
  const known = formatNumber(result.coverage.characterized_percent);
  const unknown = formatNumber(result.coverage.uncharacterized_percent);
  document.querySelector("#coverage-known").textContent = known;
  document.querySelector("#coverage-bar").style.width = `${Math.min(100, Number(known))}%`;
  document.querySelector("#coverage-note").textContent = `${unknown}% of the measured input has not been identified. This is different from accuracy.`;
  document.querySelector("#basis-label").textContent = `Calculated ${result.basis_label}`;
  document.querySelector("#engine-version").textContent = `Calculator ${result.calculation?.engine_version || "version not shown"}`;
  document.querySelector("#report-fingerprint").textContent = result.calculation?.nutrition_catalog_fingerprint
    ? `Data set ${result.calculation.nutrition_catalog_fingerprint.slice(0, 10)}`
    : "Data set ID unavailable";
  renderFormula(result.formula_rows);
  renderIdentityReview(currentRows);
  renderComponents(result.present_components, result.basis_label);
  renderHistory();
  renderList("#assumptions-list", result.report_assumptions, "No extra assumptions were used.");
  renderList("#missing-list", result.missing_information, "No missing ingredient information was found.");
  const labelUnit = result.basis_label === "per 100 mL" ? "mL" : "g";
  const labelUnitElement = document.querySelector("#label-serving-unit");
  if (labelUnitElement.textContent !== labelUnit) {
    document.querySelector("#label-serving-size").value = labelUnit === "mL" ? "200" : "30";
  }
  labelUnitElement.textContent = labelUnit;
  document.querySelector("#label-product-name").value = result.product_name;
  renderNutritionLabel();
  const saveButton = document.querySelector("#save-workspace");
  saveButton.disabled = Boolean(workspace);
  saveButton.textContent = workspace ? "Saved" : "Save formula";
  results.hidden = false;
  results.scrollIntoView({ behavior: "smooth", block: "start" });
  document.querySelector("#results-title").focus();
}

async function analyzeContents(contents, uploadedName, trigger = "review_confirmed", decisions = []) {
  const startedAt = performance.now();
  const inputHash = await sha256(contents);
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
    const endpoint = workspace?.mode === "server"
      ? `/api/formulas/${workspace.formulaId}/versions`
      : "/api/analyze";
    const requestBody = {
      file_name: uploadedName.endsWith(".tsv") ? uploadedName : `${uploadedName}.tsv`,
      contents,
      accepted_aliases: acceptedAliasPayload(),
    };
    if (workspace?.mode === "server") {
      requestBody.expected_version = workspace.currentVersion;
      requestBody.cause = trigger;
      requestBody.decisions = decisions;
    }
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(requestBody),
    });
    responseStatus = response.status;
    requestId = response.headers.get("x-request-id");
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || "The formula could not be analyzed.");
    const data = payload.report || payload;
    if (workspace?.mode === "server" && payload.version) {
      workspace.currentVersion = payload.version.version;
      await persistBrowserWorkspace();
      await refreshDatabaseSync();
    }
    sessionHistory = appendSessionVersion(
      sessionHistory,
      data,
      trigger === "review_confirmed" && sessionHistory.length === 0 ? "created" : trigger,
      payload.version?.version || null,
    );
    await persistBrowserWorkspace();
    formulaReview.hidden = true;
    renderResult(data);
    window.appHealth?.track('formula_checked');
    const resultForHash = { ...data };
    delete resultForHash.markdown;
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
      result_sha256: await sha256(JSON.stringify(resultForHash)),
    });
    setReviewStatus(`Calculated ${data.formula_rows.length - 1} ingredients from the reviewed rows.`);
    return true;
  } catch (error) {
    recordAudit("calculation_failed", {
      trigger,
      request_id: requestId,
      http_status: responseStatus,
      duration_ms: durationSince(startedAt),
      error_type: error?.constructor?.name || "Error",
      input_sha256: inputHash,
    });
    if (!latestResult) results.hidden = true;
    setReviewStatus(error.message, true);
    return false;
  } finally {
    calculateButton.disabled = false;
    calculateButton.textContent = "Confirm and calculate";
  }
}

document.querySelector("#save-workspace").addEventListener("click", async () => {
  if (!latestResult || !latestContents || workspace) return;
  const button = document.querySelector("#save-workspace");
  button.disabled = true;
  button.textContent = "Saving…";
  try {
    const response = await fetch("/api/formulas", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        file_name: latestFileName,
        contents: latestContents,
        accepted_aliases: acceptedAliasPayload(),
      }),
    });
    const payload = await response.json();
    if (!response.ok && payload.code !== "persistence_unavailable") {
      throw new Error(payload.error || "Your work could not be saved.");
    }
    if (payload.code === "persistence_unavailable") {
      workspace = {
        mode: "browser",
        formulaId: crypto.randomUUID(),
        currentVersion: sessionHistory.at(-1)?.version || 1,
      };
      await persistBrowserWorkspace();
      button.textContent = "Saved";
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
    await analyzeContents(rowsToTsv(draftRows), latestFileName, "review_confirmed");
  } catch (error) {
    recordAudit("review_validation_failed", { error_type: error?.constructor?.name || "Error" });
    setReviewStatus(error.message, true);
  }
});

document.querySelector("#download-report").addEventListener("click", () => {
  if (!latestResult) return;
  window.appHealth?.track('report_downloaded');
  recordAudit("report_downloaded", { format: "markdown" });
  const blob = new Blob([latestResult.markdown], { type: "text/markdown;charset=utf-8" });
  downloadBlob(blob, `${latestResult.product_name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-report.md`);
});

document.querySelector("#download-json").addEventListener("click", () => {
  if (!latestResult) return;
  recordAudit("report_downloaded", { format: "json" });
  const exportResult = { ...latestResult };
  delete exportResult.markdown;
  const blob = new Blob([`${JSON.stringify(exportResult, null, 2)}\n`], { type: "application/json;charset=utf-8" });
  downloadBlob(blob, `${latestResult.product_name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}.json`);
});

document.querySelector("#label-options").addEventListener("submit", (event) => {
  event.preventDefault();
  renderNutritionLabel();
});

document.querySelector("#print-label").addEventListener("click", () => {
  if (!latestResult) return;
  if (!renderNutritionLabel()) return;
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
  recordAudit("new_analysis_started", { previous_result_present: Boolean(latestResult) });
  selectedFile = null;
  latestResult = null;
  currentRows = [];
  draftRows = [];
  latestContents = "";
  sessionHistory = [];
  workspace = null;
  confirmedIdentities.clear();
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
  if (!(await reanalyzeCurrentRows("ingredient_added"))) {
    currentRows.pop();
    document.querySelector("#new-item").value = item;
    document.querySelector("#new-quantity").value = quantity;
    document.querySelector("#new-unit").value = unit;
    addIngredientForm.hidden = false;
    renderIdentityReview(currentRows);
  } else {
    recordAudit("ingredient_addition_applied", { row_count: currentRows.length });
  }
});

refreshIngredientLibrary().then(refreshDatabaseSync);

const requestedFormula = new URLSearchParams(window.location.search).get("formula");
const resumeBrowserFormula = new URLSearchParams(window.location.search).get("resume") === "browser";
if (requestedFormula || resumeBrowserFormula) {
  (requestedFormula ? loadRemoteWorkspace(requestedFormula) : loadSavedBrowserFormula())
    .catch((error) => setStatus(error.message, true));
}

if (new URLSearchParams(window.location.search).get("sample") === "1") {
  fetch(sampleTsvUrl)
    .then((response) => response.text())
    .then((contents) => {
      formulaText.value = contents;
      return prepareInput();
    })
    .catch(() => setStatus("The sample formula could not be loaded.", true));
}
