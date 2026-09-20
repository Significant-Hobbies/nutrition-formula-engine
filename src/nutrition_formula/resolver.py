"""Deterministic local ingredient-name search and assumption reporting."""

from __future__ import annotations

import re
from difflib import SequenceMatcher
from typing import Any


def normalize_name(value: str) -> str:
    return " ".join(re.findall(r"[a-z0-9]+", value.casefold()))


def _score(query: str, candidate: str) -> float:
    left = normalize_name(query)
    right = normalize_name(candidate)
    if not left or not right:
        return 0.0
    if left == right:
        return 1.0
    sequence = SequenceMatcher(None, left, right).ratio()
    left_tokens = set(left.split())
    right_tokens = set(right.split())
    jaccard = len(left_tokens & right_tokens) / len(left_tokens | right_tokens)
    containment = len(left_tokens & right_tokens) / min(len(left_tokens), len(right_tokens))
    return max(sequence, (0.45 * sequence) + (0.35 * jaccard) + (0.20 * containment))


def search_materials(catalog: dict[str, Any], query: str, limit: int = 5) -> list[dict[str, Any]]:
    results: list[dict[str, Any]] = []
    normalized_query = normalize_name(query)
    for material_id, material in catalog.get("materials", {}).items():
        terms = [material["name"], *material.get("aliases", [])]
        best_term = max(terms, key=lambda term: _score(query, term))
        score = _score(query, best_term)
        results.append(
            {
                "material_id": material_id,
                "name": material["name"],
                "matched_term": best_term,
                "score": round(score, 6),
                "match_type": "exact" if normalize_name(best_term) == normalized_query else "fuzzy",
            }
        )
    return sorted(results, key=lambda item: (-item["score"], item["material_id"]))[:limit]


def resolve_material(
    catalog: dict[str, Any], query: str, minimum_score: float = 0.58
) -> tuple[str, dict[str, Any]]:
    candidates = search_materials(catalog, query)
    if not candidates or candidates[0]["score"] < minimum_score:
        rendered = ", ".join(
            f"{candidate['name']} ({candidate['score']:.2f})" for candidate in candidates[:3]
        )
        raise ValueError(f"Could not resolve ingredient {query!r}; nearest matches: {rendered}")
    selected = candidates[0]
    selected_material = catalog["materials"][selected["material_id"]]
    margin = selected["score"] - (candidates[1]["score"] if len(candidates) > 1 else 0)
    if selected["match_type"] == "exact":
        confidence = "exact"
    elif selected["score"] >= 0.88 and margin >= 0.08:
        confidence = "high"
    elif selected["score"] >= 0.72 and margin >= 0.04:
        confidence = "medium"
    else:
        confidence = "low"
    identity_status = selected_material.get("identity_status", "verified")
    if identity_status != "verified":
        confidence = "low"
    assumption = {
        "query": query,
        "selected_material_id": selected["material_id"],
        "selected_name": selected["name"],
        "matched_term": selected["matched_term"],
        "score": f"{selected['score']:.6f}",
        "confidence": confidence,
        "identity_status": identity_status,
        "identity_note": selected_material.get("identity_note"),
        "identity_candidates": selected_material.get("identity_candidates", []),
        "correction": f"Set material_id to the intended catalog ID instead of ingredient={query!r}",
        "alternatives": candidates[1:4],
    }
    return selected["material_id"], assumption
