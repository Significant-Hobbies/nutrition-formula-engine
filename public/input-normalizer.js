const UNIT_ALIASES = new Map([
  ["kg", "kg"], ["kgs", "kg"], ["kilogram", "kg"], ["kilograms", "kg"],
  ["g", "g"], ["gm", "g"], ["gms", "g"], ["gram", "g"], ["grams", "g"],
  ["mg", "mg"], ["milligram", "mg"], ["milligrams", "mg"],
  ["ug", "ug"], ["mcg", "ug"], ["µg", "ug"], ["microgram", "ug"],
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
    /^([+-]?(?:\d[\d,.]*|\.\d+))\s*(kg|kgs?|kilograms?|g|gms?|grams?|mg|milligrams?|ug|mcg|µg|micrograms?|l|lt|ltr|lit(?:er|re)s?|ml|millilit(?:er|re)s?)\.?$/i,
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
    /^(.+?)\s+([+-]?(?:\d[\d,.]*|\.\d+))\s*(kg|kgs?|kilograms?|g|gms?|grams?|mg|milligrams?|ug|mcg|µg|micrograms?|l|lt|ltr|lit(?:er|re)s?|ml|millilit(?:er|re)s?)\.?$/i,
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

function jsonRows(value) {
  if (Array.isArray(value)) return value;
  if (!value || typeof value !== "object") return [];
  for (const key of ["rows", "ingredients", "items", "formula", "materials"]) {
    if (Array.isArray(value[key])) return value[key];
  }
  return [];
}

export function normalizeJson(value) {
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
  return finalizeRows(rows, "JSON");
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

export function normalizeMatrix(rawMatrix, method = "table") {
  const matrix = rawMatrix
    .map((row) => (Array.isArray(row) ? row.map(cleanCell) : [cleanCell(row)]))
    .map((row) => {
      while (row[0] === "") row.shift();
      while (row.at(-1) === "") row.pop();
      return row;
    })
    .filter((row) => row.some(Boolean))
    .filter((row) => !row.every((cell) => /^:?-{3,}:?$/.test(cell)));
  const header = detectHeader(matrix);
  const rows = [];
  const start = header ? header.index + 1 : 0;
  for (let index = start; index < matrix.length; index += 1) {
    const cells = matrix[index];
    let row = null;
    if (header) {
      row = canonicalRow(
        cells[header.item], cells[header.quantity], cells[header.unit], index + 1,
      );
    } else if (cells.length >= 3) {
      row = canonicalRow(cells[0], cells[1], cells[2], index + 1);
    } else if (cells.length === 2) {
      const combined = parseQuantityAndUnit(cells[1]);
      if (combined) row = canonicalRow(cells[0], combined.quantity, combined.unit, index + 1);
    } else if (cells.length === 1) row = parseLine(cells[0], index + 1);
    if (row) rows.push(row);
  }
  return finalizeRows(rows, method);
}

function finalizeRows(rows, method) {
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

export function normalizeText(text, method = "pasted text") {
  const source = String(text || "").trim();
  if (!source) throw new Error("Paste a formula or choose a supported file.");
  if (/^[\[{]/.test(source)) {
    try {
      return normalizeJson(source);
    } catch (error) {
      if (error instanceof SyntaxError) throw new Error("The JSON input is not valid.");
      throw error;
    }
  }
  const lines = source.split(/\r?\n/).filter((line) => cleanCell(line));
  const firstLines = lines.slice(0, 5).join("\n");
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
  return normalizeMatrix(matrix, method);
}

export function rowsToTsv(rows) {
  const safe = (value) => cleanCell(value).replace(/[\t\r\n]+/g, " ");
  return [
    "Item\tQuantity\tUnit",
    ...rows.map((row) => [row.item, row.quantity, row.unit].map(safe).join("\t")),
  ].join("\n") + "\n";
}
