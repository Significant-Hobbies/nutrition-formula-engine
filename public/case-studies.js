import caseStudiesData from "./case-studies.json";

function comparisonsFor(study) {
  return study.components || [{
    component: study.component,
    declared: study.declared,
    predicted: study.predicted,
    difference_percent: study.difference_percent,
  }];
}

function tableCell(label, value) {
  const cell = document.createElement("td");
  cell.dataset.label = label;
  cell.textContent = value;
  return cell;
}

function renderCaseStudies(data) {
  const list = document.querySelector("#case-study-list");
  const comparisons = data.cases.flatMap(comparisonsFor);
  const sources = new Set(data.cases.map((study) => study.source.replace(/ label$/i, "")));

  document.querySelector("#product-count").textContent = data.cases.length;
  document.querySelector("#comparison-count").textContent = comparisons.length;
  document.querySelector("#source-count").textContent = sources.size;

  for (const study of data.cases) {
    const article = document.createElement("article");
    article.className = "case-study-card";

    const heading = document.createElement("div");
    heading.className = "case-study-card-heading";
    const title = document.createElement("h3");
    title.textContent = study.product;
    const source = document.createElement("a");
    source.href = study.source_url;
    source.target = "_blank";
    source.rel = "noreferrer";
    source.textContent = `View ${study.source} source`;
    heading.append(title, source);

    const tableWrap = document.createElement("div");
    tableWrap.className = "table-wrap";
    const table = document.createElement("table");
    table.innerHTML = "<thead><tr><th>Value</th><th>Published</th><th>Calculated</th><th>Difference</th></tr></thead>";
    const body = document.createElement("tbody");
    for (const comparison of comparisonsFor(study)) {
      const row = document.createElement("tr");
      row.append(
        tableCell("Value", comparison.component),
        tableCell("Published", comparison.declared),
        tableCell("Calculated", comparison.predicted),
        tableCell("Difference", `${comparison.difference_percent}%`),
      );
      body.append(row);
    }
    table.append(body);
    tableWrap.append(table);
    article.append(heading, tableWrap);

    if (study.assumption) {
      const note = document.createElement("p");
      note.className = "case-study-assumption";
      note.textContent = `What we assumed: ${study.assumption}`;
      article.append(note);
    }
    list.append(article);
  }
}

renderCaseStudies(caseStudiesData);
