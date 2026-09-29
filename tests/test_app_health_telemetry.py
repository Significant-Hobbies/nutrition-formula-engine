from __future__ import annotations

import asyncio
import json
import unittest

from nutrition_formula.app_health_telemetry import (
    INGEST_URL,
    build_batch,
    build_event,
    deliver_event,
    endpoint_template,
)


class FakeResponse:
    def __init__(self, status: int) -> None:
        self.status = status


class AppHealthTelemetryTests(unittest.TestCase):
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
