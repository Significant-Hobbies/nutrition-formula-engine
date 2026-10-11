function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[character]);
}

export function comparisonsFor(study) {
  return study.components || [{
    component: study.component,
    declared: study.declared,
    predicted: study.predicted,
    difference_percent: study.difference_percent,
  }];
}

export function caseStudyCounts(data) {
  return {
    products: data.cases.length,
    comparisons: data.cases.flatMap(comparisonsFor).length,
    sources: new Set(data.cases.map((study) => study.source.replace(/ label$/i, ""))).size,
  };
}

export function renderCaseStudyCards(data) {
  return data.cases.map((study) => {
    const sourceUrl = new URL(study.source_url);
    if (!["https:", "http:"].includes(sourceUrl.protocol)) {
      throw new Error("Case-study sources must use HTTP or HTTPS");
    }
    const rows = comparisonsFor(study).map((comparison) => `<tr>
      <td data-label="Value">${escapeHtml(comparison.component)}</td>
      <td data-label="Published">${escapeHtml(comparison.declared)}</td>
      <td data-label="Calculated">${escapeHtml(comparison.predicted)}</td>
      <td data-label="Difference">${escapeHtml(comparison.difference_percent)}%</td>
    </tr>`).join("");
    return `<article class="case-study-card">
      <div class="case-study-card-heading">
        <h3>${escapeHtml(study.product)}</h3>
        <a href="${escapeHtml(sourceUrl.href)}" target="_blank" rel="noreferrer">View ${escapeHtml(study.source)} source</a>
      </div>
      <div class="table-wrap"><table>
        <thead><tr><th>Value</th><th>Published</th><th>Calculated</th><th>Difference</th></tr></thead>
        <tbody>${rows}</tbody>
      </table></div>
      ${study.assumption ? `<p class="case-study-assumption">What we assumed: ${escapeHtml(study.assumption)}</p>` : ""}
    </article>`;
  }).join("\n");
}
