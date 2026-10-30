// Source evidence describes user-supplied extraction, not verified ingredient identity.
export function inputProvenance(rows, unparsedRows = []) {
  const sources = rows.map((row) => row.input_source || null);
  return sources.some(Boolean) || unparsedRows.length ? { version: 1, rows: sources,
    ...(unparsedRows.length ? { unparsed_rows: structuredClone(unparsedRows) } : {}) } : undefined;
}

export function sourceLabel(source) {
  const location = source.json_path ? `JSON ${source.json_path}`
    : [source.worksheet ? `Worksheet ${source.worksheet}` : "", source.page ? `Page ${source.page}` : "", source.line ? `${source.page || source.ocr ? "recovered line" : "line"} ${source.line}` : ""].filter(Boolean).join(" · ");
  const confidence = source.ocr ? ` · OCR engine ${source.ocr.confidence ?? "unavailable"}${source.ocr.confidence == null ? "" : "/100"} (${source.ocr.scope})` : "";
  return `${source.method} · ${location}${confidence}`;
}

export function sourceMarkdown(rows = [], unparsedRows = []) {
  const escape = (value) => String(value).replace(/[&<>|`\\\[\]()!*_#~:]/g, (char) => `&#${char.charCodeAt(0)};`).replace(/[\r\n]+/g, " ");
  const sources = rows.flatMap((row, index) => row.input_source ? [
    `- Row ${index + 1}: ${escape(sourceLabel(row.input_source))}. Original recovered values: ${escape(["item", "quantity", "unit"].map((key) => row.input_source.original[key]).join(" · "))}. Source: ${escape(row.input_source.text ?? row.input_source.cells?.join(" · ") ?? row.input_source.json_path)}.`,
  ] : []);
  for (const source of unparsedRows) sources.push(`- Source line not included: ${escape(sourceLabel(source))}. Source: ${escape(source.text ?? source.cells?.join(" · ") ?? "")}.`);
  return sources.length ? ["", "## Input source evidence", "", "User-supplied extraction evidence; OCR engine confidence is not calibrated correctness or ingredient identity confidence.", "", ...sources, ""].join("\n") : "";
}
