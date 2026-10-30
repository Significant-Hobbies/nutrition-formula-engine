"""Bounded, user-supplied extraction evidence; never ingredient identity evidence."""

from copy import deepcopy
import json
import math
from typing import Any

from .tsv import FormulaUploadError

SOURCE_FIELDS = {
    "method", "original", "line", "page", "worksheet", "json_path", "text", "cells", "ocr",
}


def _invalid() -> None:
    raise FormulaUploadError(
        "Invalid input_provenance: supply bounded source evidence aligned with every reviewed row"
    )


def _text(value: object, limit: int) -> None:
    if not isinstance(value, str) or len(value) > limit:
        _invalid()


def validate_input_provenance(value: object, row_count: int) -> dict[str, Any] | None:
    if value is None:
        return None
    if not isinstance(value, dict) or not {"version", "rows"} <= set(value) or set(value) - {"version", "rows", "unparsed_rows"}:
        _invalid()
    if type(value["version"]) is not int or value["version"] != 1:
        _invalid()
    rows = value["rows"]
    if not isinstance(rows, list) or len(rows) != row_count or len(rows) > 251:
        _invalid()
    unparsed = value.get("unparsed_rows", [])
    if not isinstance(unparsed, list) or len(unparsed) > 251:
        _invalid()
    for source, needs_original in [(row, True) for row in rows] + [(row, False) for row in unparsed]:
        if source is None:
            if not needs_original:
                _invalid()
            continue
        if not isinstance(source, dict):
            _invalid()
        required = {"method", "original"} if needs_original else {"method"}
        if not required <= source.keys() or set(source) - SOURCE_FIELDS:
            _invalid()
        _text(source["method"], 80)
        if not source["method"] or not any(key in source for key in ("line", "json_path")):
            _invalid()
        for key in ("line", "page", "worksheet"):
            if key in source:
                if type(source[key]) is not int or not 1 <= source[key] <= 1048576:
                    _invalid()
        if "json_path" in source:
            _text(source["json_path"], 160)
        if "text" in source:
            _text(source["text"], 4096)
        if "cells" in source:
            if not isinstance(source["cells"], list) or len(source["cells"]) > 128:
                _invalid()
            for cell in source["cells"]:
                _text(cell, 4096)
        if not needs_original and not ("text" in source or "cells" in source):
            _invalid()
        if needs_original or "original" in source:
            original = source["original"]
            if not isinstance(original, dict) or set(original) != {"item", "quantity", "unit"}:
                _invalid()
            for key, limit in (("item", 1024), ("quantity", 80), ("unit", 32)):
                _text(original[key], limit)
        if "ocr" in source:
            _validate_ocr(source["ocr"])
    if len(json.dumps(value, ensure_ascii=False).encode("utf-8")) > 131072:
        _invalid()
    return deepcopy(value)


def _validate_ocr(ocr: object) -> None:
    if not isinstance(ocr, dict) or set(ocr) != {"engine", "language", "scope", "confidence"}:
        _invalid()
    _text(ocr["engine"], 80)
    if ocr["language"] != "eng" or ocr["scope"] not in ("page", "image"):
        _invalid()
    confidence = ocr["confidence"]
    if confidence is not None:
        if type(confidence) not in (float, int):
            _invalid()
        if not math.isfinite(confidence) or not 0 <= confidence <= 100:
            _invalid()


def _markdown_text(value: object) -> str:
    # Entities keep user source text inert in both Markdown and HTML renderers.
    punctuation = set("&<>|`\\[]()!*_#~:")
    return "".join(
        f"&#{ord(char)};" if char in punctuation else " " if char in "\r\n" else char
        for char in str(value)
    )


def provenance_markdown(rows: list[dict[str, Any]], unparsed_rows: list[dict[str, Any]] | None = None) -> str:
    lines = []
    for index, row in enumerate(rows, 1):
        source = row.get("input_source")
        if not source:
            continue
        location = ", ".join(
            f"{'recovered line' if key == 'line' and (source.get('page') or source.get('ocr')) else key} {source[key]}"
            for key in ("worksheet", "page", "line", "json_path") if key in source
        )
        original = " · ".join(source["original"][key] for key in ("item", "quantity", "unit"))
        raw = source.get("text", " · ".join(source.get("cells", [])))
        confidence = ""
        ocr = source.get("ocr")
        if ocr:
            score = "unavailable" if ocr["confidence"] is None else f"{ocr['confidence']}/100"
            confidence = f"; OCR engine {score} ({ocr['scope']})"
        lines.append(
            f"- Row {index}: {_markdown_text(source['method'])}, {_markdown_text(location)}"
            f"{confidence}. Original recovered values: {_markdown_text(original)}. "
            f"Source: {_markdown_text(raw)}."
        )
    for source in unparsed_rows or []:
        raw = source.get("text", " · ".join(source.get("cells", [])))
        location = ", ".join(f"{key} {source[key]}" for key in ("worksheet", "page", "line", "json_path") if key in source)
        lines.append(f"- Source line not included: {_markdown_text(location)}. Source: {_markdown_text(raw)}.")
    if not lines:
        return ""
    return (
        "\n\n## Input source evidence\n\nUser-supplied extraction evidence; OCR engine confidence "
        "is not calibrated correctness or ingredient identity confidence.\n\n"
        + "\n".join(lines) + "\n"
    )
