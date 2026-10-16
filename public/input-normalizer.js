const UNIT_ALIASES = new Map([
  ["kg", "kg"], ["kgs", "kg"], ["kilogram", "kg"], ["kilograms", "kg"],
  ["g", "g"], ["gm", "g"], ["gms", "g"], ["gram", "g"], ["grams", "g"],
  ["mg", "mg"], ["milligram", "mg"], ["milligrams", "mg"],
  ["ug", "ug"], ["mcg", "ug"], ["µg", "ug"], ["μg", "ug"], ["microgram", "ug"],
  ["micrograms", "ug"], ["l", "L"], ["lt", "L"], ["ltr", "L"],
  ["litre", "L"], ["litres", "L"], ["liter", "L"], ["liters", "L"],
  ["ml", "mL"], ["millilitre", "mL"], ["millilitres", "mL"],
  ["milliliter", "mL"], ["milliliters", "mL"],
]);

const ITEM_KEYS = ["item", "ingredient", "material", "name", "description"];
const QUANTITY_KEYS = ["quantity", "qty", "amount", "value", "weight", "volume"];
const UNIT_KEYS = ["unit", "uom", "units"];

function cleanCell(value) {
  if (value === null || value === undefined) return "";
  return String(value).replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();
}

function normalizedKey(value) {
  return cleanCell(value).toLowerCase().replace(/[^a-z0-9]+/g, "");
}

export function normalizeUnit(value) {
  const key = cleanCell(value).toLowerCase().replace(/[.]/g, "");
  return UNIT_ALIASES.get(key) || null;
}

function normalizeQuantity(value) {
  let text = cleanCell(value).replace(/\s/g, "");
  if (/^[+-]?\d{1,3}(,\d{3})+(\.\d+)?$/.test(text)) text = text.replace(/,/g, "");
  else if (/^[+-]?\d+,\d+$/.test(text)) text = text.replace(",", ".");
  if (!/^[+-]?(?:\d+(?:\.\d+)?|\.\d+)$/.test(text)) return null;
  return text.replace(/^\+/, "");
}

function isFinishedBatch(value) {
  const key = normalizedKey(value);
  return ["finishedbatch", "finalbatch", "batchsize", "finalyield", "yield"].includes(key);
}

function canonicalRow(item, quantity, unit, sourceLine) {
  const normalizedQuantity = normalizeQuantity(quantity);
  const normalizedUnit = normalizeUnit(unit);
  if (!cleanCell(item) || !normalizedQuantity || !normalizedUnit) return null;
  return {
    item: isFinishedBatch(item) ? "FINISHED BATCH" : cleanCell(item),
    quantity: normalizedQuantity,
    unit: normalizedUnit,
    source_line: sourceLine,
  };
}

function parseQuantityAndUnit(value) {
  const match = cleanCell(value).match(
    /^([+-]?(?:\d[\d,.]*|\.\d+))\s*(kg|kgs?|kilograms?|g|gms?|grams?|mg|milligrams?|ug|mcg|[µμ]g|micrograms?|l|lt|ltr|lit(?:er|re)s?|ml|millilit(?:er|re)s?)\.?$/i,
  );
  if (!match) return null;
  return { quantity: match[1], unit: match[2] };
}

function parseLine(value, sourceLine) {
  const line = cleanCell(value).replace(/^[•·*-]\s*/, "");
  const quantityOnly = parseQuantityAndUnit(line);
  if (quantityOnly) {
    return canonicalRow("FINISHED BATCH", quantityOnly.quantity, quantityOnly.unit, sourceLine);
  }
  const match = line.match(
    /^(.+?)\s+([+-]?(?:\d[\d,.]*|\.\d+))\s*(kg|kgs?|kilograms?|g|gms?|grams?|mg|milligrams?|ug|mcg|[µμ]g|micrograms?|l|lt|ltr|lit(?:er|re)s?|ml|millilit(?:er|re)s?)\.?$/i,
  );
  if (!match) return null;
  return canonicalRow(match[1], match[2], match[3], sourceLine);
}

function parseCsvLine(line, delimiter) {
  const cells = [];
  let current = "";
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (character === '"') {
      if (quoted && line[index + 1] === '"') {
        current += '"';
        index += 1;
      } else quoted = !quoted;
    } else if (character === delimiter && !quoted) {
      cells.push(cleanCell(current));
      current = "";
    } else current += character;
  }
  cells.push(cleanCell(current));
  return cells;
}

function rowFromObject(object, sourceLine) {
  if (!object || typeof object !== "object" || Array.isArray(object)) return null;
  const entries = new Map(Object.entries(object).map(([key, value]) => [normalizedKey(key), value]));
  const find = (keys) => keys.map(normalizedKey).find((key) => entries.has(key));
  const itemKey = find(ITEM_KEYS);
  const quantityKey = find(QUANTITY_KEYS);
  const unitKey = find(UNIT_KEYS);
  let quantity = quantityKey ? entries.get(quantityKey) : null;
  let unit = unitKey ? entries.get(unitKey) : null;
  if (quantity && typeof quantity === "object") {
    unit ||= quantity.unit;
    quantity = quantity.value ?? quantity.quantity ?? quantity.amount;
  }
  if (!itemKey || quantity === null || quantity === undefined) return null;
  if (!unit) {
    const combined = parseQuantityAndUnit(quantity);
    if (combined) ({ quantity, unit } = combined);
  }
  return canonicalRow(entries.get(itemKey), quantity, unit, sourceLine);
}

// Retain only fields read by the formula parser, never unrelated JSON metadata.
function jsonRowEvidence(value, batch = false) {
  const literal = (entry) => entry == null || ["string", "number", "boolean"].includes(typeof entry) ? entry : String(entry);
  if (Array.isArray(value)) return value.slice(0, 3).map(literal);
  if (!value || typeof value !== "object") return literal(value);
  const entries = new Map(Object.entries(value).map(([key, entry]) => [normalizedKey(key), entry]));
  const read = (keys) => entries.get(keys.map(normalizedKey).find((key) => entries.has(key)));
  let quantity = read(batch ? ["final_quantity", ...QUANTITY_KEYS] : QUANTITY_KEYS);
  let unit = read(UNIT_KEYS);
  if (quantity && typeof quantity === "object") {
    unit ||= quantity.unit;
    quantity = quantity.value ?? quantity.quantity ?? quantity.amount;
  }
  return { item: batch ? "FINISHED BATCH" : literal(read(ITEM_KEYS)), quantity: literal(quantity), unit: literal(unit) };
}

function jsonRows(value) {
  if (Array.isArray(value)) return value;
  if (!value || typeof value !== "object") return [];
  for (const key of ["rows", "ingredients", "items", "formula", "materials"]) {
    if (Array.isArray(value[key])) return value[key];
  }
  return [];
}

export function normalizeJson(value, options = {}) {
  const parsed = typeof value === "string" ? JSON.parse(value) : value;
  const rows = [];
  if (parsed && !Array.isArray(parsed) && typeof parsed === "object") {
    const batch = parsed.batch || parsed.finished_batch || parsed.final_batch;
    if (batch) {
      const quantity = typeof batch === "object"
        ? batch.final_quantity ?? batch.quantity ?? batch.amount ?? batch.value
        : batch;
      const combined = typeof quantity === "object"
        ? canonicalRow("FINISHED BATCH", quantity.value ?? quantity.quantity, quantity.unit, 1)
        : typeof batch === "object" && batch.unit
          ? canonicalRow("FINISHED BATCH", quantity, batch.unit, 1)
          : parseLine(quantity, 1);
      if (combined) rows.push(combined);
    }
  }
  for (const [index, row] of jsonRows(parsed).entries()) {
    const normalized = Array.isArray(row)
      ? canonicalRow(row[0], row[1], row[2], index + 1)
      : rowFromObject(row, index + 1);
    if (normalized) rows.push(normalized);
  }
  const container = Array.isArray(parsed) ? "" : ["rows", "ingredients", "items", "formula", "materials"].find((key) => Array.isArray(parsed?.[key]));
  for (const row of rows) {
    const isBatch = !Array.isArray(parsed) && row.item === "FINISHED BATCH" && (parsed.batch || parsed.finished_batch || parsed.final_batch);
    const path = isBatch ? ["batch", "finished_batch", "final_batch"].find((key) => parsed[key]) : `${container || ""}[${row.source_line - 1}]`;
    row.input_source = { method: "JSON", json_path: path, text: JSON.stringify(jsonRowEvidence(isBatch || jsonRows(parsed)[row.source_line - 1], Boolean(isBatch))), original: originalValues(row) };
    delete row.source_line;
  }
  return finalizeRows(rows, "JSON", options);
}

function detectHeader(matrix) {
  for (let index = 0; index < Math.min(matrix.length, 5); index += 1) {
    const keys = matrix[index].map(normalizedKey);
    const item = keys.findIndex((key) => ITEM_KEYS.map(normalizedKey).includes(key));
    const quantity = keys.findIndex((key) => QUANTITY_KEYS.map(normalizedKey).includes(key));
    const unit = keys.findIndex((key) => UNIT_KEYS.map(normalizedKey).includes(key));
    if (item >= 0 && quantity >= 0 && unit >= 0) return { index, item, quantity, unit };
  }
  return null;
}

export function normalizeMatrix(rawMatrix, method = "table", options = {}) {
  const entries = rawMatrix.map((raw, index) => {
    const cells = (Array.isArray(raw) ? raw : [raw]).map(cleanCell);
    while (cells[0] === "") cells.shift();
    while (cells.at(-1) === "") cells.pop();
    return { cells, index, raw };
  }).filter(({ cells }) => cells.some(Boolean) && !cells.every((cell) => /^:?-{3,}:?$/.test(cell)));
  const matrix = entries.map(({ cells }) => cells);
  const header = detectHeader(matrix);
  const rows = [];
  const start = header ? header.index + 1 : 0;
  for (let index = start; index < matrix.length; index += 1) {
    const cells = matrix[index];
    const sourceLine = entries[index].index + 1;
    let row = null;
    if (header) {
      row = canonicalRow(
        cells[header.item], cells[header.quantity], cells[header.unit], sourceLine,
      );
    } else if (cells.length >= 3) {
      row = canonicalRow(cells[0], cells[1], cells[2], sourceLine);
    } else if (cells.length === 2) {
      const combined = parseQuantityAndUnit(cells[1]);
      if (combined) row = canonicalRow(cells[0], combined.quantity, combined.unit, sourceLine);
    } else if (cells.length === 1) row = parseLine(cells[0], sourceLine);
    if (row) {
      const supplied = options.sourceRows?.[entries[index].index];
      row.input_source = { method, line: sourceLine,
        ...(options.worksheet ? { worksheet: options.worksheet } : {}),
        ...(supplied || { cells: (Array.isArray(entries[index].raw) ? entries[index].raw : [entries[index].raw]).map((cell) => cell == null ? "" : String(cell)) }),
        original: originalValues(row) };
      row.source_line = row.input_source.line;
      rows.push(row);
    }
  }
  return finalizeRows(rows, method, options);
}

function finalizeRows(rows, method, options = {}) {
  if (options.basisRow && rows.length && !isFinishedBatch(rows[0].item)) {
    const basis = canonicalRow("FINISHED BATCH", options.basisRow.quantity, options.basisRow.unit, 0);
    if (!basis) throw new Error("Enter a valid dose volume and unit.");
    rows = [basis, ...rows];
  }
  const deduplicated = rows.filter(
    (row, index) => index === 0 || JSON.stringify(row) !== JSON.stringify(rows[index - 1]),
  );
  if (deduplicated.length < 2) {
    throw new Error(
      "Could not identify a finished batch and at least one ingredient. Edit the text into one line per item, ending each line with quantity and unit.",
    );
  }
  if (!isFinishedBatch(deduplicated[0].item)) {
    throw new Error("The first recovered row must identify the finished batch quantity.");
  }
  return { rows: deduplicated, method };
}

export function normalizeText(text, method = "pasted text", options = {}) {
  const source = String(text || "");
  if (!source.trim()) throw new Error("Paste a formula or choose a supported file.");
  if (/^[\[{]/.test(source.trim())) {
    try {
      return normalizeJson(source, options);
    } catch (error) {
      if (error instanceof SyntaxError) throw new Error("The JSON input is not valid.");
      throw error;
    }
  }
  const lines = source.split(/\r\n|\r|\n/);
  const firstLines = lines.filter((line) => cleanCell(line)).slice(0, 5).join("\n");
  const delimiter = firstLines.includes("\t")
    ? "\t"
    : firstLines.includes("|")
      ? "|"
      : firstLines.includes(";")
        ? ";"
        : firstLines.includes(",")
          ? ","
          : null;
  const matrix = lines.map((line) => delimiter ? parseCsvLine(line, delimiter) : [line]);
  return normalizeMatrix(matrix, method, { ...options, sourceRows: lines.map((text, index) => ({ text, ...options.sourceRows?.[index] })) });
}

export function rowsToTsv(rows) {
  const safe = (value) => cleanCell(value).replace(/[\t\r\n]+/g, " ");
  return [
    "Item\tQuantity\tUnit",
    ...rows.map((row) => [row.item, row.quantity, row.unit].map(safe).join("\t")),
  ].join("\n") + "\n";
}

function originalValues({ item, quantity, unit }) {
  return { item, quantity, unit };
}

// Join extracted page lines only after recording their page-local coordinates.
export function normalizePages(pages, method, options = {}) {
  const sourceRows = pages.flatMap((page, index) => page.text.split(/\r\n|\r|\n/).map((text, line) => ({
    text, page: index + 1, line: line + 1, ...(page.ocr ? { ocr: page.ocr } : {}),
  })));
  const rawText = sourceRows.map((source) => source.text).join("\n");
  return { ...normalizeText(rawText, method, { ...options, sourceRows }), rawText };
}
