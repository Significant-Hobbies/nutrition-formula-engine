const DATABASE_NAME = "formula-composition-workspaces";
const STORE_NAME = "workspaces";
const ACTIVE_ID = "active";

function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE_NAME)) {
        request.result.createObjectStore(STORE_NAME, { keyPath: "id" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function transaction(mode, operation) {
  return openDatabase().then((database) => new Promise((resolve, reject) => {
    const tx = database.transaction(STORE_NAME, mode);
    const request = operation(tx.objectStore(STORE_NAME));
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
  return transaction("readwrite", (store) => store.put(record));
}

export function loadBrowserWorkspace() {
  return transaction("readonly", (store) => store.get(ACTIVE_ID));
}

export function clearBrowserWorkspace() {
  return transaction("readwrite", (store) => store.delete(ACTIVE_ID));
}
