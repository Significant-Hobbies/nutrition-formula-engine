import caseStudiesData from "./case-studies.json";
import { caseStudyCounts, renderCaseStudyCards } from "./case-studies-render.js";

const counts = caseStudyCounts(caseStudiesData);
document.querySelector("#product-count").textContent = counts.products;
document.querySelector("#comparison-count").textContent = counts.comparisons;
document.querySelector("#source-count").textContent = counts.sources;
// Replace the pre-rendered cards so enabling JavaScript never duplicates evidence.
document.querySelector("#case-study-list").innerHTML = renderCaseStudyCards(caseStudiesData);
