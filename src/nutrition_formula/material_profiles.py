"""Immutable accepted ingredient profiles and aliases."""

from __future__ import annotations

import json
from collections.abc import Callable
from copy import deepcopy
from datetime import UTC, datetime
from typing import Any

from .resolver import normalize_name, search_materials
from .versioning import canonical_json, d1_results, fingerprint


class MaterialProfileError(ValueError):
    """Raised when an accepted material profile cannot be stored or reused."""


def _default_clock() -> str:
    return datetime.now(UTC).isoformat().replace("+00:00", "Z")


def _clean_aliases(name: str, aliases: list[str]) -> list[str]:
    cleaned: dict[str, str] = {}
    for value in [name, *aliases]:
        if not isinstance(value, str):
            raise MaterialProfileError("Ingredient aliases must be strings")
        alias = " ".join(value.split()).strip()
        if not alias or len(alias) > 160:
            raise MaterialProfileError("Ingredient aliases must contain 1 to 160 characters")
        cleaned.setdefault(normalize_name(alias), alias)
    if len(cleaned) > 30:
        raise MaterialProfileError("An ingredient profile may contain at most 30 aliases")
    return list(cleaned.values())


def material_profile_record(
    *,
    material_id: str,
    material: dict[str, Any],
    submitted_alias: str,
    kind: str = "food",
    accepted_at: str | None = None,
    supersedes_version: str | None = None,
) -> dict[str, Any]:
    """Build a validated immutable snapshot from a calculation catalog material."""

    if not isinstance(material_id, str) or not material_id.strip() or len(material_id) > 160:
        raise MaterialProfileError("A valid material_id is required")
    if kind not in {"food", "chemical"}:
        raise MaterialProfileError("Ingredient kind must be food or chemical")
    if not isinstance(material, dict) or not isinstance(material.get("name"), str):
        raise MaterialProfileError("The selected material does not have a reusable profile")
    if not material.get("nutrients") and not material.get("components"):
        raise MaterialProfileError("The selected material has no reusable composition profile")
    source = material.get("source")
    if not isinstance(source, dict) or not source.get("reference"):
        raise MaterialProfileError("A reusable ingredient profile must retain its source")

    snapshot = deepcopy(material)
    aliases = _clean_aliases(
        snapshot["name"],
        [submitted_alias, *snapshot.get("aliases", [])],
    )
    snapshot["aliases"] = [alias for alias in aliases if alias != snapshot["name"]]
    payload = {
        "id": material_id,
        "name": snapshot["name"],
        "kind": kind,
        "aliases": aliases,
        "profile": snapshot,
        "source": deepcopy(source),
    }
    version = fingerprint(payload)[:20]
    return {
        **payload,
        "version": version,
        "status": "active",
        "supersedes_version": supersedes_version,
        "accepted_at": accepted_at or _default_clock(),
        "profile_fingerprint": fingerprint(snapshot),
    }


def merge_material_profiles(
    catalog: dict[str, Any], profiles: list[dict[str, Any]]
) -> tuple[dict[str, Any], dict[str, str]]:
    """Merge active immutable profiles and return their exact alias decisions."""

    merged = deepcopy(catalog)
    accepted_aliases: dict[str, str] = {}
    for record in profiles:
        if record.get("status", "active") != "active":
            continue
        material_id = str(record["id"])
        profile = deepcopy(record["profile"])
        source = deepcopy(profile.get("source", {}))
        source.update(
            {
                "accepted_profile_id": material_id,
                "accepted_profile_version": str(record["version"]),
            }
        )
        profile["source"] = source
        profile["aliases"] = list(
            dict.fromkeys([*profile.get("aliases", []), *record.get("aliases", [])])
        )
        merged["materials"][material_id] = profile
        for alias in [record["name"], *record.get("aliases", [])]:
            accepted_aliases[normalize_name(alias)] = material_id
    return merged, accepted_aliases


def search_saved_profiles(
    profiles: list[dict[str, Any]], query: str, kind: str = "all", limit: int = 8
) -> list[dict[str, Any]]:
    selected = [
        profile
        for profile in profiles
        if profile.get("status", "active") == "active"
        and (kind == "all" or profile.get("kind", "food") == kind)
    ]
    catalog = {
        "materials": {
            record["id"]: {
                **deepcopy(record["profile"]),
                "aliases": list(
                    dict.fromkeys(
                        [*record["profile"].get("aliases", []), *record.get("aliases", [])]
                    )
                ),
            }
            for record in selected
        }
    }
    by_id = {record["id"]: record for record in selected}
    results = []
    for match in search_materials(catalog, query, limit=limit):
        record = by_id[match["material_id"]]
        results.append(
            {
                "candidate_id": f"saved:{record['id']}:{record['version']}",
                "catalog": "saved",
                **match,
                "profile_version": record["version"],
                "identity_status": record["profile"].get("identity_status", "verified"),
                "has_composition_profile": True,
                "is_compound": bool(record["profile"].get("components")),
                "source": record["source"],
                "accepted_profile": True,
                "candidate_only": True,
            }
        )
    return results


class D1MaterialProfileRepository:
    """D1 adapter for the shared, immutable accepted ingredient library."""

    def __init__(self, database: Any, *, clock: Callable[[], str] = _default_clock) -> None:
        self.database = database
        self.clock = clock

    async def list_active(self) -> list[dict[str, Any]]:
        profiles_result = await self.database.prepare(
            "SELECT id, version, name, kind, status, supersedes_version, evidence_kind, "
            "source_json, profile_json, profile_fingerprint, retrieved_at, accepted_at "
            "FROM material_profiles WHERE status = 'active' ORDER BY name, accepted_at DESC"
        ).run()
        aliases_result = await self.database.prepare(
            "SELECT profile_id, profile_version, alias FROM material_profile_aliases "
            "ORDER BY normalized_alias"
        ).run()
        aliases: dict[tuple[str, str], list[str]] = {}
        for row in d1_results(aliases_result):
            aliases.setdefault((row["profile_id"], row["profile_version"]), []).append(row["alias"])
        records = []
        for row in d1_results(profiles_result):
            records.append(
                {
                    "id": row["id"],
                    "version": row["version"],
                    "name": row["name"],
                    "kind": row["kind"],
                    "status": row["status"],
                    "supersedes_version": row["supersedes_version"],
                    "aliases": aliases.get((row["id"], row["version"]), []),
                    "source": json.loads(row["source_json"]),
                    "profile": json.loads(row["profile_json"]),
                    "profile_fingerprint": row["profile_fingerprint"],
                    "retrieved_at": row["retrieved_at"],
                    "accepted_at": row["accepted_at"],
                }
            )
        return records

    async def save(
        self,
        *,
        material_id: str,
        material: dict[str, Any],
        submitted_alias: str,
        kind: str = "food",
    ) -> dict[str, Any]:
        current_result = await self.database.prepare(
            "SELECT version FROM material_profiles WHERE id = ?1 AND status = 'active' "
            "ORDER BY accepted_at DESC LIMIT 1"
        ).bind(material_id).run()
        current_rows = d1_results(current_result)
        current_version = current_rows[0]["version"] if current_rows else None
        record = material_profile_record(
            material_id=material_id,
            material=material,
            submitted_alias=submitted_alias,
            kind=kind,
            accepted_at=self.clock(),
            supersedes_version=current_version,
        )
        if current_version == record["version"]:
            existing = [item for item in await self.list_active() if item["id"] == material_id]
            return existing[0]

        statements = []
        if current_version:
            statements.append(
                self.database.prepare(
                    "UPDATE material_profiles SET status = 'superseded' "
                    "WHERE id = ?1 AND version = ?2 AND status = 'active'"
                ).bind(material_id, current_version)
            )
        statements.append(
            self.database.prepare(
                "INSERT INTO material_profiles "
                "(id, version, name, kind, status, supersedes_version, evidence_kind, "
                "source_json, profile_json, profile_fingerprint, retrieved_at, accepted_at) "
                "VALUES (?1, ?2, ?3, ?4, 'active', ?5, ?6, ?7, ?8, ?9, ?10, ?11)"
            ).bind(
                record["id"],
                record["version"],
                record["name"],
                record["kind"],
                record["supersedes_version"],
                record["source"].get("kind", "accepted_profile"),
                canonical_json(record["source"]),
                canonical_json(record["profile"]),
                record["profile_fingerprint"],
                record["source"].get("retrieved_at"),
                record["accepted_at"],
            )
        )
        for alias in record["aliases"]:
            statements.append(
                self.database.prepare(
                    "INSERT INTO material_profile_aliases "
                    "(profile_id, profile_version, alias, normalized_alias, created_at) "
                    "VALUES (?1, ?2, ?3, ?4, ?5)"
                ).bind(
                    record["id"],
                    record["version"],
                    alias,
                    normalize_name(alias),
                    record["accepted_at"],
                )
            )
        await self.database.batch(statements)
        return record

    async def deactivate(self, material_id: str, version: str) -> bool:
        result = await self.database.prepare(
            "UPDATE material_profiles SET status = 'inactive' "
            "WHERE id = ?1 AND version = ?2 AND status = 'active' RETURNING id"
        ).bind(material_id, version).run()
        return bool(d1_results(result))
