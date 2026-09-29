"""Privacy-bounded endpoint summaries for the optional App Health ingest."""

from __future__ import annotations

import asyncio
import json
import math
import re
import time
import uuid
from collections.abc import Awaitable, Callable

INGEST_URL = "https://ingest.sassmaker.com/v1/ingest"
MAX_DURATION_MS = 600_000

_DYNAMIC_API_ROUTES = (
    (re.compile(r"/api/ingredients/[^/]+/[^/]+\Z"), "/api/ingredients/:id/:id"),
    (re.compile(r"/api/formulas/[^/]+/versions/\d+\Z"), "/api/formulas/:id/versions/:version"),
    (re.compile(r"/api/formulas/[^/]+/versions\Z"), "/api/formulas/:id/versions"),
    (re.compile(r"/api/formulas/[^/]+/restore\Z"), "/api/formulas/:id/restore"),
    (re.compile(r"/api/formulas/[^/]+\Z"), "/api/formulas/:id"),
)
_STATIC_API_ROUTES = {
    "/api/health",
    "/api/ingredients",
    "/api/ingredients/search",
    "/api/formulas",
    "/api/analyze",
}


def endpoint_template(path: str) -> str | None:
    """Return an allowlisted route template without copying user path values."""
    if "?" in path or "#" in path:
        return None
    if path in _STATIC_API_ROUTES:
        return path
    for pattern, template in _DYNAMIC_API_ROUTES:
        if pattern.fullmatch(path):
            return template
    return None


def build_event(
    method: str,
    path: str,
    status_code: int,
    duration_ms: float,
    *,
    timestamp_ms: int | None = None,
) -> dict[str, str | int] | None:
    route = endpoint_template(path)
    normalized_method = method.strip().upper()
    if route is None or not re.fullmatch(r"[A-Z]{1,16}", normalized_method):
        return None
    if not isinstance(status_code, int) or not 100 <= status_code <= 599:
        return None
    if (
        not isinstance(duration_ms, (int, float))
        or not math.isfinite(duration_ms)
        or duration_ms < 0
    ):
        return None
    bounded_duration = min(MAX_DURATION_MS, round(duration_ms))
    return {
        "event_id": str(uuid.uuid4()),
        "timestamp": timestamp_ms if timestamp_ms is not None else time.time_ns() // 1_000_000,
        "method": normalized_method,
        "route": route,
        "status_code": status_code,
        "duration_ms": bounded_duration,
    }


def build_batch(event: dict[str, str | int], environment: str | None = None) -> dict:
    batch = {
        "batch_id": str(uuid.uuid4()),
        "schema_version": "v1",
        "runtime": "worker",
        "events": [event],
    }
    if (
        isinstance(environment, str)
        and len(environment) <= 64
        and re.fullmatch(r"[a-z][a-z0-9-]*", environment.strip().lower())
    ):
        environment = environment.strip().lower()
        batch["environment"] = environment
    return batch


Fetch = Callable[..., Awaitable[object]]


async def deliver_event(
    event: dict[str, str | int],
    key: str,
    fetch: Fetch,
    environment: str | None = None,
    timeout_seconds: float = 1.5,
) -> bool:
    """Send one summary; network, timeout, and response failures never escape."""
    if not key:
        return False
    try:
        response = await asyncio.wait_for(
            fetch(
                INGEST_URL,
                method="POST",
                headers={
                    "content-type": "application/json",
                    "authorization": f"Bearer {key}",
                },
                body=json.dumps(build_batch(event, environment), separators=(",", ":")),
            ),
            timeout=timeout_seconds,
        )
        return 200 <= response.status < 300
    except Exception:  # noqa: BLE001 - delivery is best-effort and must fail open.
        return False
