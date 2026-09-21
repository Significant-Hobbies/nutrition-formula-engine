from __future__ import annotations

import sqlite3
import unittest
from pathlib import Path

from nutrition_formula.material_profiles import (
    D1MaterialProfileRepository,
    material_profile_record,
    merge_material_profiles,
    search_saved_profiles,
)
from nutrition_formula.versioning import (
    D1FormulaRepository,
    FormulaAccessError,
    InMemoryFormulaRepository,
    VersionConflictError,
    fingerprint,
    profile_references,
    report_delta,
)

ROOT = Path(__file__).resolve().parents[1]


class FakeD1Result:
    def __init__(self, rows: list[dict]) -> None:
        self.results = rows


class FakeD1Statement:
    def __init__(self, database: FakeD1, sql: str, values: tuple = ()) -> None:
        self.database = database
        self.sql = sql
        self.values = values

    def bind(self, *values):
        return FakeD1Statement(self.database, self.sql, values)

    async def run(self):
        cursor = self.database.connection.execute(self.sql, self.values)
        rows = [dict(row) for row in cursor.fetchall()] if cursor.description else []
        return FakeD1Result(rows)


class FakeD1:
    def __init__(self) -> None:
        self.connection = sqlite3.connect(":memory:", isolation_level=None)
        self.connection.row_factory = sqlite3.Row
        self.connection.executescript(
            (ROOT / "migrations/0001_formula_history.sql").read_text(encoding="utf-8")
        )
        self.connection.executescript(
            (ROOT / "migrations/0002_shared_ingredient_library.sql").read_text(
                encoding="utf-8"
            )
        )
        self.connection.executescript(
            (ROOT / "migrations/0003_owner_scoped_persistence.sql").read_text(
                encoding="utf-8"
            )
        )
        self.connection.executescript(
            (ROOT / "migrations/0004_public_saved_formulas.sql").read_text(
                encoding="utf-8"
            )
        )

    def prepare(self, sql: str) -> FakeD1Statement:
        return FakeD1Statement(self, sql)

    async def batch(self, statements: list[FakeD1Statement]):
        results = []
        self.connection.execute("BEGIN")
        try:
            for statement in statements:
                results.append(await statement.run())
            self.connection.execute("COMMIT")
        except Exception:
            self.connection.execute("ROLLBACK")
            raise
        return results


def report(value: str = "1") -> dict:
    contribution = {
        "material_id": "ingredient_a",
        "material_name": "Ingredient A",
        "source": {"kind": "supplier_spec", "reference": "Spec A v1"},
    }
    return {
        "screened_components": [
            {
                "id": "protein",
                "name": "Protein",
                "value": value,
                "unit": "g",
                "contributions": [contribution],
            }
        ]
    }


class VersioningTests(unittest.IsolatedAsyncioTestCase):
    def repository(self) -> InMemoryFormulaRepository:
        ids = iter(["formula-1", "report-1", "report-2", "report-3"])
        times = iter(["2026-09-21T10:00:00Z", "2026-09-21T10:01:00Z", "2026-09-21T10:02:00Z"])
        return InMemoryFormulaRepository(
            id_factory=lambda: next(ids),
            token_factory=lambda: "private-token",
            clock=lambda: next(times),
        )

    def test_fingerprints_are_canonical(self) -> None:
        self.assertEqual(fingerprint({"b": 2, "a": 1}), fingerprint({"a": 1, "b": 2}))
        self.assertNotEqual(fingerprint({"a": "1"}), fingerprint({"a": 1}))

    def test_profile_references_are_deduplicated(self) -> None:
        payload = report()
        payload["screened_components"].append(
            {**payload["screened_components"][0], "id": "energy", "name": "Energy"}
        )
        self.assertEqual(len(profile_references(payload)), 1)

    def test_delta_reports_only_changed_components(self) -> None:
        self.assertEqual(
            report_delta(report("1"), report("1.25")),
            [
                {
                    "id": "protein",
                    "name": "Protein",
                    "before": "1",
                    "after": "1.25",
                    "change": "0.25",
                    "unit": "g",
                }
            ],
        )

    def test_versions_are_immutable_retrievable_and_restorable(self) -> None:
        repository = self.repository()
        created = repository.create(
            file_name="formula.tsv", contents="first", report=report("1")
        )
        updated = repository.append(
            formula_id=created["formula_id"],
            access_token=created["access_token"],
            expected_version=1,
            file_name="formula.tsv",
            contents="second",
            report=report("1.25"),
            cause="identity_replaced",
        )
        restored = repository.restore(
            formula_id=created["formula_id"],
            access_token=created["access_token"],
            expected_version=2,
            target_version=1,
        )

        self.assertEqual(updated["version"], 2)
        self.assertEqual(updated["delta"][0]["change"], "0.25")
        self.assertEqual(restored["version"], 3)
        self.assertEqual(restored["cause"], "restored_from_v1")
        self.assertEqual(restored["report"], created["report"])
        self.assertEqual(repository.history("formula-1", "private-token")["current_version"], 3)
        self.assertEqual(
            repository.get_version("formula-1", "private-token", 1)["normalized_input"]["contents"],
            "first",
        )

    def test_stale_version_and_invalid_token_fail_closed(self) -> None:
        repository = self.repository()
        created = repository.create(file_name="formula.tsv", contents="first", report=report())
        with self.assertRaises(VersionConflictError):
            repository.append(
                formula_id=created["formula_id"],
                access_token=created["access_token"],
                expected_version=4,
                file_name="formula.tsv",
                contents="second",
                report=report(),
                cause="edit",
            )
        with self.assertRaises(FormulaAccessError):
            repository.history(created["formula_id"], "wrong-token")

    async def test_d1_repository_replays_the_same_version_contract(self) -> None:
        ids = iter(
            [
                "formula-1",
                "report-1",
                "decision-1",
                "report-2",
                "report-3",
                "copied-decision-1",
                "restore-decision-1",
            ]
        )
        times = iter(["2026-09-21T10:00:00Z", "2026-09-21T10:01:00Z", "2026-09-21T10:02:00Z"])
        database = FakeD1()
        self.addCleanup(database.connection.close)
        repository = D1FormulaRepository(
            database,
            id_factory=lambda: next(ids),
            token_factory=lambda: "private-token",
            clock=lambda: next(times),
        )
        created = await repository.create(
            file_name="formula.tsv",
            contents="first",
            report=report("1"),
            decisions=[{"action": "confirm", "line_index": 1, "candidate_id": "local:a"}],
        )
        updated = await repository.append(
            formula_id=created["formula_id"],
            access_token=created["access_token"],
            expected_version=1,
            file_name="formula.tsv",
            contents="second",
            report=report("1.25"),
            cause="identity_replaced",
        )
        history = await repository.history("formula-1", "private-token")
        restored = await repository.restore(
            formula_id="formula-1",
            access_token="private-token",
            expected_version=2,
            target_version=1,
        )

        self.assertEqual(updated["delta"][0]["change"], "0.25")
        self.assertEqual(history["current_version"], 2)
        self.assertEqual([item["version"] for item in history["versions"]], [2, 1])
        self.assertEqual(restored["report"], created["report"])

    async def test_d1_formulas_are_isolated_by_sync_owner(self) -> None:
        database = FakeD1()
        self.addCleanup(database.connection.close)
        owner_a = D1FormulaRepository(
            database,
            owner_id="owner-a",
            id_factory=iter(["formula-a", "report-a"]).__next__,
            token_factory=lambda: "owner-a-token",
        )
        owner_b = D1FormulaRepository(database, owner_id="owner-b")

        created = await owner_a.create(
            file_name="owner-a.tsv",
            contents="ingredient\t1\tkg",
            report={
                **report(),
                "product_name": "Owner A formula",
                "product_inference": {"name": "Inferred owner A product"},
            },
        )

        workspaces = await owner_a.list_workspaces()
        self.assertEqual([item["formula_id"] for item in workspaces], [created["formula_id"]])
        self.assertEqual(workspaces[0]["product_name"], "Inferred owner A product")
        self.assertEqual(await owner_b.list_workspaces(), [])
        with self.assertRaises(FormulaAccessError):
            await owner_b.history(created["formula_id"], None)


class MaterialProfileTests(unittest.IsolatedAsyncioTestCase):
    def material(self) -> dict:
        return {
            "name": "Vitamin C specification",
            "aliases": ["Ascorbic acid"],
            "basis": {"value": "100", "unit": "g"},
            "nutrients": {"vitamin_c": {"value": "100000", "unit": "mg"}},
            "unlisted_nutrients_are_zero": True,
            "source": {"kind": "supplier_specification", "reference": "Supplier A v1"},
        }

    def test_profile_snapshot_is_deterministic_and_searchable(self) -> None:
        first = material_profile_record(
            material_id="vitamin_c_supplier_a",
            material=self.material(),
            submitted_alias="Trade C",
            accepted_at="2026-09-21T10:00:00Z",
        )
        second = material_profile_record(
            material_id="vitamin_c_supplier_a",
            material=self.material(),
            submitted_alias="Trade C",
            accepted_at="2026-09-22T10:00:00Z",
        )
        self.assertEqual(first["version"], second["version"])
        self.assertEqual(
            search_saved_profiles([first], "Trade C")[0]["profile_version"], first["version"]
        )

        catalog, aliases = merge_material_profiles({"materials": {}}, [first])
        self.assertIn("vitamin_c_supplier_a", catalog["materials"])
        self.assertEqual(aliases["trade c"], "vitamin_c_supplier_a")

    async def test_d1_profile_versions_supersede_without_overwriting_history(self) -> None:
        times = iter(["2026-09-21T10:00:00Z", "2026-09-21T10:01:00Z"])
        database = FakeD1()
        self.addCleanup(database.connection.close)
        repository = D1MaterialProfileRepository(database, clock=lambda: next(times))
        first = await repository.save(
            material_id="vitamin_c_supplier_a",
            material=self.material(),
            submitted_alias="Trade C",
        )
        revised_material = self.material()
        revised_material["nutrients"]["vitamin_c"]["value"] = "99000"
        second = await repository.save(
            material_id="vitamin_c_supplier_a",
            material=revised_material,
            submitted_alias="Trade C Plus",
        )

        self.assertNotEqual(first["version"], second["version"])
        self.assertEqual(second["supersedes_version"], first["version"])
        active = await repository.list_active()
        self.assertEqual([item["version"] for item in active], [second["version"]])
        statuses = database.connection.execute(
            "SELECT version, status FROM material_profiles ORDER BY accepted_at"
        ).fetchall()
        self.assertEqual(
            [tuple(row) for row in statuses],
            [(first["version"], "superseded"), (second["version"], "active")],
        )

        self.assertTrue(await repository.deactivate(second["id"], second["version"]))
        self.assertFalse(await repository.deactivate(second["id"], second["version"]))
        self.assertEqual(await repository.list_active(), [])

    async def test_d1_profiles_are_isolated_by_sync_owner(self) -> None:
        database = FakeD1()
        self.addCleanup(database.connection.close)
        owner_a = D1MaterialProfileRepository(database, owner_id="owner-a")
        owner_b = D1MaterialProfileRepository(database, owner_id="owner-b")
        first = await owner_a.save(
            material_id="vitamin_c_supplier_a",
            material=self.material(),
            submitted_alias="Owner A vitamin C",
        )
        second = await owner_b.save(
            material_id="vitamin_c_supplier_a",
            material=self.material(),
            submitted_alias="Owner B vitamin C",
        )

        self.assertNotEqual(first["version"], second["version"])
        self.assertEqual(
            [item["aliases"][1] for item in await owner_a.list_active()],
            ["Owner A vitamin C"],
        )
        self.assertEqual(
            [item["aliases"][1] for item in await owner_b.list_active()],
            ["Owner B vitamin C"],
        )


if __name__ == "__main__":
    unittest.main()
