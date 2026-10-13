// Review records do not edit the formula or automatically accept search candidates.
export function lineReviewPanel({ formulaId, version, ordinal, item, fetcher = fetch }) {
  const panel = document.createElement("details");
  const summary = document.createElement("summary");
  summary.textContent = "Search sources / record rejection";
  panel.append(summary);
  const status = document.createElement("p");
  status.setAttribute("role", "status");
  const provider = document.createElement("select");
  for (const [value, label] of [["fdc", "FoodData Central"], ["pubchem", "PubChem"]]) {
    const option = document.createElement("option"); option.value = value; option.textContent = label; provider.append(option);
  }
  const query = document.createElement("input"); query.value = item; query.maxLength = 160; query.setAttribute("aria-label", "Source search query");
  const rationale = document.createElement("input"); rationale.maxLength = 2000; rationale.placeholder = "Decision rationale (required)"; rationale.setAttribute("aria-label", "Decision rationale");
  const list = document.createElement("div");
  let rowId, pending, busy = false;
  const endpoint = `/api/formulas/${encodeURIComponent(formulaId)}/versions/${version}/review`;
  async function json(url, options) {
    const response = await fetcher(url, options); const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Review persistence unavailable");
    return data;
  }
  async function readback() {
    const data = await json(endpoint);
    rowId = data.rows.find(row => row.ordinal === ordinal)?.source_row_id;
    if (!rowId) throw new Error("Source row unavailable");
    const records = data.decisions.filter(d => d.source_row_id === rowId);
    status.textContent = records.map(d => `${d.state}: ${d.rationale}`).join(" · ") || "No source decisions recorded.";
  }
  async function save(state, candidate = {}, retry = false) {
    if (pending && !retry) throw new Error("Retry the failed decision before starting another action.");
    if (!rationale.value.trim()) throw new Error("Enter a rationale before recording a decision.");
    if (!rowId) await readback();
    // Keep the exact request on a failed response so retry is idempotent.
    pending ||= {request_id: crypto.randomUUID(), source_row_id: rowId, state,
      rationale: rationale.value, query: candidate.search_query ?? query.value, provider: candidate.provider ?? provider.value,
      candidate_id: candidate.candidate_id, evidence_id: candidate.evidence_id,
      retrieved_at: candidate.retrieved_at, candidate_source: candidate.source};
    await json(endpoint, {method: "POST", headers: {"Content-Type": "application/json"}, body: JSON.stringify(pending)});
    pending = null; await readback();
  }
  function button(label, action) {
    const b = document.createElement("button"); b.type = "button"; b.textContent = label;
    b.addEventListener("click", async () => {if (busy) return; busy = true; b.disabled = true; try {await action();} catch (e) {status.textContent = e.message;} finally {b.disabled = false; busy = false;}});
    return b;
  }
  async function search(refresh) {
    const selectedProvider = provider.value, selectedQuery = query.value;
    await save("search_pending", {provider: selectedProvider, search_query: selectedQuery});
    const data = await json(`/api/ingredients/search?provider=${encodeURIComponent(selectedProvider)}&q=${encodeURIComponent(selectedQuery)}&refresh=${refresh}`);
    const states = {no_result: "no_candidate", unavailable: "provider_failure", malformed: "malformed_response", ambiguous: "ambiguous_candidates", matches: "search_results"};
    await save(states[data.status], {provider: selectedProvider, search_query: selectedQuery}); list.replaceChildren();
    for (const candidate of data.candidates) {
      const entry = document.createElement("p");
      const link = document.createElement("a"); link.href = candidate.source.reference; link.target = "_blank"; link.rel = "noopener"; link.textContent = `${candidate.name} · ${candidate.candidate_id} · ${candidate.retrieved_at}`;
      entry.append(link, button("Reject candidate", () => save("rejected_candidate", {...candidate, search_query: selectedQuery})));
      if (candidate.has_composition_profile) entry.append(button("Accept for reuse", async () => {
        await json("/api/ingredients", {method: "POST", headers: {"Content-Type": "application/json"}, body: JSON.stringify({provider: selectedProvider, query: selectedQuery, candidate_id: candidate.candidate_id, evidence_id: candidate.evidence_id, submitted_alias: item})});
        status.textContent = "Accepted profile saved and read back. Recalculate to use the saved ingredient.";
      }));
      else entry.append(" · Identity only; nutrient composition unavailable.");
      list.append(entry);
    }
  }
  panel.append(provider, query, rationale, button("Search", () => search(false)), button("Refresh sources", () => search(true)), button("Retry saved decision", async () => {
    if (!pending) throw new Error("No failed decision to retry.");
    await save(pending.state, {}, true);
  }), status, list);
  panel.addEventListener("toggle", () => {if (panel.open) readback().catch(e => {status.textContent = e.message;});});
  return panel;
}
