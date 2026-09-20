"""Pure validation helpers for the formula-analysis HTTP boundary."""

from __future__ import annotations

import hmac

from nutrition_formula.tsv import FormulaUploadError


def validate_analysis_body(body: object) -> tuple[str, str]:
    """Return the reviewed TSV filename and contents from an API request body."""
    if not isinstance(body, dict):
        raise FormulaUploadError("Request body must be a JSON object")
    file_name = body.get("file_name")
    contents = body.get("contents")
    if not isinstance(file_name, str) or not isinstance(contents, str):
        raise FormulaUploadError("file_name and contents are required")
    return file_name, contents


def validate_accepted_aliases(body: object) -> dict[str, str]:
    if not isinstance(body, dict):
        raise FormulaUploadError("Request body must be a JSON object")
    values = body.get("accepted_aliases", [])
    if not isinstance(values, list) or len(values) > 100:
        raise FormulaUploadError("accepted_aliases must be a list of at most 100 entries")
    aliases: dict[str, str] = {}
    for item in values:
        if not isinstance(item, dict):
            raise FormulaUploadError("Every accepted alias must be an object")
        alias = item.get("alias")
        material_id = item.get("material_id")
        if not isinstance(alias, str) or not alias.strip() or len(alias) > 160:
            raise FormulaUploadError("Every accepted alias needs a name of 1 to 160 characters")
        if not isinstance(material_id, str) or not material_id.strip() or len(material_id) > 160:
            raise FormulaUploadError("Every accepted alias needs a valid material_id")
        aliases[alias] = material_id
    return aliases


def validate_material_save_body(body: object) -> tuple[str, str, str]:
    if not isinstance(body, dict):
        raise FormulaUploadError("Request body must be a JSON object")
    material_id = body.get("material_id")
    submitted_alias = body.get("submitted_alias")
    kind = body.get("kind", "food")
    if not isinstance(material_id, str) or not material_id.strip() or len(material_id) > 160:
        raise FormulaUploadError("material_id is required")
    if (
        not isinstance(submitted_alias, str)
        or not submitted_alias.strip()
        or len(submitted_alias) > 160
    ):
        raise FormulaUploadError("submitted_alias must contain 1 to 160 characters")
    if kind not in {"food", "chemical"}:
        raise FormulaUploadError("kind must be food or chemical")
    return material_id, submitted_alias, kind


def validate_version_body(body: object) -> tuple[str, str, int, str, list[dict]]:
    file_name, contents = validate_analysis_body(body)
    assert isinstance(body, dict)
    expected_version = body.get("expected_version")
    cause = body.get("cause", "formula_corrected")
    decisions = body.get("decisions", [])
    if not isinstance(expected_version, int) or expected_version < 1:
        raise FormulaUploadError("expected_version must be a positive integer")
    if not isinstance(cause, str) or not cause.strip():
        raise FormulaUploadError("cause must be a non-empty string")
    if not isinstance(decisions, list) or not all(isinstance(item, dict) for item in decisions):
        raise FormulaUploadError("decisions must be a list of objects")
    return file_name, contents, expected_version, cause, decisions


def bearer_token(authorization: str | None) -> str:
    if not authorization or not authorization.startswith("Bearer "):
        raise FormulaUploadError("A formula access token is required")
    token = authorization.removeprefix("Bearer ").strip()
    if not token:
        raise FormulaUploadError("A formula access token is required")
    return token


def owner_token_matches(supplied: str, expected: str) -> bool:
    """Compare owner tokens without leaking length or non-ASCII edge cases."""

    return hmac.compare_digest(supplied.encode("utf-8"), expected.encode("utf-8"))
