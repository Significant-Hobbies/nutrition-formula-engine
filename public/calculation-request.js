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
                if (!Array.isArray(report.formula_rows) || report.formula_rows.length < 2 ||
                  !["screened_components", "present_components", "report_assumptions", "missing_information"].every((key) => Array.isArray(report[key])) ||
                  !report.coverage || typeof report.product_name !== "string" ||
                  !/^(?:\d+(?:\.\d*)?|\.\d+)$/.test(String(report.label_batch_quantity)) || !/[1-9]/.test(report.label_batch_quantity) ||
                  !["per 100 mL", "per 100 g"].includes(report.basis_label)) {
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
