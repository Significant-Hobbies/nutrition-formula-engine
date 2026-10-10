from __future__ import annotations

import importlib.util
import sys
import types
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]


class Request:
    def __init__(self, method: str, path: str, body: object | None = None) -> None:
        self.method = types.SimpleNamespace(value=method)
        self.url = f"https://formula.example{path}"
        self.headers = {"content-length": "0"}
        self._body = body

    async def json(self) -> object:
        return self._body


class Response:
    @staticmethod
    def json(data: object, status: int = 200, headers: dict[str, str] | None = None):
        headers = headers or {}
        return types.SimpleNamespace(
            data=data, status=status, headers=headers,
            js_object=types.SimpleNamespace(headers=types.SimpleNamespace(set=headers.__setitem__)),
        )


def load_worker_module():
    js = types.ModuleType("js")
    js.console = types.SimpleNamespace(log=lambda *_args: None, error=lambda *_args: None)
    pyodide = types.ModuleType("pyodide")
    pyodide_ffi = types.ModuleType("pyodide.ffi")
    pyodide_ffi.create_proxy = lambda value: value
    workers = types.ModuleType("workers")

    class WorkerEntrypoint:
        pass

    workers.Response = Response
    workers.WorkerEntrypoint = WorkerEntrypoint
    workers.fetch = lambda *_args, **_kwargs: None
    module_name = "nutrition_formula_test_worker"
    spec = importlib.util.spec_from_file_location(module_name, ROOT / "src" / "worker.py")
    if spec is None or spec.loader is None:
        raise RuntimeError("Could not load worker module")
    module = importlib.util.module_from_spec(spec)
    with patch.dict(
        sys.modules,
        {
            "js": js,
            "pyodide": pyodide,
            "pyodide.ffi": pyodide_ffi,
            "workers": workers,
        },
    ):
        spec.loader.exec_module(module)
    return module


class FormulaWorkerRouteTests(unittest.IsolatedAsyncioTestCase):
    async def test_timing_preserves_api_response_and_leaves_assets_unchanged(self) -> None:
        module = load_worker_module()
        worker = module.Default()
        worker.env = types.SimpleNamespace()
        with patch.object(module.time, "perf_counter", side_effect=[10, 10.025, 10.025]):
            result = await worker.fetch(Request("GET", "/api/health"))
        self.assertEqual(result.status, 200)
        self.assertEqual(result.data, {"status": "ok", "persistence": "unconfigured"})
        self.assertEqual(result.headers, {"Cache-Control": "no-store", "Server-Timing": "total;dur=25"})

        asset = types.SimpleNamespace(status=200, headers={"Content-Type": "text/html"})
        async def fetch_asset(_request):
            return asset
        worker.env.ASSETS = types.SimpleNamespace(fetch=fetch_asset)
        self.assertIs(await worker.fetch(Request("GET", "/")), asset)
        self.assertEqual(asset.headers, {"Content-Type": "text/html"})

    async def test_stage_logs_scheduled_once_per_sampled_request_with_cold_flag(self) -> None:
        module = load_worker_module()
        worker = module.Default()
        worker.env = types.SimpleNamespace(APP_HEALTH_INGEST_KEY="test-key", APP_HEALTH_STAGE_SAMPLE_RATE="1")
        scheduled = []
        with patch.object(worker, "_schedule_app_health", side_effect=lambda event, **kwargs: scheduled.append((event, kwargs))):
            request = Request("GET", "/api/health")
            request.cf = types.SimpleNamespace(colo="SIN")
            await worker.fetch(request)
            await worker.fetch(request)
            worker.env.APP_HEALTH_STAGE_SAMPLE_RATE = "0"
            await worker.fetch(request)
            worker.env.APP_HEALTH_STAGE_SAMPLE_RATE = "1"
            worker.env.APP_HEALTH_INGEST_KEY = ""
            await worker.fetch(request)
        logs = [event for event, options in scheduled if options.get("is_log")]
        self.assertEqual(len(logs), 2)
        self.assertEqual([event["props"]["cold"] for event in logs], [1, 0])
        self.assertEqual([event["props"]["colo"] for event in logs], ["SIN", "SIN"])

    async def test_stage_construction_failure_preserves_response(self) -> None:
        module = load_worker_module()
        worker = module.Default()
        worker.env = types.SimpleNamespace(APP_HEALTH_INGEST_KEY="test-key")
        with (
            patch.object(module, "build_stage_timing_event", side_effect=RuntimeError("telemetry")),
            patch.object(worker, "_schedule_app_health"),
        ):
            result = await worker.fetch(Request("GET", "/api/health"))
        self.assertEqual(result.status, 200)
        self.assertEqual(result.data["status"], "ok")

    async def test_formula_list_does_not_read_unused_material_profiles(self) -> None:
        module = load_worker_module()
        calls = {"workspaces": 0, "profiles": 0}

        class FormulaRepository:
            def __init__(self, *_args, **_kwargs) -> None:
                pass

            async def list_workspaces(self):
                calls["workspaces"] += 1
                return [{"formula_id": "one"}]

        class MaterialProfiles:
            def __init__(self, *_args, **_kwargs) -> None:
                pass

            async def list_active(self):
                calls["profiles"] += 1
                raise AssertionError("formula listing does not consume material profiles")

        with (
            patch.object(module, "D1FormulaRepository", FormulaRepository),
            patch.object(module, "D1MaterialProfileRepository", MaterialProfiles),
        ):
            worker = module.Default()
            worker.env = types.SimpleNamespace(FORMULA_DB=object())
            result = await worker.fetch(Request("GET", "/api/formulas"))

        self.assertEqual(result.data, {"workspaces": [{"formula_id": "one"}]})
        self.assertEqual(result.status, 200)
        self.assertEqual(calls, {"workspaces": 1, "profiles": 0})

    async def test_formula_history_version_and_restore_do_not_read_profiles(self) -> None:
        module = load_worker_module()
        calls = {"profiles": 0}

        class FormulaRepository:
            def __init__(self, *_args, **_kwargs) -> None:
                pass

            async def history(self, *_args):
                return {"history": []}

            async def get_version(self, *_args):
                return {"version": 1}

            async def restore(self, **_kwargs):
                return {"report": {"restored": True}, "version": 2}

        class MaterialProfiles:
            def __init__(self, *_args, **_kwargs) -> None:
                pass

            async def list_active(self):
                calls["profiles"] += 1
                raise AssertionError("history and restore do not consume material profiles")

        requests = [
            (Request("GET", "/api/formulas/formula-1"), {"history": []}),
            (Request("GET", "/api/formulas/formula-1/versions/1"), {"version": 1}),
            (
                Request(
                    "POST",
                    "/api/formulas/formula-1/restore",
                    {"expected_version": 1, "target_version": 1},
                ),
                {
                    "report": {"restored": True},
                    "version": {"report": {"restored": True}, "version": 2},
                },
            ),
        ]

        with (
            patch.object(module, "D1FormulaRepository", FormulaRepository),
            patch.object(module, "D1MaterialProfileRepository", MaterialProfiles),
        ):
            for request, expected in requests:
                worker = module.Default()
                worker.env = types.SimpleNamespace(FORMULA_DB=object())
                result = await worker.fetch(request)
                self.assertEqual(result.status, 200)
                self.assertEqual(result.data, expected)

        self.assertEqual(calls["profiles"], 0)

    async def test_formula_create_still_loads_profiles_for_analysis(self) -> None:
        module = load_worker_module()
        active_profiles = [{"id": "accepted-profile"}]
        received_profiles: list[object] = []

        class FormulaRepository:
            def __init__(self, *_args, **_kwargs) -> None:
                pass

            async def create(self, **_kwargs):
                return {"version": 1, "access_token": "discarded"}

        class MaterialProfiles:
            def __init__(self, *_args, **_kwargs) -> None:
                pass

            async def list_active(self):
                return active_profiles

        def analyze(_contents, _file_name, *, accepted_profiles, accepted_aliases):
            received_profiles.extend(accepted_profiles)
            return {"formula_rows": [{}]}

        with (
            patch.object(module, "D1FormulaRepository", FormulaRepository),
            patch.object(module, "D1MaterialProfileRepository", MaterialProfiles),
            patch.object(module, "analyze_formula_upload", analyze),
        ):
            worker = module.Default()
            worker.env = types.SimpleNamespace(FORMULA_DB=object())
            result = await worker.fetch(
                Request(
                    "POST",
                    "/api/formulas",
                    {"file_name": "batch.tsv", "contents": "reviewed rows"},
                )
            )

        self.assertEqual(result.status, 201)
        self.assertEqual(received_profiles, active_profiles)

    async def test_formula_append_still_loads_profiles_for_analysis(self) -> None:
        module = load_worker_module()
        active_profiles = [{"id": "accepted-profile"}]
        received_profiles: list[object] = []

        class FormulaRepository:
            def __init__(self, *_args, **_kwargs) -> None:
                pass

            async def append(self, **_kwargs):
                return {"version": 2}

        class MaterialProfiles:
            def __init__(self, *_args, **_kwargs) -> None:
                pass

            async def list_active(self):
                return active_profiles

        def analyze(_contents, _file_name, *, accepted_profiles, accepted_aliases):
            received_profiles.extend(accepted_profiles)
            return {"formula_rows": [{}]}

        with (
            patch.object(module, "D1FormulaRepository", FormulaRepository),
            patch.object(module, "D1MaterialProfileRepository", MaterialProfiles),
            patch.object(module, "analyze_formula_upload", analyze),
        ):
            worker = module.Default()
            worker.env = types.SimpleNamespace(FORMULA_DB=object())
            result = await worker.fetch(
                Request(
                    "POST",
                    "/api/formulas/formula-1/versions",
                    {
                        "file_name": "batch.tsv",
                        "contents": "reviewed rows",
                        "expected_version": 1,
                        "cause": "identity_replaced",
                        "decisions": [],
                    },
                )
            )

        self.assertEqual(result.status, 200)
        self.assertEqual(received_profiles, active_profiles)


if __name__ == "__main__":
    unittest.main()
