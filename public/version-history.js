export function componentDelta(previous, current) {
  if (!previous) return [];
  const before = new Map(previous.screened_components.map((item) => [item.id, item]));
  const after = new Map(current.screened_components.map((item) => [item.id, item]));
  const ids = [...new Set([...before.keys(), ...after.keys()])].sort();
  return ids.flatMap((id) => {
    const oldRow = before.get(id);
    const newRow = after.get(id);
    const oldValue = Number(oldRow?.value || 0);
    const newValue = Number(newRow?.value || 0);
    const unit = newRow?.unit || oldRow?.unit;
    if (oldValue === newValue && oldRow?.unit === newRow?.unit) return [];
    return [{
      id,
      name: newRow?.name || oldRow?.name,
      before: oldValue,
      after: newValue,
      change: newValue - oldValue,
      unit,
    }];
  });
}

export function appendSessionVersion(history, report, cause, serverVersion = null) {
  const previous = history.at(-1)?.report || null;
  const previousVersion = history.at(-1)?.version || 0;
  const record = {
    version: previousVersion + 1,
    server_version: serverVersion,
    created_at: new Date().toISOString(),
    cause,
    delta: componentDelta(previous, report),
    report: structuredClone(report),
  };
  return [...history, record].slice(-25);
}

export function restoreSessionVersion(history, version) {
  const target = history.find((item) => item.version === version);
  if (!target) throw new Error("The selected report version is no longer available.");
  return {
    history: appendSessionVersion(history, target.report, `restored_from_v${version}`),
    report: structuredClone(target.report),
  };
}

export function contributionValue(contribution, basisLabel) {
  return basisLabel === "per 100 mL" ? contribution.per_100_ml : contribution.per_100_g;
}
