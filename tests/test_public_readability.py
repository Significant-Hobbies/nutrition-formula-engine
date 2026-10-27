from pathlib import Path
import json
import subprocess
import sys
import unittest
import shutil
import tempfile

from nutrition_formula.public_readability import (
    IDENTITY, ORIGIN, PAGES, documents, markdown_path, public_response, routes, wants_markdown,
)

ROOT = Path(__file__).resolve().parents[1]


class PublicReadabilityTests(unittest.TestCase):
    def test_source_coverage_and_no_user_state(self):
        self.assertEqual(set(PAGES), {"/", "/case-studies/"})
        html = {str(path.relative_to(ROOT / "public")) for path in (ROOT / "public").rglob("index.html")}
        self.assertEqual(html, {"index.html", "case-studies/index.html", "recent-formulas/index.html"})
        self.assertNotIn("Your final sheet", PAGES["/"]["body"])
        self.assertNotIn("Check the formula", PAGES["/"]["body"])
        self.assertIn("Maximum 12 MiB", PAGES["/"]["body"])
        self.assertIn("```text\nPAPAIN 60 MG", PAGES["/"]["body"])
        for route in routes():
            body = PAGES[route["path"]]["body"]
            self.assertIn("Canonical: " + route["url"], body)
            self.assertEqual((ROOT / "public" / markdown_path(route["path"]).lstrip("/")).read_text(), body)
        self.assertNotIn("recent-formulas", documents()["/llms-full.txt"])

    def test_published_comparisons_preserve_decimal_strings_and_boundaries(self):
        data = json.loads((ROOT / "public/case-studies.json").read_text())
        body = PAGES["/case-studies/"]["body"]
        count = 0
        for case in data["cases"]:
            self.assertIn("### " + case["product"], body)
            self.assertIn(case["source_url"], body)
            for comparison in case.get("components") or [case]:
                count += 1
                for field in ["component", "declared", "predicted"]:
                    self.assertIn(str(comparison[field]), body)
                self.assertIn(str(comparison["difference_percent"]) + "%", body)
            if case.get("assumption"):
                self.assertIn(case["assumption"], body)
        self.assertEqual((len(data["cases"]), count), (26, 55))
        self.assertIn("do not replace a laboratory test", body)
        self.assertIn("never guess a missing amount", body)

    def test_accept_precedence_and_invalid_weights(self):
        yes = ["text/markdown", "TEXT/MARKDOWN;q=1,text/html;q=0.5", "text/markdown,text/html;q=0,*/*"]
        no = ["", "*/*", "text/*", "text/html", "text/markdown;q=0", "text/markdown,text/html",
              "text/markdown;q=0.5,*/*", "text/markdown;q=.5", "text/markdown;q=2", "text/markdown;q=1;q=0",
              "text/markdown;q=1,text/markdown;q=0", "text/markdown;q=bogus"]
        for accept in yes:
            self.assertTrue(wants_markdown(accept), accept)
        for accept in no:
            self.assertFalse(wants_markdown(accept), accept)

    def test_http_representation_headers_head_options_and_fail_closed(self):
        for route in routes():
            suffix = public_response(markdown_path(route["path"]), "GET")
            self.assertEqual(suffix["body"], PAGES[route["path"]]["body"])
            self.assertEqual(suffix["headers"]["Content-Location"], route["url"])
            self.assertEqual(suffix["headers"]["X-Robots-Tag"], "noindex, follow")
            for target in [route["path"], "/api/md" + route["path"]]:
                response = public_response(target, "GET", "text/markdown")
                self.assertEqual(response["body"], suffix["body"])
                head = public_response(target, "HEAD", "text/markdown")
                self.assertIsNone(head["body"])
                self.assertEqual(head["headers"], response["headers"])
            self.assertIsNone(public_response(route["path"], "GET", "*/*"))
        for path in ["/api/md/private", "/api/md/recent-formulas/", "/recent-formulas.md", "/missing.md", "/admin/x.md"]:
            result = public_response(path, "GET")
            self.assertEqual(result["status"], 404)
            self.assertEqual(result["headers"]["Cache-Control"], "no-store")
            self.assertTrue(result["body"].startswith("# Not found"))
        for path in ["/api/formulas", "/api/materials", "/recent-formulas/", "/fonts/license.md", "/.well-known/real.md"]:
            self.assertIsNone(public_response(path, "GET", "text/markdown"))
        self.assertEqual(public_response("/api/md", "OPTIONS")["status"], 204)
        self.assertEqual(public_response("/api/md", "OPTIONS")["headers"]["Access-Control-Allow-Origin"], "*")
        self.assertIsNone(public_response("/api/md", "POST", "text/markdown"))

    def test_discovery_is_bounded_and_policy_approved(self):
        self.assertLess(len(documents()["/llms-full.txt"]), 500000)
        self.assertEqual(documents()["/llms-full.txt"].count("Canonical:"), 2)
        self.assertIn(IDENTITY["description"], documents()["/ai.txt"])
        self.assertIn("training: allowed on public pages only", documents()["/ai.txt"])
        for bot in ["GPTBot", "ClaudeBot", "Google-Extended", "Applebot-Extended", "CCBot", "Bytespider"]:
            self.assertIn(f"User-agent: {bot}\nAllow: /", documents()["/robots.txt"])
        catalog = json.loads(public_response("/api/md/_catalog", "GET")["body"])
        self.assertEqual(catalog, routes())
        self.assertTrue(all(route["url"].startswith(ORIGIN) for route in catalog))

    def test_generator_is_idempotent(self):
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory)
            for name in ["public", "src/nutrition_formula", "scripts"]:
                shutil.copytree(ROOT / name, target / name, ignore=shutil.ignore_patterns("__pycache__"))
            files = [path for path in (target / "public").rglob("*") if path.is_file()]
            files.append(target / "src/nutrition_formula/data/public_readability.json")
            before = [path.read_bytes() for path in files]
            subprocess.run([sys.executable, "scripts/generate-agent-pages.py"], cwd=target, check=True, capture_output=True)
            self.assertEqual(before, [path.read_bytes() for path in files])

    def test_authored_missing_data_boundary(self):
        for name in ["/llms.txt", "/llms-full.txt"]:
            self.assertIn("Missing nutrient data is never treated as zero", documents()[name])



if __name__ == "__main__":
    unittest.main()
