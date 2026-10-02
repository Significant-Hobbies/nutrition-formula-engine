import { recentFormulaItems } from "./recent-formulas-model.js";
import { loadBrowserWorkspace } from "./workspace-store.js";

const list = document.querySelector("#recent-formulas-list");
const empty = document.querySelector("#recent-formulas-empty");
const status = document.querySelector("#recent-formulas-status");
const retry = document.querySelector("#recent-formulas-retry");

function formatSavedAt(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Date unavailable";
  return `Saved ${date.toLocaleString()}`;
}

function render(items, onlineAvailable, browserAvailable) {
  list.replaceChildren();
  empty.hidden = items.length !== 0 || !onlineAvailable || !browserAvailable;
  retry.hidden = onlineAvailable && browserAvailable;
  const messages = [];
  if (items.length) messages.push(`${items.length} saved formula${items.length === 1 ? "" : "s"}`);
  if (!onlineAvailable) messages.push("Online formulas could not be checked.");
  if (!browserAvailable) messages.push("Formulas saved in this browser could not be checked.");
  if (!messages.length) messages.push("Nothing has been saved yet.");
  status.textContent = messages.join(" ");

  for (const item of items) {
    const card = document.createElement("article");
    card.className = "recent-formula-card";

    const copy = document.createElement("div");
    const title = document.createElement("h3");
    title.textContent = item.name;
    const meta = document.createElement("p");
    meta.textContent = `${item.fileName} · Version ${item.version} · ${formatSavedAt(item.savedAt)}`;
    const location = document.createElement("span");
    location.className = "formula-storage-label";
    location.textContent = item.storage === "online" ? "Public formula" : "Saved in this browser";
    copy.append(title, meta, location);

    const open = document.createElement("a");
    open.className = "secondary-button";
    open.href = item.href;
    open.textContent = "Open";
    open.setAttribute("aria-label", `Open ${item.name}`);
    card.append(copy, open);
    list.append(card);
  }
}

async function refresh() {
  retry.disabled = true;
  status.textContent = "Loading saved formulas…";
  let remoteWorkspaces = [];
  let onlineAvailable = false;
  let browserAvailable = false;
  let browserWorkspace = null;
  try {
    browserWorkspace = await loadBrowserWorkspace();
    browserAvailable = true;
  } catch {
    // The online list can still be shown when browser storage is unavailable.
  }
  try {
    const response = await fetch("/api/formulas");
    if (!response.ok) throw new Error("Online formulas are unavailable.");
    const payload = await response.json();
    if (!Array.isArray(payload.workspaces)) throw new Error("Online formula list is invalid.");
    remoteWorkspaces = payload.workspaces;
    onlineAvailable = true;
  } catch {
    onlineAvailable = false;
  }
  render(recentFormulaItems(remoteWorkspaces, browserWorkspace), onlineAvailable, browserAvailable);
  retry.disabled = false;
}

retry.addEventListener("click", refresh);
refresh();
