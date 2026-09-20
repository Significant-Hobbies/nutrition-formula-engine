"""Candidate-only search over versioned local ingredient profiles."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from .resolver import search_materials

DATA_ROOT = Path(__file__).resolve().parent / "data"


def _load(name: str) -> dict[str, Any]:
    with (DATA_ROOT / name).open(encoding="utf-8") as handle:
        return json.load(handle)


def local_material(material_id: str, kind: str = "food") -> dict[str, Any] | None:
    if kind not in {"food", "chemical"}:
        raise ValueError("kind must be food or chemical")
    file_name = "catalog.json" if kind == "food" else "chemical_catalog.json"
    return _load(file_name).get("materials", {}).get(material_id)


def search_local_ingredients(query: str, kind: str = "all", limit: int = 8) -> dict[str, Any]:
    if not query.strip():
        raise ValueError("Search query is required")
    if kind not in {"all", "food", "chemical"}:
        raise ValueError("kind must be all, food, or chemical")
    catalogs = []
    if kind in {"all", "food"}:
        catalogs.append(("food", _load("catalog.json")))
    if kind in {"all", "chemical"}:
        catalogs.append(("chemical", _load("chemical_catalog.json")))
    candidates = []
    for catalog_kind, catalog in catalogs:
        for match in search_materials(catalog, query, limit=limit):
            material = catalog["materials"][match["material_id"]]
            candidates.append(
                {
                    "candidate_id": f"local:{catalog_kind}:{match['material_id']}",
                    "catalog": catalog_kind,
                    **match,
                    "identity_status": material.get("identity_status", "verified"),
                    "has_composition_profile": bool(material.get("nutrients")),
                    "is_compound": bool(material.get("components")),
                    "source": material.get("source", {}),
                    "candidate_only": True,
                }
            )
    candidates.sort(key=lambda item: (-item["score"], item["candidate_id"]))
    return {
        "query": query,
        "kind": kind,
        "candidate_only": True,
        "confirmation_required": True,
        "external_search_available": False,
        "candidates": candidates[:limit],
    }
