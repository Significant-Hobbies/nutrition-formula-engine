import { recentFormulaItems } from "./recent-formulas-model.js";
import { loadBrowserWorkspace } from "./workspace-store.js";

const list = document.querySelector("#recent-formulas-list");
const empty = document.querySelector("#recent-formulas-empty");
const status = document.querySelector("#recent-formulas-status");

function formatSavedAt(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Date unavailable";
  return `Saved ${date.toLocaleString()}`;
}

function render(items, onlineAvailable) {
  list.replaceChildren();
  empty.hidden = items.length !== 0;
  status.textContent = items.length
    ? `${items.length} saved formula${items.length === 1 ? "" : "s"}`
    : onlineAvailable
      ? "Nothing has been saved yet."
      : "Online formulas could not be checked.";

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
  let remoteWorkspaces = [];
  let onlineAvailable = false;
  let browserWorkspace = null;
  try {
    browserWorkspace = await loadBrowserWorkspace();
  } catch {
    // The online list can still be shown when browser storage is unavailable.
  }
  try {
    const response = await fetch("/api/formulas");
    if (!response.ok) throw new Error("Online formulas are unavailable.");
    const payload = await response.json();
    remoteWorkspaces = payload.workspaces || [];
    onlineAvailable = true;
  } catch {
    onlineAvailable = false;
  }
  render(recentFormulaItems(remoteWorkspaces, browserWorkspace), onlineAvailable);
}

refresh();
