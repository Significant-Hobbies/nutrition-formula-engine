"""Strict parser for the single supported formula-upload format."""

from __future__ import annotations

import csv
import io
import re
from decimal import Decimal, InvalidOperation
from pathlib import Path
from typing import Any

from .engine import CalculationError, decimal_string
from .units import convert, dimension, normalize_unit

MAX_UPLOAD_BYTES = 256 * 1024
MAX_INGREDIENTS = 250
EXPECTED_HEADER = ("item", "quantity", "unit")
SUPPORTED_UNITS = {"kg", "g", "mg", "ug", "l", "ml"}


class FormulaUploadError(CalculationError):
    """Raised when an uploaded table does not match the supported contract."""


def _number(value: str, row_number: int) -> str:
    cleaned = value.strip()
    if re.fullmatch(r"[+-]?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?", cleaned):
        cleaned = cleaned.replace(",", "")
    try:
        number = Decimal(cleaned)
    except InvalidOperation as exc:
        raise FormulaUploadError(f"Row {row_number}: quantity must be a valid number") from exc
    if not number.is_finite() or number <= 0:
        raise FormulaUploadError(f"Row {row_number}: quantity must be greater than zero")
    return decimal_string(number)


def _file_stem(file_name: str) -> str:
    name = Path(file_name or "uploaded-formula.tsv").name
    if not name.casefold().endswith(".tsv"):
        raise FormulaUploadError("Upload a .tsv file")
    stem = Path(name).stem.strip().replace("_", " ").replace("-", " ")
    return " ".join(stem.split()) or "Uploaded formula"


def _normalized_equivalent(value: str, unit: str) -> str:
    amount = Decimal(value)
    if dimension(unit) == "mass":
        return f"{decimal_string(convert(amount, unit, 'g'))} g"
    return f"{decimal_string(convert(amount, unit, 'ml'))} mL"


def parse_formula_tsv(text: str, file_name: str) -> dict[str, Any]:
    """Parse the canonical Item/Quantity/Unit TSV format into an engine formula."""

    if not isinstance(text, str):
        raise FormulaUploadError("Uploaded contents must be text")
    if len(text.encode("utf-8")) > MAX_UPLOAD_BYTES:
        raise FormulaUploadError("The formula file must be 256 KB or smaller")

    reader = csv.reader(io.StringIO(text.lstrip("\ufeff")), delimiter="\t")
    rows = [(number, row) for number, row in enumerate(reader, start=1) if any(row)]
    if not rows:
        raise FormulaUploadError("The formula file is empty")

    header_number, header = rows[0]
    normalized_header = tuple(cell.strip().casefold() for cell in header)
    if normalized_header != EXPECTED_HEADER:
        raise FormulaUploadError(
            f"Row {header_number}: header must be exactly Item, Quantity, Unit"
        )
    if len(rows) < 3:
        raise FormulaUploadError("Include one FINISHED BATCH row and at least one ingredient")
    if len(rows) - 2 > MAX_INGREDIENTS:
        raise FormulaUploadError(f"A formula can contain at most {MAX_INGREDIENTS} ingredients")

    parsed_rows: list[dict[str, Any]] = []
    for row_number, row in rows[1:]:
        if len(row) != 3:
            raise FormulaUploadError(
                f"Row {row_number}: expected exactly 3 tab-separated columns"
            )
        item, raw_quantity, raw_unit = (cell.strip() for cell in row)
        if not item:
            raise FormulaUploadError(f"Row {row_number}: item is required")
        quantity = _number(raw_quantity, row_number)
        unit = normalize_unit(raw_unit)
        if unit not in SUPPORTED_UNITS:
            supported = ", ".join(sorted(SUPPORTED_UNITS))
            raise FormulaUploadError(
                f"Row {row_number}: unsupported unit {raw_unit!r}; use one of {supported}"
            )
        parsed_rows.append(
            {
                "source_row": row_number,
                "item": item,
                "submitted_quantity": raw_quantity,
                "submitted_unit": raw_unit,
                "quantity": quantity,
                "unit": unit,
                "normalized_equivalent": _normalized_equivalent(quantity, unit),
            }
        )

    batch_row = parsed_rows[0]
    if " ".join(batch_row["item"].casefold().split()) != "finished batch":
        raise FormulaUploadError("Row 2 must define FINISHED BATCH")
    for row in parsed_rows[1:]:
        if " ".join(row["item"].casefold().split()) == "finished batch":
            raise FormulaUploadError(
                f"Row {row['source_row']}: FINISHED BATCH may appear only as the first data row"
            )

    formula = {
        "schema_version": 1,
        "batch": {
            "name": _file_stem(file_name),
            "final_quantity": {"value": batch_row["quantity"], "unit": batch_row["unit"]},
        },
        "serving": {
            "value": "100",
            "unit": "ml" if dimension(batch_row["unit"]) == "volume" else "g",
        },
        "ingredients": [
            {
                "ingredient": row["item"],
                "quantity": {"value": row["quantity"], "unit": row["unit"]},
            }
            for row in parsed_rows[1:]
        ],
    }
    return {"formula": formula, "rows": parsed_rows, "file_name": Path(file_name).name}
