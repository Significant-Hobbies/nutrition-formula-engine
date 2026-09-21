export function recentFormulaItems(remoteWorkspaces = [], browserWorkspace = null) {
  const items = remoteWorkspaces.map((record) => ({
    id: record.formula_id,
    name: record.product_name || "Saved formula",
    fileName: record.file_name || "Formula",
    version: Number(record.current_version) || 1,
    savedAt: record.created_at,
    storage: "online",
    href: `/?formula=${encodeURIComponent(record.formula_id)}`,
  }));

  if (browserWorkspace && browserWorkspace.storage !== "server" && browserWorkspace.history?.length) {
    const latest = browserWorkspace.history.at(-1);
    items.push({
      id: browserWorkspace.formula_id,
      name: latest.report?.product_inference?.name || latest.report?.product_name || "Saved formula",
      fileName: browserWorkspace.latest_file_name || "Formula",
      version: Number(latest.version) || 1,
      savedAt: browserWorkspace.saved_at,
      storage: "browser",
      href: "/?resume=browser",
    });
  }

  return items.sort((left, right) => {
    const rightTime = Date.parse(right.savedAt) || 0;
    const leftTime = Date.parse(left.savedAt) || 0;
    return rightTime - leftTime;
  });
}
