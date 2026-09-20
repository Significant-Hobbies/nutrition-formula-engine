const DATABASE_NAME = "formula-composition-workspaces";
const STORE_NAME = "workspaces";
const INGREDIENT_STORE_NAME = "ingredients";
const ACTIVE_ID = "active";

function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, 2);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE_NAME)) {
        request.result.createObjectStore(STORE_NAME, { keyPath: "id" });
      }
      if (!request.result.objectStoreNames.contains(INGREDIENT_STORE_NAME)) {
        request.result.createObjectStore(INGREDIENT_STORE_NAME, { keyPath: "alias_key" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function transaction(storeName, mode, operation) {
  return openDatabase().then((database) => new Promise((resolve, reject) => {
    const tx = database.transaction(storeName, mode);
    const request = operation(tx.objectStore(storeName));
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    tx.oncomplete = () => database.close();
    tx.onerror = () => reject(tx.error);
  }));
}

export function browserWorkspaceRecord({ history, latestContents, latestFileName, formulaId }) {
  if (!Array.isArray(history) || history.length === 0) {
    throw new Error("A calculated report is required before saving a workspace.");
  }
  return {
    id: ACTIVE_ID,
    formula_id: formulaId,
    saved_at: new Date().toISOString(),
    latest_contents: latestContents,
    latest_file_name: latestFileName,
    history: structuredClone(history.slice(-10)),
  };
}

export function saveBrowserWorkspace(record) {
  return transaction(STORE_NAME, "readwrite", (store) => store.put(record));
}

export function loadBrowserWorkspace() {
  return transaction(STORE_NAME, "readonly", (store) => store.get(ACTIVE_ID));
}

export function clearBrowserWorkspace() {
  return transaction(STORE_NAME, "readwrite", (store) => store.delete(ACTIVE_ID));
}

export function browserIngredientRecord(row) {
  if (!row?.material_id || !row?.item || row.reusable_profile === false) {
    throw new Error("A resolved ingredient with a reusable profile is required.");
  }
  const alias = row.item.trim();
  return {
    alias_key: alias.toLocaleLowerCase("en").replace(/[^a-z0-9]+/g, " ").trim(),
    alias,
    material_id: row.material_id,
    canonical_name: row.interpretation || row.item,
    source: row.source || "Local accepted profile",
    profile_version: row.profile_version || null,
    saved_at: new Date().toISOString(),
  };
}

export function saveBrowserIngredient(record) {
  return transaction(INGREDIENT_STORE_NAME, "readwrite", (store) => store.put(record));
}

export function loadBrowserIngredients() {
  return transaction(INGREDIENT_STORE_NAME, "readonly", (store) => store.getAll());
}

export function deleteBrowserIngredient(aliasKey) {
  return transaction(INGREDIENT_STORE_NAME, "readwrite", (store) => store.delete(aliasKey));
}
