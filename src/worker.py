"""Cloudflare Python Worker entrypoint for local formula analysis."""

from __future__ import annotations

import json
import re
import uuid
from urllib.parse import parse_qs, urlparse

from js import console
from workers import Response, WorkerEntrypoint

from nutrition_formula.http_api import (
    bearer_token,
    owner_token_matches,
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

MAX_REQUEST_BYTES = MAX_UPLOAD_BYTES + 4096
JSON_HEADERS = {"Cache-Control": "no-store"}


def _json(data, status=200, request_id=None):
    headers = dict(JSON_HEADERS)
    if request_id:
        headers["X-Request-ID"] = request_id
    return Response.json(data, status=status, headers=headers)


def _log(event, request_id, **details):
    console.log(json.dumps({"event": event, "request_id": request_id, **details}))


def _owner_write_status(request, env):
    if not hasattr(env, "INGREDIENT_ADMIN_TOKEN"):
        return "unconfigured"
    try:
        supplied = bearer_token(request.headers.get("authorization"))
    except FormulaUploadError:
        return "denied"
    expected = str(env.INGREDIENT_ADMIN_TOKEN)
    return "authorized" if owner_token_matches(supplied, expected) else "denied"


class Default(WorkerEntrypoint):
    async def fetch(self, request):
        parsed_url = urlparse(request.url)
        path = parsed_url.path
        method = request.method.value

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
                result = search_local_ingredients(
                    params.get("q", [""])[0], params.get("kind", ["all"])[0]
                )
                if hasattr(self.env, "FORMULA_DB"):
                    profiles = await D1MaterialProfileRepository(
                        self.env.FORMULA_DB
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
            repository = D1MaterialProfileRepository(self.env.FORMULA_DB)
            try:
                if path == "/api/ingredients" and method == "GET":
                    profiles = await repository.list_active()
                    return _json({"profiles": profiles}, request_id=request_id)
                write_status = _owner_write_status(request, self.env)
                if write_status == "unconfigured":
                    return _json(
                        {
                            "error": "Owner writes are not configured",
                            "code": "owner_write_unconfigured",
                        },
                        status=503,
                        request_id=request_id,
                    )
                if write_status != "authorized":
                    return _json(
                        {"error": "Owner authorization is required"},
                        status=403,
                        request_id=request_id,
                    )
                if path == "/api/ingredients" and method == "POST":
                    body = await request.json()
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
            repository = D1FormulaRepository(self.env.FORMULA_DB)
            try:
                profiles = await D1MaterialProfileRepository(self.env.FORMULA_DB).list_active()
                if path == "/api/formulas" and method == "POST":
                    body = await request.json()
                    file_name, contents = validate_analysis_body(body)
                    report = analyze_formula_upload(
                        contents,
                        file_name,
                        accepted_profiles=profiles,
                        accepted_aliases=validate_accepted_aliases(body),
                    )
                    record = await repository.create(
                        file_name=file_name,
                        contents=contents,
                        report=report,
                        decisions=body.get("decisions", []),
                    )
                    access_token = record.pop("access_token")
                    _log(
                        "formula_history_created",
                        request_id,
                        version=record["version"],
                        ingredient_count=len(report["formula_rows"]) - 1,
                    )
                    return _json(
                        {"report": report, "version": record, "access_token": access_token},
                        status=201,
                        request_id=request_id,
                    )

                version_match = re.fullmatch(r"/api/formulas/([^/]+)/versions/(\d+)", path)
                append_match = re.fullmatch(r"/api/formulas/([^/]+)/versions", path)
                formula_match = re.fullmatch(r"/api/formulas/([^/]+)", path)
                restore_match = re.fullmatch(r"/api/formulas/([^/]+)/restore", path)
                token = bearer_token(request.headers.get("authorization"))

                if formula_match and method == "GET":
                    history = await repository.history(formula_match.group(1), token)
                    return _json(history, request_id=request_id)
                if version_match and method == "GET":
                    version = await repository.get_version(
                        version_match.group(1), token, int(version_match.group(2))
                    )
                    return _json(version, request_id=request_id)
                if append_match and method == "POST":
                    body = await request.json()
                    file_name, contents, expected, cause, decisions = validate_version_body(body)
                    report = analyze_formula_upload(
                        contents,
                        file_name,
                        accepted_profiles=profiles,
                        accepted_aliases=validate_accepted_aliases(body),
                    )
                    version = await repository.append(
                        formula_id=append_match.group(1),
                        access_token=token,
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
                        access_token=token,
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
            except (FormulaAccessError, FormulaUploadError) as exc:
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
                profiles = (
                    await D1MaterialProfileRepository(self.env.FORMULA_DB).list_active()
                    if hasattr(self.env, "FORMULA_DB")
                    else []
                )
                result = analyze_formula_upload(
                    contents,
                    file_name,
                    accepted_profiles=profiles,
                    accepted_aliases=validate_accepted_aliases(body),
                )
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
