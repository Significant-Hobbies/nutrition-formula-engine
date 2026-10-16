from copy import deepcopy
import json
import types
import unittest
from unittest.mock import patch

from nutrition_formula.input_provenance import validate_input_provenance, provenance_markdown
from nutrition_formula.tsv import FormulaUploadError
from nutrition_formula.upload_analysis import analyze_formula_upload
from test_versioning import FakeD1
from test_worker_routes import Request, load_worker_module

CONTENTS = "Item\tQuantity\tUnit\nFINISHED BATCH\t1000\tL\nSugar\t400\tkg\n"
SOURCE = {"method": "PDF OCR", "page": 2, "line": 3, "text": "Sugar 500 kilograms",
          "original": {"item": "Sugar", "quantity": "500", "unit": "kg"},
          "ocr": {"engine": "Tesseract.js 7 / LSTM", "language": "eng", "scope": "page", "confidence": 72.5}}
PROVENANCE = {"version": 1, "rows": [None, SOURCE]}


class InputProvenanceTests(unittest.IsolatedAsyncioTestCase):
    def test_edited_values_and_source_are_separate_and_old_reports_work(self):
        report = analyze_formula_upload(CONTENTS, "fixture.tsv", input_provenance=PROVENANCE)
        self.assertEqual(report["formula_rows"][1]["submitted_quantity"], "400")
        self.assertEqual(report["formula_rows"][1]["input_source"], SOURCE)
        self.assertIn("Sugar 500 kilograms", report["markdown"])
        self.assertIn("OCR engine 72.5/100 (page)", report["markdown"])
        self.assertEqual(json.loads(json.dumps(report))["input_provenance"], PROVENANCE)
        old = analyze_formula_upload(CONTENTS, "fixture.tsv")
        self.assertNotIn("input_provenance", old)
        self.assertNotIn("input_source", old["formula_rows"][1])

    def test_source_markdown_keeps_links_images_and_backslashes_inert(self):
        source = deepcopy(SOURCE)
        source["text"] = r"[label](https://example.test) ![image](https://example.test/a) \* <script>"
        markdown = provenance_markdown([{"input_source": source}])
        self.assertNotIn("[label]", markdown)
        self.assertNotIn("![image]", markdown)
        self.assertNotIn("<script>", markdown)
        self.assertIn("&#91;label&#93;&#40;https&#58;//example.test&#41;", markdown)
        self.assertIn("&#92;&#42;", markdown)

    def test_rejects_misaligned_unbounded_or_invalid_evidence(self):
        cases = []
        for key, value in [("line", 0), ("line", True), ("page", -1), ("worksheet", "Sheet 1"),
                           ("text", "x" * 4097), ("cells", ["x"] * 129), ("local_path", "/private/source.pdf"),
                           ("original", {"item": "Sugar"}), ("original", {"item": "Sugar", "quantity": 500, "unit": "kg"})]:
            source = {**deepcopy(SOURCE), key: value}
            cases.append({"version": 1, "rows": [None, source]})
        for confidence in (float("nan"), float("inf"), -1, 101, True, "99"):
            source = deepcopy(SOURCE)
            source["ocr"]["confidence"] = confidence
            cases.append({"version": 1, "rows": [None, source]})
        cases.extend([{"version": 1, "rows": [SOURCE]}, {"version": 2, "rows": [None, SOURCE]},
                      {"version": True, "rows": [None, SOURCE]}, {"version": 1, "rows": [None, SOURCE], "document": "raw"}])
        for value in cases:
            with self.subTest(value=str(value)[:100]), self.assertRaises(FormulaUploadError):
                validate_input_provenance(value, 2)
        oversized = {"version": 1, "rows": [{**SOURCE, "text": "x" * 4096} for _ in range(40)]}
        with self.assertRaises(FormulaUploadError):
            validate_input_provenance(oversized, 40)
        self.assertEqual(validate_input_provenance(PROVENANCE, 2), PROVENANCE)
        self.assertIsNone(validate_input_provenance(None, 2))

    async def test_worker_create_append_reload_restore_and_analysis_retain_source(self):
        module = load_worker_module()
        worker = module.Default()
        database = FakeD1()
        self.addCleanup(database.connection.close)
        worker.env = types.SimpleNamespace(FORMULA_DB=database)
        body = {"file_name": "fixture.tsv", "contents": CONTENTS, "input_provenance": deepcopy(PROVENANCE)}
        logged = []
        with patch.object(module, "_log", side_effect=lambda *args, **kwargs: logged.append((args, kwargs))):
            analysis = await worker.fetch(Request("POST", "/api/analyze", body))
            self.assertEqual(analysis.status, 200)
            self.assertEqual(analysis.data["formula_rows"][1]["input_source"], SOURCE)
            created = await worker.fetch(Request("POST", "/api/formulas", body))
            self.assertEqual(created.status, 201)
            formula_id = created.data["version"]["formula_id"]
            changed_body = {**body, "contents": CONTENTS.replace("400", "350"), "expected_version": 1, "cause": "formula_corrected"}
            updated = await worker.fetch(Request("POST", f"/api/formulas/{formula_id}/versions", changed_body))
            self.assertEqual(updated.status, 200)
            self.assertEqual(updated.data["report"]["formula_rows"][1]["input_source"], SOURCE)
            readback = await worker.fetch(Request("GET", f"/api/formulas/{formula_id}/versions/1"))
            self.assertEqual(readback.data["normalized_input"]["input_provenance"], PROVENANCE)
            self.assertEqual(readback.data["report"]["formula_rows"][1]["submitted_quantity"], "400")
            restored = await worker.fetch(Request("POST", f"/api/formulas/{formula_id}/restore", {"expected_version": 2, "target_version": 1}))
            self.assertEqual(restored.status, 200)
            self.assertEqual(restored.data["report"], readback.data["report"])
            self.assertEqual(restored.data["version"]["normalized_input"]["input_provenance"], PROVENANCE)
            for path in ("/api/analyze", "/api/formulas", f"/api/formulas/{formula_id}/versions"):
                invalid = await worker.fetch(Request("POST", path, {**changed_body, "input_provenance": {"version": 1, "rows": []}}))
                self.assertEqual(invalid.status, 400)
        self.assertNotIn("Sugar", json.dumps(logged))
        self.assertNotIn("kilograms", json.dumps(logged))
