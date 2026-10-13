"""Cloudflare Python Worker entrypoint for local formula analysis."""

from __future__ import annotations

import asyncio
import json
import re
import time
import uuid
from urllib.parse import parse_qs, urlparse, quote

from js import console
from pyodide.ffi import create_proxy
from workers import Response, WorkerEntrypoint
from workers import fetch as worker_fetch

from nutrition_formula.app_health_telemetry import build_event, build_stage_timing_event, deliver_event
from nutrition_formula.http_api import (
    PUBLIC_OWNER_ID,
    validate_accepted_aliases,
    validate_analysis_body,
    validate_material_save_body,
    validate_version_body,
)
from nutrition_formula.ingredient_search import local_material, search_local_ingredients
from nutrition_formula.material_profiles import (
    D1MaterialProfileRepository,
    MaterialProfileError,
    search_saved_profiles,
)
from nutrition_formula.tsv import MAX_UPLOAD_BYTES, FormulaUploadError
from nutrition_formula.upload_analysis import analyze_formula_upload
from nutrition_formula.versioning import (
    D1FormulaRepository,
    FormulaAccessError,
    VersionConflictError,
)

from nutrition_formula.provider_search import ProviderSearch
from nutrition_formula.line_review import D1LineReviewRepository, source_rows

MAX_REQUEST_BYTES = MAX_UPLOAD_BYTES + 4096
MAX_PROVIDER_RESPONSE_BYTES = 262144
JSON_HEADERS = {"Cache-Control": "no-store"}
_APP_HEALTH_TASKS: set[asyncio.Task] = set()


async def _release_provider_reader(reader, *, cancel):
    if cancel:
        try:
            await reader.cancel()
        except BaseException:  # Keep the original read error or timeout.
            pass
    try:
        reader.releaseLock()
    except Exception:  # noqa: BLE001 - cleanup must not mask the request result.
        pass


async def _provider_json_response(response):
    body = response.body
    if body is None:
        return json.loads(b"")
    reader = body.getReader()
    complete = False
    try:
        declared_length = response.headers.get("content-length")
        if declared_length is not None:
            try:
                declared_length = int(declared_length)
            except (TypeError, ValueError) as exc:
                raise ValueError("Invalid provider Content-Length") from exc
            if declared_length < 0 or declared_length > MAX_PROVIDER_RESPONSE_BYTES:
                raise ValueError("Provider response exceeds size bound")

        chunks = []
        total_bytes = 0
        while True:
            result = await reader.read()
            if result.done:
                complete = True
                break
            chunk = result.value
            chunk_length = getattr(chunk, "byteLength", None)
            if chunk_length is None:
                chunk_length = len(chunk)
            try:
                chunk_length = int(chunk_length)
            except (TypeError, ValueError) as exc:
                raise ValueError("Invalid provider response chunk") from exc
            if chunk_length < 0 or total_bytes + chunk_length > MAX_PROVIDER_RESPONSE_BYTES:
                raise ValueError("Provider response exceeds size bound")
            chunk_bytes = chunk.to_bytes() if hasattr(chunk, "to_bytes") else bytes(chunk)
            if len(chunk_bytes) != chunk_length:
                raise ValueError("Invalid provider response chunk")
            chunks.append(chunk_bytes)
            total_bytes += chunk_length
        return json.loads(b"".join(chunks).decode("utf-8"))
    finally:
        await _release_provider_reader(reader, cancel=not complete)
_APP_HEALTH_COLD = True


def _json(data, status=200, request_id=None):
    headers = dict(JSON_HEADERS)
    if request_id:
        headers["X-Request-ID"] = request_id
    return Response.json(data, status=status, headers=headers)


def _log(event, request_id, **details):
    console.log(json.dumps({"event": event, "request_id": request_id, **details}))


class Default(WorkerEntrypoint):
    async def fetch(self, request):
        global _APP_HEALTH_COLD
        cold = _APP_HEALTH_COLD
        _APP_HEALTH_COLD = False
        started = time.perf_counter()
        parsed_url = urlparse(request.url)
        path = parsed_url.path
        method = request.method.value
        try:
            response = await self._fetch(request, parsed_url, path, method)
        except Exception:
            self._record_app_health(method, path, 500, started)
            self._record_stage_timing(request, path, 500, started, cold)
            raise
        duration_ms = (time.perf_counter() - started) * 1000
        if path.startswith("/api/"):
            try:
                response.js_object.headers.set("Server-Timing", f"total;dur={int(duration_ms)}")
            except Exception:  # noqa: BLE001 - timing headers must never fail a response.
                pass
        self._record_app_health(method, path, response.status, started)
        self._record_stage_timing(request, path, response.status, started, cold, duration_ms)
        return response

    async def _provider_transport(self, provider, query, limit):
        if provider == "pubchem":
            url = ("https://pubchem.ncbi.nlm.nih.gov/rest/pug/compound/name/"
                   + quote(query, safe="") + "/property/Title,MolecularFormula,MolecularWeight/JSON")
        else:
            key = getattr(self.env, "FDC_API_KEY", None)
            if not key:
                return 503, None
            url = ("https://api.nal.usda.gov/fdc/v1/foods/search?query=" + quote(query, safe="")
                   + "&pageSize=" + str(limit) + "&api_key=" + quote(str(key), safe=""))
        response = await worker_fetch(url)
        if response.status != 200:
            if response.body is not None:
                reader = response.body.getReader()
                await _release_provider_reader(reader, cancel=True)
            return response.status, None
        return 200, await _provider_json_response(response)

    def _provider_service(self):
        if not hasattr(self, "_provider_search"):
            self._provider_search = ProviderSearch(self._provider_transport)
        return self._provider_search

    async def _fetch(self, request, parsed_url, path, method):

        if path == "/api/health" and method == "GET":
            return _json(
                {
                    "status": "ok",
                    "persistence": "available" if hasattr(self.env, "FORMULA_DB") else "unconfigured",
                }
            )

        if path == "/api/ingredients/search" and method == "GET":
            params = parse_qs(parsed_url.query)
            try:
                provider = params.get("provider", ["local"])[0]
                if provider != "local":
                    return _json(await self._provider_service().search(
                        provider, params.get("q", [""])[0],
                        refresh=params.get("refresh", ["false"])[0] == "true"
                    ))
                result = search_local_ingredients(
                    params.get("q", [""])[0], params.get("kind", ["all"])[0]
                )
                if hasattr(self.env, "FORMULA_DB"):
                    profiles = await D1MaterialProfileRepository(
                        self.env.FORMULA_DB, owner_id=PUBLIC_OWNER_ID
                    ).list_active()
                    saved = search_saved_profiles(
                        profiles,
                        params.get("q", [""])[0],
                        params.get("kind", ["all"])[0],
                    )
                    result["candidates"] = [
                        *saved,
                        *[
                            candidate
                            for candidate in result["candidates"]
                            if candidate["material_id"]
                            not in {item["material_id"] for item in saved}
                        ],
                    ][:8]
                    result["saved_profile_count"] = len(profiles)
                return _json(result)
            except ValueError as exc:
                return _json({"error": str(exc)}, status=400)

        if path == "/api/ingredients" or path.startswith("/api/ingredients/"):
            request_id = str(uuid.uuid4())
            if not hasattr(self.env, "FORMULA_DB"):
                return _json(
                    {
                        "error": "The shared ingredient library is not configured",
                        "code": "persistence_unavailable",
                    },
                    status=503,
                    request_id=request_id,
                )
            try:
                repository = D1MaterialProfileRepository(
                    self.env.FORMULA_DB, owner_id=PUBLIC_OWNER_ID
                )
                if path == "/api/ingredients" and method == "GET":
                    profiles = await repository.list_active()
                    return _json({"profiles": profiles}, request_id=request_id)
                if path == "/api/ingredients" and method == "POST":
                    body = await request.json()
                    if body.get("provider"):
                        profile = await self._provider_service().accept(
                            repository, provider=body.get("provider"), query=body.get("query"),
                            candidate_id=body.get("candidate_id"), evidence_id=body.get("evidence_id"),
                            submitted_alias=body.get("submitted_alias"),
                        )
                        return _json({"profile": profile}, status=201, request_id=request_id)
                    material_id, submitted_alias, kind = validate_material_save_body(body)
                    material = local_material(material_id, kind)
                    if material is None:
                        existing = [
                            item
                            for item in await repository.list_active()
                            if item["id"] == material_id
                        ]
                        material = existing[0]["profile"] if existing else None
                    if material is None:
                        raise MaterialProfileError("The selected material profile was not found")
                    profile = await repository.save(
                        material_id=material_id,
                        material=material,
                        submitted_alias=submitted_alias,
                        kind=kind,
                    )
                    _log("ingredient_profile_saved", request_id, status=201)
                    return _json({"profile": profile}, status=201, request_id=request_id)
                deactivate_match = re.fullmatch(r"/api/ingredients/([^/]+)/([^/]+)", path)
                if deactivate_match and method == "DELETE":
                    changed = await repository.deactivate(
                        deactivate_match.group(1), deactivate_match.group(2)
                    )
                    if not changed:
                        return _json(
                            {"error": "Active ingredient profile not found"},
                            status=404,
                            request_id=request_id,
                        )
                    _log("ingredient_profile_deactivated", request_id, status=200)
                    return _json({"deactivated": True}, request_id=request_id)
                return _json({"error": "Ingredient library route not found"}, status=404)
            except (FormulaUploadError, MaterialProfileError, ValueError) as exc:
                return _json({"error": str(exc)}, status=400, request_id=request_id)
            except Exception as exc:  # noqa: BLE001 - runtime JSON and D1 errors vary
                console.error(
                    json.dumps(
                        {
                            "event": "ingredient_library_server_error",
                            "request_id": request_id,
                            "error_type": type(exc).__name__,
                            "status": 500,
                        }
                    )
                )
                return _json(
                    {"error": "The ingredient library could not be updated"},
                    status=500,
                    request_id=request_id,
                )

        if path.startswith("/api/formulas"):
            request_id = str(uuid.uuid4())
            if not hasattr(self.env, "FORMULA_DB"):
                return _json(
                    {
                        "error": "Formula history is not configured for this deployment",
                        "code": "persistence_unavailable",
                    },
                    status=503,
                    request_id=request_id,
                )
            try:
                repository = D1FormulaRepository(
                    self.env.FORMULA_DB, owner_id=PUBLIC_OWNER_ID
                )
                review_match = re.fullmatch(r"/api/formulas/([^/]+)/versions/(\d+)/review", path)
                if review_match and method in {"GET", "POST"}:
                    version = await repository.get_version(review_match.group(1), None, int(review_match.group(2)))
                    reviews = D1LineReviewRepository(self.env.FORMULA_DB, owner_id=PUBLIC_OWNER_ID)
                    if method == "POST":
                        decision = await reviews.save(version, await request.json())
                        return _json({"decision": decision}, request_id=request_id)
                    rows = source_rows(version)
                    identities = {r["source_row_id"] for r in rows}
                    decisions = [d for d in await reviews.list(version["formula_id"])
                                 if d["source_row_id"] in identities]
                    return _json({"rows": rows, "decisions": decisions}, request_id=request_id)
                if path == "/api/formulas" and method == "GET":
                    return _json(
                        {"workspaces": await repository.list_workspaces()},
                        request_id=request_id,
                    )
                if path == "/api/formulas" and method == "POST":
                    body = await request.json()
                    file_name, contents = validate_analysis_body(body)
                    profiles = await D1MaterialProfileRepository(
                        self.env.FORMULA_DB, owner_id=PUBLIC_OWNER_ID
                    ).list_active()
                    report = analyze_formula_upload(
                        contents,
                        file_name,
                        accepted_profiles=profiles,
                        accepted_aliases=validate_accepted_aliases(body),
                    )
                    report["input_basis"] = "dose" if body.get("input_basis") == "dose" else "batch"
                    record = await repository.create(
                        file_name=file_name,
                        contents=contents,
                        report=report,
                        decisions=body.get("decisions", []),
                    )
                    record.pop("access_token")
                    _log(
                        "formula_history_created",
                        request_id,
                        version=record["version"],
                        ingredient_count=len(report["formula_rows"]) - 1,
                    )
                    return _json(
                        {"report": report, "version": record},
                        status=201,
                        request_id=request_id,
                    )

                version_match = re.fullmatch(r"/api/formulas/([^/]+)/versions/(\d+)", path)
                append_match = re.fullmatch(r"/api/formulas/([^/]+)/versions", path)
                formula_match = re.fullmatch(r"/api/formulas/([^/]+)", path)
                restore_match = re.fullmatch(r"/api/formulas/([^/]+)/restore", path)
                if formula_match and method == "GET":
                    history = await repository.history(formula_match.group(1), None)
                    return _json(history, request_id=request_id)
                if version_match and method == "GET":
                    version = await repository.get_version(
                        version_match.group(1), None, int(version_match.group(2))
                    )
                    return _json(version, request_id=request_id)
                if append_match and method == "POST":
                    body = await request.json()
                    file_name, contents, expected, cause, decisions = validate_version_body(body)
                    profiles = await D1MaterialProfileRepository(
                        self.env.FORMULA_DB, owner_id=PUBLIC_OWNER_ID
                    ).list_active()
                    report = analyze_formula_upload(
                        contents,
                        file_name,
                        accepted_profiles=profiles,
                        accepted_aliases=validate_accepted_aliases(body),
                    )
                    report["input_basis"] = "dose" if body.get("input_basis") == "dose" else "batch"
                    version = await repository.append(
                        formula_id=append_match.group(1),
                        access_token=None,
                        expected_version=expected,
                        file_name=file_name,
                        contents=contents,
                        report=report,
                        cause=cause,
                        decisions=decisions,
                    )
                    return _json({"report": report, "version": version}, request_id=request_id)
                if restore_match and method == "POST":
                    body = await request.json()
                    expected = body.get("expected_version")
                    target = body.get("target_version")
                    if not isinstance(expected, int) or not isinstance(target, int):
                        raise FormulaUploadError(
                            "expected_version and target_version must be integers"
                        )
                    version = await repository.restore(
                        formula_id=restore_match.group(1),
                        access_token=None,
                        expected_version=expected,
                        target_version=target,
                    )
                    return _json(
                        {"report": version["report"], "version": version},
                        request_id=request_id,
                    )
                return _json({"error": "Formula history route not found"}, status=404)
            except VersionConflictError as exc:
                return _json({"error": str(exc)}, status=409, request_id=request_id)
            except (FormulaAccessError, FormulaUploadError, ValueError) as exc:
                return _json({"error": str(exc)}, status=400, request_id=request_id)
            except Exception as exc:  # noqa: BLE001 - runtime JSON and D1 errors vary
                console.error(
                    json.dumps(
                        {
                            "event": "formula_history_server_error",
                            "request_id": request_id,
                            "error_type": type(exc).__name__,
                            "status": 500,
                        }
                    )
                )
                return _json(
                    {"error": "Formula history could not be updated"},
                    status=500,
                    request_id=request_id,
                )

        if path == "/api/analyze":
            request_id = str(uuid.uuid4())
            content_length = request.headers.get("content-length")
            _log(
                "formula_analysis_started",
                request_id,
                method=method,
                content_length=int(content_length) if content_length else None,
            )
            if method != "POST":
                _log(
                    "formula_analysis_client_error",
                    request_id,
                    reason="method_not_allowed",
                    status=405,
                )
                return _json(
                    {"error": "Use POST for formula analysis"}, status=405, request_id=request_id
                )
            if content_length and int(content_length) > MAX_REQUEST_BYTES:
                _log(
                    "formula_analysis_client_error",
                    request_id,
                    reason="request_too_large",
                    status=413,
                )
                return _json(
                    {"error": "The formula upload is too large"}, status=413, request_id=request_id
                )
            try:
                try:
                    body = await request.json()
                except Exception:  # noqa: BLE001 - runtime JSON parser exceptions vary
                    _log(
                        "formula_analysis_client_error",
                        request_id,
                        reason="invalid_json",
                        status=400,
                    )
                    return _json(
                        {"error": "Request body must be valid JSON"},
                        status=400,
                        request_id=request_id,
                    )
                file_name, contents = validate_analysis_body(body)
                profiles = []
                if hasattr(self.env, "FORMULA_DB"):
                    try:
                        profiles = await D1MaterialProfileRepository(
                            self.env.FORMULA_DB,
                            owner_id=PUBLIC_OWNER_ID,
                        ).list_active()
                    except Exception as exc:  # noqa: BLE001 - analysis remains available
                        console.error(
                            json.dumps(
                                {
                                    "event": "ingredient_profiles_unavailable",
                                    "request_id": request_id,
                                    "error_type": type(exc).__name__,
                                }
                            )
                        )
                result = analyze_formula_upload(
                    contents,
                    file_name,
                    accepted_profiles=profiles,
                    accepted_aliases=validate_accepted_aliases(body),
                )
                result["input_basis"] = "dose" if body.get("input_basis") == "dose" else "batch"
                _log(
                    "formula_analysis_completed",
                    request_id,
                    status=200,
                    file_extension=file_name.rsplit(".", 1)[-1].lower()
                    if "." in file_name
                    else "none",
                    ingredient_count=len(result["formula_rows"]) - 1,
                    present_component_count=len(result["present_components"]),
                    screened_component_count=len(result["screened_components"]),
                    identity_review_count=sum(
                        1 for row in result["formula_rows"] if row.get("needs_review")
                    ),
                    characterized_percent=result["coverage"]["characterized_percent"],
                )
                return _json(result, request_id=request_id)
            except FormulaUploadError as exc:
                _log(
                    "formula_analysis_client_error",
                    request_id,
                    reason=type(exc).__name__,
                    status=400,
                )
                return _json({"error": str(exc)}, status=400, request_id=request_id)
            except Exception as exc:  # noqa: BLE001 - return a safe error at the HTTP boundary
                console.error(
                    json.dumps(
                        {
                            "event": "formula_analysis_server_error",
                            "request_id": request_id,
                            "error_type": type(exc).__name__,
                            "status": 500,
                        }
                    )
                )
                return _json(
                    {"error": "The formula could not be analyzed. Check the file and try again."},
                    status=500,
                    request_id=request_id,
                )

        if path.startswith("/api/"):
            return _json({"error": "API route not found"}, status=404)
        return await self.env.ASSETS.fetch(request)

    def _record_stage_timing(self, request, path, status_code, started, cold, duration_ms=None):
        try:
            key = getattr(self.env, "APP_HEALTH_INGEST_KEY", None)
            if not isinstance(key, str) or not key:
                return
            cf = getattr(request, "cf", None)
            colo = cf.get("colo") if isinstance(cf, dict) else getattr(cf, "colo", None)
            event = build_stage_timing_event(
                path, status_code,
                duration_ms if duration_ms is not None else (time.perf_counter() - started) * 1000,
                colo=colo, cold=cold,
                sample_rate=getattr(self.env, "APP_HEALTH_STAGE_SAMPLE_RATE", None),
            )
            if event is not None:
                self._schedule_app_health(event, is_log=True)
        except Exception:  # noqa: BLE001 - optional timing telemetry must fail open.
            pass

    def _record_app_health(self, method, path, status_code, started):
        try:
            event = build_event(
                method,
                path,
                status_code,
                (time.perf_counter() - started) * 1000,
            )
        except Exception:  # noqa: BLE001 - metric construction must never affect the app response.
            return
        if event is None:
            return
        self._schedule_app_health(event)

    def _schedule_app_health(self, event, *, is_log=False):
        try:
            key = getattr(self.env, "APP_HEALTH_INGEST_KEY", None)
            environment = getattr(self.env, "APP_HEALTH_ENVIRONMENT", None)
        except Exception:  # noqa: BLE001 - missing optional telemetry binding is a no-op.
            return
        if not isinstance(key, str) or not key:
            return
        if not isinstance(environment, str):
            environment = None

        try:
            task = asyncio.create_task(
                deliver_event(event, key, worker_fetch, environment=environment, is_log=is_log)
            )
            _APP_HEALTH_TASKS.add(task)
            task.add_done_callback(_APP_HEALTH_TASKS.discard)
            task_proxy = create_proxy(task)
            task.add_done_callback(lambda _completed: task_proxy.destroy())
            self.ctx.waitUntil(task_proxy)
        except Exception:  # noqa: BLE001, S110 - best-effort delivery never changes the app response.
            # Telemetry must never alter the app response if the runtime context is absent.
            pass
