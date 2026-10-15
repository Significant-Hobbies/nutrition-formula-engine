// Review records do not edit the formula or automatically accept search candidates.
export function lineReviewPanel({ formulaId, version, ordinal, item, fetcher = fetch }) {
  const panel = document.createElement("details");
  panel.className = "line-review-panel";
  const summary = document.createElement("summary");
  summary.textContent = "Search sources / record rejection";
  panel.append(summary);
  const status = document.createElement("p");
  status.className = "line-review-status";
  status.setAttribute("role", "status");
  const provider = document.createElement("select");
  for (const [value, label] of [["fdc", "FoodData Central"], ["pubchem", "PubChem"]]) {
    const option = document.createElement("option"); option.value = value; option.textContent = label; provider.append(option);
  }
  const query = document.createElement("input"); query.value = item; query.maxLength = 160; query.setAttribute("aria-label", "Source search query");
  const rationale = document.createElement("textarea"); rationale.maxLength = 2000; rationale.rows = 3; rationale.placeholder = "Why this source decision was made (required)"; rationale.setAttribute("aria-label", "Decision rationale");
  const list = document.createElement("div");
  list.className = "line-review-results";
  const fields = document.createElement("div");
  fields.className = "line-review-fields";
  for (const [caption, control] of [["Source", provider], ["Search query", query], ["Decision rationale", rationale]]) {
    const label = document.createElement("label");
    label.textContent = caption;
    label.append(control);
    fields.append(label);
  }
  const actions = document.createElement("div");
  actions.className = "line-review-actions";
  let rowId, pending, retryButton, busy = false;
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
    const labels = {search_pending: "Search pending", no_candidate: "No candidate", provider_failure: "Provider unavailable",
      malformed_response: "Provider response invalid", ambiguous_candidates: "Ambiguous candidates",
      search_results: "Search results", rejected_candidate: "Candidate rejected"};
    status.textContent = records.map(d => `${labels[d.state] || d.state}: ${d.rationale}`).join(" · ") || "No source decisions recorded.";
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
    b.addEventListener("click", async () => {if (busy) return; busy = true; b.disabled = true; try {await action();} catch (e) {status.textContent = e.message;} finally {b.disabled = false; busy = false; retryButton.hidden = !pending;}});
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
      entry.className = "line-review-candidate";
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
  const searchButton = button("Search", () => search(false));
  searchButton.className = "line-review-search";
  retryButton = button("Retry saved decision", async () => {
    if (!pending) throw new Error("No failed decision to retry.");
    await save(pending.state, {}, true);
  });
  retryButton.hidden = true;
  actions.append(searchButton, button("Refresh sources", () => search(true)), retryButton);
  panel.append(fields, actions, status, list);
  panel.addEventListener("toggle", () => {if (panel.open) readback().catch(e => {status.textContent = e.message;});});
  return panel;
}
