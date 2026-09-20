"""Pure validation helpers for the formula-analysis HTTP boundary."""

from __future__ import annotations

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
