"""Immutable formula/report version records and persistence adapters."""

from __future__ import annotations

import hashlib
import hmac
import json
import secrets
import uuid
from collections.abc import Callable
from copy import deepcopy
from datetime import UTC, datetime
from decimal import Decimal
from typing import Any

ENGINE_VERSION = "2.0.0-pilot"


class VersionConflictError(ValueError):
    """Raised when a caller tries to append from a stale formula version."""


class FormulaAccessError(ValueError):
    """Raised when a formula or its access token cannot be verified."""


def canonical_json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), sort_keys=True)


def fingerprint(value: Any) -> str:
    payload = value if isinstance(value, str) else canonical_json(value)
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def access_token_hash(token: str) -> str:
    return fingerprint(f"formula-access:{token}")


def profile_references(report: dict[str, Any]) -> list[dict[str, Any]]:
    """Return the distinct material/source records that affected a report."""

    references: dict[tuple[str, str], dict[str, Any]] = {}
    for component in report.get("screened_components", []):
        for contribution in component.get("contributions", []):
            material_id = str(contribution["material_id"])
            source = contribution.get("source", {})
            source_key = canonical_json(source)
            references[(material_id, source_key)] = {
                "material_id": material_id,
                "material_name": contribution["material_name"],
                "source": source,
            }
    return sorted(references.values(), key=lambda item: (item["material_id"], canonical_json(item)))


def report_delta(previous: dict[str, Any] | None, current: dict[str, Any]) -> list[dict[str, Any]]:
    if previous is None:
        return []
    old = {item["id"]: item for item in previous.get("screened_components", [])}
    new = {item["id"]: item for item in current.get("screened_components", [])}
    changes = []
    for component_id in sorted(old.keys() | new.keys()):
        before = old.get(component_id)
        after = new.get(component_id)
        before_value = Decimal(before["value"]) if before else Decimal(0)
        after_value = Decimal(after["value"]) if after else Decimal(0)
        if before_value == after_value and (before or {}).get("unit") == (after or {}).get("unit"):
            continue
        changes.append(
            {
                "id": component_id,
                "name": (after or before)["name"],
                "before": str(before_value),
                "after": str(after_value),
                "change": str(after_value - before_value),
                "unit": (after or before)["unit"],
            }
        )
    return changes


def _default_clock() -> str:
    return datetime.now(UTC).isoformat().replace("+00:00", "Z")


def _default_id() -> str:
    return str(uuid.uuid4())


def _default_token() -> str:
    return secrets.token_urlsafe(32)


def _version_record(
    *,
    formula_id: str,
    version: int,
    report_id: str,
    created_at: str,
    cause: str,
    file_name: str,
    contents: str,
    report: dict[str, Any],
    decisions: list[dict[str, Any]],
    previous_report: dict[str, Any] | None,
) -> dict[str, Any]:
    normalized_input = {"file_name": file_name, "contents": contents}
    report_payload = deepcopy(report)
    return {
        "formula_id": formula_id,
        "version": version,
        "report_id": report_id,
        "created_at": created_at,
        "cause": cause,
        "engine_version": ENGINE_VERSION,
        "input_fingerprint": fingerprint(normalized_input),
        "report_fingerprint": fingerprint(report_payload),
        "normalized_input": normalized_input,
        "decisions": deepcopy(decisions),
        "profile_references": profile_references(report_payload),
        "delta": report_delta(previous_report, report_payload),
        "report": report_payload,
    }


class InMemoryFormulaRepository:
    """Deterministic repository used by tests and non-Worker callers."""

    def __init__(
        self,
        *,
        clock: Callable[[], str] = _default_clock,
        id_factory: Callable[[], str] = _default_id,
        token_factory: Callable[[], str] = _default_token,
    ) -> None:
        self._clock = clock
        self._id_factory = id_factory
        self._token_factory = token_factory
        self._formulas: dict[str, dict[str, Any]] = {}

    def _authorized(self, formula_id: str, access_token: str) -> dict[str, Any]:
        formula = self._formulas.get(formula_id)
        if formula is None or not hmac.compare_digest(
            formula["access_token_hash"], access_token_hash(access_token)
        ):
            raise FormulaAccessError("Formula not found or access token is invalid")
        return formula

    def create(
        self,
        *,
        file_name: str,
        contents: str,
        report: dict[str, Any],
        decisions: list[dict[str, Any]] | None = None,
    ) -> dict[str, Any]:
        formula_id = self._id_factory()
        access_token = self._token_factory()
        created_at = self._clock()
        record = _version_record(
            formula_id=formula_id,
            version=1,
            report_id=self._id_factory(),
            created_at=created_at,
            cause="created",
            file_name=file_name,
            contents=contents,
            report=report,
            decisions=decisions or [],
            previous_report=None,
        )
        self._formulas[formula_id] = {
            "id": formula_id,
            "created_at": created_at,
            "current_version": 1,
            "access_token_hash": access_token_hash(access_token),
            "versions": [record],
        }
        return {**deepcopy(record), "access_token": access_token}

    def append(
        self,
        *,
        formula_id: str,
        access_token: str,
        expected_version: int,
        file_name: str,
        contents: str,
        report: dict[str, Any],
        cause: str,
        decisions: list[dict[str, Any]] | None = None,
    ) -> dict[str, Any]:
        formula = self._authorized(formula_id, access_token)
        if formula["current_version"] != expected_version:
            raise VersionConflictError(
                f"Expected formula version {expected_version}; current version is "
                f"{formula['current_version']}"
            )
        previous = formula["versions"][-1]
        version = expected_version + 1
        record = _version_record(
            formula_id=formula_id,
            version=version,
            report_id=self._id_factory(),
            created_at=self._clock(),
            cause=cause,
            file_name=file_name,
            contents=contents,
            report=report,
            decisions=decisions or [],
            previous_report=previous["report"],
        )
        formula["versions"].append(record)
        formula["current_version"] = version
        return deepcopy(record)

    def history(self, formula_id: str, access_token: str) -> dict[str, Any]:
        formula = self._authorized(formula_id, access_token)
        return {
            "formula_id": formula_id,
            "created_at": formula["created_at"],
            "current_version": formula["current_version"],
            "versions": [
                {key: item[key] for key in (
                    "version",
                    "report_id",
                    "created_at",
                    "cause",
                    "engine_version",
                    "input_fingerprint",
                    "report_fingerprint",
                    "delta",
                )}
                for item in reversed(formula["versions"])
            ],
        }

    def get_version(self, formula_id: str, access_token: str, version: int) -> dict[str, Any]:
        formula = self._authorized(formula_id, access_token)
        for record in formula["versions"]:
            if record["version"] == version:
                return deepcopy(record)
        raise FormulaAccessError("Formula version not found")

    def restore(
        self,
        *,
        formula_id: str,
        access_token: str,
        expected_version: int,
        target_version: int,
    ) -> dict[str, Any]:
        target = self.get_version(formula_id, access_token, target_version)
        return self.append(
            formula_id=formula_id,
            access_token=access_token,
            expected_version=expected_version,
            file_name=target["normalized_input"]["file_name"],
            contents=target["normalized_input"]["contents"],
            report=target["report"],
            cause=f"restored_from_v{target_version}",
            decisions=target["decisions"],
        )


def d1_results(result: Any) -> list[dict[str, Any]]:
    rows = result.results
    if hasattr(rows, "to_py"):
        rows = rows.to_py()
    return list(rows)


class D1FormulaRepository:
    """Cloudflare D1 adapter. Schema is owned by migrations/0001_formula_history.sql."""

    def __init__(
        self,
        database: Any,
        *,
        owner_id: str = "legacy",
        clock: Callable[[], str] = _default_clock,
        id_factory: Callable[[], str] = _default_id,
        token_factory: Callable[[], str] = _default_token,
    ) -> None:
        self.database = database
        self.owner_id = owner_id
        self.clock = clock
        self.id_factory = id_factory
        self.token_factory = token_factory

    async def _formula(self, formula_id: str, access_token: str | None = None) -> dict[str, Any]:
        result = await self.database.prepare(
            "SELECT id, created_at, current_version, access_token_hash "
            "FROM formulas WHERE id = ?1 AND owner_id = ?2"
        ).bind(formula_id, self.owner_id).run()
        rows = d1_results(result)
        if not rows:
            raise FormulaAccessError("Formula not found or access token is invalid")
        if access_token is None:
            if self.owner_id == "legacy":
                raise FormulaAccessError("Formula not found or access token is invalid")
        elif not hmac.compare_digest(
            rows[0]["access_token_hash"], access_token_hash(access_token)
        ):
            raise FormulaAccessError("Formula not found or access token is invalid")
        return rows[0]

    async def list_workspaces(self) -> list[dict[str, Any]]:
        result = await self.database.prepare(
            "SELECT f.id, f.created_at, f.current_version, v.normalized_input_json, "
            "r.report_json FROM formulas f "
            "JOIN formula_versions v ON v.formula_id = f.id AND v.version = f.current_version "
            "JOIN reports r ON r.id = v.report_id "
            "WHERE f.owner_id = ?1 ORDER BY f.created_at DESC LIMIT 100"
        ).bind(self.owner_id).run()
        workspaces = []
        for row in d1_results(result):
            normalized_input = json.loads(row["normalized_input_json"])
            report = json.loads(row["report_json"])
            workspaces.append(
                {
                    "formula_id": row["id"],
                    "created_at": row["created_at"],
                    "current_version": int(row["current_version"]),
                    "file_name": normalized_input["file_name"],
                    "product_name": report.get("product_name", "Saved formula"),
                }
            )
        return workspaces

    async def create(
        self,
        *,
        file_name: str,
        contents: str,
        report: dict[str, Any],
        decisions: list[dict[str, Any]] | None = None,
    ) -> dict[str, Any]:
        formula_id = self.id_factory()
        report_id = self.id_factory()
        access_token = self.token_factory()
        created_at = self.clock()
        record = _version_record(
            formula_id=formula_id,
            version=1,
            report_id=report_id,
            created_at=created_at,
            cause="created",
            file_name=file_name,
            contents=contents,
            report=report,
            decisions=decisions or [],
            previous_report=None,
        )
        statements = [
                self.database.prepare(
                    "INSERT INTO formulas "
                    "(id, created_at, current_version, access_token_hash, owner_id) "
                    "VALUES (?1, ?2, 1, ?3, ?4)"
                ).bind(formula_id, created_at, access_token_hash(access_token), self.owner_id),
                self.database.prepare(
                    "INSERT INTO formula_versions "
                    "(formula_id, version, report_id, created_at, cause, input_fingerprint, "
                    "normalized_input_json, decisions_json, profile_refs_json) "
                    "VALUES (?1, 1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)"
                ).bind(
                    formula_id,
                    report_id,
                    created_at,
                    record["cause"],
                    record["input_fingerprint"],
                    canonical_json(record["normalized_input"]),
                    canonical_json(record["decisions"]),
                    canonical_json(record["profile_references"]),
                ),
                self.database.prepare(
                    "INSERT INTO reports "
                    "(id, formula_id, formula_version, created_at, engine_version, "
                    "report_fingerprint, report_json) VALUES (?1, ?2, 1, ?3, ?4, ?5, ?6)"
                ).bind(
                    report_id,
                    formula_id,
                    created_at,
                    ENGINE_VERSION,
                    record["report_fingerprint"],
                    canonical_json(record["report"]),
                ),
            ]
        statements.extend(self._decision_statements(record))
        await self.database.batch(statements)
        return {**record, "access_token": access_token}

    def _decision_statements(self, record: dict[str, Any]) -> list[Any]:
        statements = []
        for decision in record["decisions"]:
            action = str(decision.get("action", "confirm"))
            if action not in {"confirm", "reject", "replace", "remove", "restore"}:
                raise ValueError(f"Unsupported identity decision action {action!r}")
            statements.append(
                self.database.prepare(
                    "INSERT INTO identity_decisions "
                    "(id, formula_id, formula_version, line_index, action, candidate_id, "
                    "decision_json, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)"
                ).bind(
                    self.id_factory(),
                    record["formula_id"],
                    record["version"],
                    int(decision.get("line_index", 0)),
                    action,
                    decision.get("candidate_id"),
                    canonical_json(decision),
                    record["created_at"],
                )
            )
        return statements

    async def append(
        self,
        *,
        formula_id: str,
        access_token: str | None,
        expected_version: int,
        file_name: str,
        contents: str,
        report: dict[str, Any],
        cause: str,
        decisions: list[dict[str, Any]] | None = None,
    ) -> dict[str, Any]:
        formula = await self._formula(formula_id, access_token)
        if int(formula["current_version"]) != expected_version:
            raise VersionConflictError(
                f"Expected formula version {expected_version}; current version is "
                f"{formula['current_version']}"
            )
        previous = await self.get_version(formula_id, access_token, expected_version)
        version = expected_version + 1
        report_id = self.id_factory()
        created_at = self.clock()
        record = _version_record(
            formula_id=formula_id,
            version=version,
            report_id=report_id,
            created_at=created_at,
            cause=cause,
            file_name=file_name,
            contents=contents,
            report=report,
            decisions=decisions or [],
            previous_report=previous["report"],
        )
        statements = [
            self.database.prepare(
                "INSERT INTO formula_versions "
                "(formula_id, version, report_id, created_at, cause, input_fingerprint, "
                "normalized_input_json, decisions_json, profile_refs_json) "
                "VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)"
            ).bind(
                formula_id,
                version,
                report_id,
                created_at,
                cause,
                record["input_fingerprint"],
                canonical_json(record["normalized_input"]),
                canonical_json(record["decisions"]),
                canonical_json(record["profile_references"]),
            ),
            self.database.prepare(
                "INSERT INTO reports "
                "(id, formula_id, formula_version, created_at, engine_version, "
                "report_fingerprint, report_json) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)"
            ).bind(
                report_id,
                formula_id,
                version,
                created_at,
                ENGINE_VERSION,
                record["report_fingerprint"],
                canonical_json(record["report"]),
            ),
            self.database.prepare(
                "UPDATE formulas SET current_version = ?1 "
                "WHERE id = ?2 AND current_version = ?3"
            ).bind(version, formula_id, expected_version),
        ]
        statements.extend(self._decision_statements(record))
        try:
            await self.database.batch(statements)
        except Exception as exc:
            raise VersionConflictError(
                "The formula changed while this version was being saved; reload history and retry"
            ) from exc
        return record

    async def get_version(
        self, formula_id: str, access_token: str | None, version: int
    ) -> dict[str, Any]:
        await self._formula(formula_id, access_token)
        result = await self.database.prepare(
            "SELECT v.version, v.report_id, v.created_at, v.cause, v.input_fingerprint, "
            "v.normalized_input_json, v.decisions_json, v.profile_refs_json, "
            "r.engine_version, r.report_fingerprint, r.report_json "
            "FROM formula_versions v JOIN reports r ON r.id = v.report_id "
            "WHERE v.formula_id = ?1 AND v.version = ?2"
        ).bind(formula_id, version).run()
        rows = d1_results(result)
        if not rows:
            raise FormulaAccessError("Formula version not found")
        row = rows[0]
        return {
            "formula_id": formula_id,
            "version": int(row["version"]),
            "report_id": row["report_id"],
            "created_at": row["created_at"],
            "cause": row["cause"],
            "engine_version": row["engine_version"],
            "input_fingerprint": row["input_fingerprint"],
            "report_fingerprint": row["report_fingerprint"],
            "normalized_input": json.loads(row["normalized_input_json"]),
            "decisions": json.loads(row["decisions_json"]),
            "profile_references": json.loads(row["profile_refs_json"]),
            "delta": [],
            "report": json.loads(row["report_json"]),
        }

    async def history(self, formula_id: str, access_token: str | None) -> dict[str, Any]:
        formula = await self._formula(formula_id, access_token)
        result = await self.database.prepare(
            "SELECT v.version, v.report_id, v.created_at, v.cause, v.input_fingerprint, "
            "r.engine_version, r.report_fingerprint, r.report_json "
            "FROM formula_versions v JOIN reports r ON r.id = v.report_id "
            "WHERE v.formula_id = ?1 ORDER BY v.version ASC"
        ).bind(formula_id).run()
        versions = []
        previous_report = None
        for row in d1_results(result):
            current_report = json.loads(row["report_json"])
            versions.append(
                {
                    "version": int(row["version"]),
                    "report_id": row["report_id"],
                    "created_at": row["created_at"],
                    "cause": row["cause"],
                    "engine_version": row["engine_version"],
                    "input_fingerprint": row["input_fingerprint"],
                    "report_fingerprint": row["report_fingerprint"],
                    "delta": report_delta(previous_report, current_report),
                }
            )
            previous_report = current_report
        return {
            "formula_id": formula_id,
            "created_at": formula["created_at"],
            "current_version": int(formula["current_version"]),
            "versions": list(reversed(versions)),
        }

    async def restore(
        self,
        *,
        formula_id: str,
        access_token: str | None,
        expected_version: int,
        target_version: int,
    ) -> dict[str, Any]:
        target = await self.get_version(formula_id, access_token, target_version)
        return await self.append(
            formula_id=formula_id,
            access_token=access_token,
            expected_version=expected_version,
            file_name=target["normalized_input"]["file_name"],
            contents=target["normalized_input"]["contents"],
            report=target["report"],
            cause=f"restored_from_v{target_version}",
            decisions=[*target["decisions"], {"action": "restore", "line_index": 0}],
        )
