from __future__ import annotations

import asyncio
import json
import unittest
from unittest.mock import patch

from nutrition_formula.app_health_telemetry import (
    INGEST_URL,
    LOGS_URL,
    build_batch,
    build_event,
    build_stage_timing_event,
    deliver_event,
    endpoint_template,
    stage_sample_rate,
)


class FakeResponse:
    def __init__(self, status: int) -> None:
        self.status = status


class AppHealthTelemetryTests(unittest.TestCase):
    def test_stage_timing_shape_and_templates(self) -> None:
        event = build_stage_timing_event(
            "/api/formulas/private-id/versions/3", 201, 900_000,
            colo="SIN", cold=True, sample_rate="1",
        )
        assert event is not None
        self.assertEqual(set(event), {"log_id", "timestamp", "event", "level", "props"})
        self.assertEqual(event["event"], "api.stage_timing")
        self.assertEqual(event["level"], "debug")
        self.assertEqual(event["props"], {
            "route": "/api/formulas/:id/versions/:version", "status": 201,
            "total_ms": 600_000, "edge_cache": "NONE", "inner_cache": "NONE",
            "colo": "SIN", "cold": 1,
        })
        for path in ("/", "/api/unknown", "/api/formulas/id?token=secret"):
            self.assertIsNone(build_stage_timing_event(path, 200, 1, sample_rate="1"))
        for status, duration in ((99, 1), (600, 1), (True, 1), (200, -1), (200, float("nan")), (200, float("inf"))):
            self.assertIsNone(build_stage_timing_event("/api/health", status, duration, sample_rate="1"))

    def test_stage_colo_fallback_and_sampling(self) -> None:
        for colo in (None, "", "ABCDEFGHI", "S-IN", "ＳＩＮ", 123):
            event = build_stage_timing_event("/api/health", 200, 1, colo=colo, sample_rate="1")
            assert event is not None
            self.assertEqual(event["props"]["colo"], "unknown")
            self.assertEqual(event["props"]["cold"], 0)
        with patch("nutrition_formula.app_health_telemetry.random.random", return_value=0):
            self.assertIsNone(build_stage_timing_event("/api/health", 200, 1, sample_rate="0"))
            self.assertIsNotNone(build_stage_timing_event("/api/health", 200, 1, sample_rate="1"))
        for rate in (None, "bad", "", "nan", "inf", "-0.1", "1.1"):
            self.assertEqual(stage_sample_rate(rate), 0.1)
            with patch("nutrition_formula.app_health_telemetry.random.random", return_value=0.09):
                self.assertIsNotNone(build_stage_timing_event("/api/health", 200, 1, sample_rate=rate))
            with patch("nutrition_formula.app_health_telemetry.random.random", return_value=0.1):
                self.assertIsNone(build_stage_timing_event("/api/health", 200, 1, sample_rate=rate))

    def test_templates_only_allowlisted_api_routes_and_hide_identifiers(self) -> None:
        self.assertEqual(endpoint_template("/api/health"), "/api/health")
        self.assertEqual(
            endpoint_template("/api/formulas/private-formula-id/versions/3"),
            "/api/formulas/:id/versions/:version",
        )
        self.assertEqual(
            endpoint_template("/api/ingredients/supplier-alias/revision-8"),
            "/api/ingredients/:id/:id",
        )
        self.assertIsNone(endpoint_template("/api/formulas/private-formula-id?token=secret"))
        self.assertIsNone(endpoint_template("/api/formulas/private-formula-id/extra"))
        self.assertIsNone(endpoint_template("/"))

    def test_event_contains_only_bounded_summary_fields(self) -> None:
        event = build_event(
            "post",
            "/api/formulas/private-formula-id/restore",
            409,
            900_000,
            timestamp_ms=123,
        )
        self.assertIsNotNone(event)
        assert event is not None
        self.assertEqual(event["method"], "POST")
        self.assertEqual(event["route"], "/api/formulas/:id/restore")
        self.assertEqual(event["duration_ms"], 600_000)
        self.assertEqual(event["timestamp"], 123)
        self.assertEqual(
            set(event),
            {"event_id", "timestamp", "method", "route", "status_code", "duration_ms"},
        )
        self.assertIsNone(build_event("BAD METHOD", "/api/health", 200, 1))
        self.assertIsNone(build_event("GET", "/api/health", 700, 1))

    def test_batch_matches_worker_ingest_contract(self) -> None:
        event = build_event("GET", "/api/health", 200, 4, timestamp_ms=456)
        assert event is not None
        batch = build_batch(event, "production")
        self.assertEqual(batch["schema_version"], "v1")
        self.assertEqual(batch["runtime"], "worker")
        self.assertEqual(batch["environment"], "production")
        self.assertEqual(batch["events"], [event])
        json.dumps(batch)


class AppHealthDeliveryTests(unittest.IsolatedAsyncioTestCase):
    async def test_log_delivery_uses_same_key_and_log_batch_contract(self) -> None:
        event = build_stage_timing_event("/api/health", 200, 4, sample_rate="1")
        captured = []

        async def fetch(url, **options):
            captured.append((url, options))
            return FakeResponse(202)

        self.assertTrue(await deliver_event(event, "test-key", fetch, "production", is_log=True))
        self.assertEqual(len(captured), 1)
        url, options = captured[0]
        self.assertEqual(url, LOGS_URL)
        self.assertEqual(options["method"], "POST")
        self.assertEqual(options["headers"], {"content-type": "application/json", "authorization": "Bearer test-key"})
        self.assertEqual(json.loads(options["body"]), {"schema_version": "v1", "environment": "production", "logs": [event]})
        self.assertFalse(await deliver_event(event, "", fetch, is_log=True))
        self.assertEqual(len(captured), 1)

    async def test_delivery_is_bearer_authenticated_and_fails_open(self) -> None:
        event = build_event("GET", "/api/health", 200, 4, timestamp_ms=456)
        assert event is not None
        captured: dict = {}

        async def fetch(url: str, **options):
            captured["url"] = url
            captured["options"] = options
            return FakeResponse(202)

        self.assertTrue(await deliver_event(event, "test-key", fetch, "production"))
        self.assertEqual(captured["url"], INGEST_URL)
        self.assertEqual(captured["options"]["method"], "POST")
        self.assertEqual(
            captured["options"]["headers"]["authorization"], "Bearer test-key"
        )
        payload = json.loads(captured["options"]["body"])
        self.assertEqual(payload["events"], [event])

        async def failing_fetch(url: str, **options):
            raise OSError("offline")

        self.assertFalse(await deliver_event(event, "test-key", failing_fetch))

        async def rejected_fetch(url: str, **options):
            return FakeResponse(401)

        self.assertFalse(await deliver_event(event, "test-key", rejected_fetch))
        self.assertFalse(await deliver_event(event, "", fetch))

    async def test_delivery_timeout_fails_open(self) -> None:
        event = build_event("GET", "/api/health", 200, 4, timestamp_ms=456)
        assert event is not None

        async def slow_fetch(url: str, **options):
            await asyncio.sleep(0.05)
            return FakeResponse(202)

        self.assertFalse(
            await deliver_event(event, "test-key", slow_fetch, timeout_seconds=0.001)
        )


if __name__ == "__main__":
    unittest.main()
