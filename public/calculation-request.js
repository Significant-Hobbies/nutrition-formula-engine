// Validate before committing state: rendering must never turn malformed data into a total.
const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const text = (value) => typeof value === "string" && value.trim().length > 0;
const decimal = (value) => typeof value === "string" && /^(?:\d+(?:\.\d*)?|\.\d+)$/.test(value);
const nullableDecimal = (value) => value === null || decimal(value);
const strings = (value) => Array.isArray(value) && value.every((item) => typeof item === "string");
function validComponent(component) {
  return object(component) && ["id", "name", "unit", "status"].every((key) => text(component[key])) &&
    ["value", "total_batch"].every((key) => nullableDecimal(component[key])) &&
    strings(component.unknown_materials) && Array.isArray(component.contributions) &&
    component.contributions.every((entry) => object(entry) && text(entry.material_name) && text(entry.unit) &&
      Number.isInteger(entry.line_index) && entry.line_index >= 0 &&
      ["total_batch", "per_100_g", "per_100_ml", "per_serving"].every((key) => nullableDecimal(entry[key])) &&
      object(entry.source) && text(entry.source.kind) && text(entry.source.reference)) &&
    (component.range == null || (object(component.range) && nullableDecimal(component.range.lower) && nullableDecimal(component.range.upper))) &&
    (component.confidence == null || (object(component.confidence) && decimal(component.confidence.score) && text(component.confidence.band)));
}
export function validCalculationReport(report) {
  return object(report) && text(report.product_name) && decimal(report.label_batch_quantity) && /[1-9]/.test(report.label_batch_quantity) &&
    ["per 100 mL", "per 100 g"].includes(report.basis_label) &&
    Array.isArray(report.formula_rows) && report.formula_rows.length >= 2 && report.formula_rows.every((row, index) =>
      object(row) && ["item", "submitted_unit", "normalized_equivalent", "interpretation", "confidence"].every((key) => text(row[key])) &&
      decimal(row.submitted_quantity) && (index > 0 || /[1-9]/.test(row.submitted_quantity)) &&
      ["kg", "g", "mg", "ug", "µg", "L", "mL"].includes(row.submitted_unit) && strings(row.alternatives) &&
      typeof row.needs_review === "boolean" && (index === 0 || typeof row.unresolved === "boolean") &&
      (row.material_id == null || text(row.material_id)) &&
      (row.input_source == null || (object(row.input_source) && text(row.input_source.method) &&
        object(row.input_source.original) && ["item", "quantity", "unit"].every((key) => typeof row.input_source.original[key] === "string")))) &&
    ["screened_components", "present_components"].every((key) => Array.isArray(report[key]) && report[key].every(validComponent)) &&
    report.present_components.every((component) => decimal(component.value)) &&
    strings(report.report_assumptions) && object(report.coverage) &&
    ["characterized_percent", "uncharacterized_percent"].every((key) => nullableDecimal(report.coverage[key])) &&
    Array.isArray(report.missing_information) && report.missing_information.every((entry) =>
      object(entry) && text(entry.item) && text(entry.needed) && (entry.affects == null || strings(entry.affects))) &&
    (report.label_entries == null || (Array.isArray(report.label_entries) && report.label_entries.every((entry) =>
      object(entry) && text(entry.name) && text(entry.unit) && decimal(entry.batch_amount)))) &&
    (report.ingredient_assumptions == null || (Array.isArray(report.ingredient_assumptions) &&
      report.ingredient_assumptions.every((entry) => object(entry) && Number.isInteger(entry.line_index) && entry.line_index >= 0)));
}

export class CalculationRequestError extends Error {
  constructor(message, { fallback = false, status = null } = {}) {
    super(message);
    this.name = "CalculationRequestError";
    this.fallback = fallback;
    this.status = status;
  }
}

export function createCalculationRequests({ fetchImpl = (...args) => fetch(...args), timeoutMs = 10000 } = {}) {
  let active = null;
  function cancel() {
    if (!active) return;
    active.current = false;
    active.controller.abort();
    active.reject?.(new CalculationRequestError("A newer input replaced this request."));
    active = null;
  }
  return {
    cancel,
    start() {
      cancel();
      const state = { current: true, controller: new AbortController() };
      active = state;
      return {
        isCurrent: () => state.current,
        async fetchJson(url, options) {
          if (!state.current) throw new CalculationRequestError("A newer input replaced this request.");
          let timer;
          try {
            const payload = await Promise.race([
              (async () => {
                const response = await fetchImpl(url, { ...options, signal: state.controller.signal });
                let data;
                try { data = await response.json(); }
                catch { throw new CalculationRequestError("The calculation service returned an unreadable response.", { fallback: response.ok || response.status >= 500, status: response.status }); }
                if (!response.ok) throw new CalculationRequestError(data.error || "The formula could not be analyzed.", {
                  fallback: response.status >= 500 || [404, 408, 429].includes(response.status), status: response.status,
                });
                const report = data.report || data;
                if (!validCalculationReport(report)) {
                  throw new CalculationRequestError("The calculation service returned an incomplete response.", { fallback: true, status: response.status });
                }
                return { data, status: response.status, requestId: response.headers.get("x-request-id") };
              })(),
              new Promise((_, reject) => {
                state.reject = reject;
                timer = setTimeout(() => {
                  reject(new CalculationRequestError("Calculation timed out. Your supplied quantities are available as a draft.", { fallback: true }));
                  state.controller.abort();
                }, timeoutMs);
              }),
            ]);
            if (!state.current) throw new CalculationRequestError("A newer input replaced this request.");
            return payload;
          } catch (error) {
            if (error instanceof CalculationRequestError) throw error;
            throw new CalculationRequestError("The calculation service is unavailable. Your supplied quantities are available as a draft.", { fallback: true });
          } finally {
            clearTimeout(timer);
            state.reject = null;
          }
        },
      };
    },
  };
}
