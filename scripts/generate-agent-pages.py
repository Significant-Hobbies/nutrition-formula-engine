"""Compile the two authored public pages; never load saved formulas or API data."""
import html
import json
import re
import shutil
import sys
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import urljoin, urlparse

ROOT = Path(__file__).resolve().parents[1]
PUBLIC = ROOT / "public"
OUTPUT = ROOT / "src/nutrition_formula/data/public_readability.json"
FILES = ["index.md", "case-studies.md", "llms.txt", "llms-full.txt", "ai.txt", "robots.txt", "_headers"]


class SourcePage(HTMLParser):
    """Read literal main-template text, excluding hidden result and user-state panels."""
    VOID = {"input", "img", "br", "hr", "meta", "link", "source", "wbr", "path"}
    SKIP = {"script", "style", "svg", "nav", "footer", "dialog", "template"}

    def __init__(self, origin):
        super().__init__(convert_charrefs=True)
        self.origin = origin
        self.stack = []
        self.parts = []
        self.description = ""
        self.title = ""
        self.in_title = False

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if tag == "meta" and attrs.get("name") == "description":
            self.description = attrs.get("content", "")
        parent = self.stack[-1] if self.stack else ("", False, False, "")
        inside = tag == "main" or parent[1]
        skip = parent[2] or tag in self.SKIP or "hidden" in attrs or attrs.get("aria-hidden") == "true" or attrs.get("type") == "hidden"
        if tag not in self.VOID:
            self.stack.append((tag, inside, skip, attrs.get("href", "")))
        if not inside or skip:
            return
        if tag in {"p", "section", "div", "label", "summary", "button"}:
            self.parts.append("\n\n")
        elif tag in {"dt", "option"}:
            self.parts.append("\n- ")
        elif tag == "dd":
            self.parts.append(" ")
        elif tag in {"h1", "h2", "h3"}:
            self.parts.append("\n\n" + "#" * int(tag[1]) + " ")
        elif tag == "li":
            self.parts.append("\n- ")
        elif tag == "a":
            self.parts.append("[")
        elif tag in {"input", "textarea"}:
            placeholder = attrs.get("placeholder")
            if tag == "input" and attrs.get("value"):
                self.parts.append(": " + attrs["value"])
            if placeholder:
                self.parts.append("\n\n```text\n" + placeholder + "\n```\n\n")
        self.in_title = tag == "h1" or self.in_title

    def handle_endtag(self, tag):
        if tag in self.VOID:
            return
        index = next((i for i in range(len(self.stack) - 1, -1, -1) if self.stack[i][0] == tag), None)
        if index is None:
            return
        _, inside, skip, href = self.stack[index]
        self.stack = self.stack[:index]
        if inside and not skip:
            if tag in {"dd", "option"}:
                self.parts.append("\n")
            elif tag == "a":
                self.parts.append("](" + urljoin(self.origin + "/", href) + ")")
            elif tag in {"p", "h1", "h2", "h3", "section", "div", "label", "summary", "button"}:
                self.parts.append("\n\n")
        if tag == "h1":
            self.in_title = False

    def handle_data(self, text):
        if self.stack and self.stack[-1][1] and not self.stack[-1][2]:
            text = re.sub(r"\s+", " ", text)
            self.parts.append(text)
            if self.in_title:
                self.title += text

    def markdown(self):
        body = "".join(self.parts)
        body = re.sub(r"[ \t]+\n", "\n", body)
        body = re.sub(r"\n[ \t]+", "\n", body)
        return re.sub(r"\n{3,}", "\n\n", body).strip()


def cell(value):
    return str(value).replace("|", "\\|").replace("\n", " ")


def main():
    if "--copy-to-dist" in sys.argv:
        for name in FILES:
            shutil.copyfile(PUBLIC / name, ROOT / "dist" / name)
        return
    schema = re.search(r'<script type="application/ld\+json">([\s\S]*?)</script>', (PUBLIC / "index.html").read_text())
    website = json.loads(schema[1])
    if website.get("@type") != "WebSite":
        raise ValueError("Expected existing homepage WebSite identity")
    identity = {
        "name": website["name"], "url": website["url"].rstrip("/"),
        "contact": "https://sarthakagrawal.dev", "updated": "2026-10-27",
        "generated": "2026-10-27",  # Authored generation revision; builds are reproducible.
    }
    pages = {}
    for route, filename in {"/": "index.html", "/case-studies/": "case-studies/index.html"}.items():
        path = PUBLIC / filename
        source = path.read_text()
        parser = SourcePage(identity["url"])
        parser.feed(source)
        title = parser.title.strip()
        body = parser.markdown().replace("# " + title, "", 1).strip()
        canonical = identity["url"] + route
        prefix = f"# {title}\n\n> {parser.description}\n\nCanonical: {canonical}\n\n"
        if route == "/":
            identity["description"] = parser.description
        elif route == "/case-studies/":
            data = json.loads((PUBLIC / "case-studies.json").read_text())
            prefix += f"Evidence as of: {data['as_of']}\n\n"
            for study in data["cases"]:
                if urlparse(study["source_url"]).scheme not in {"http", "https"}:
                    raise ValueError("Invalid public case-study source URL")
                comparisons = study.get("components") or [study]
                body += f"\n\n### {study['product']}\n\n[View {study['source']} source]({study['source_url']})\n\n"
                body += "| Value | Published | Calculated | Difference |\n| --- | --- | --- | --- |\n"
                for row in comparisons:
                    body += "| " + " | ".join(cell(row[key]) for key in ("component", "declared", "predicted")) + " | " + cell(row["difference_percent"]) + "% |\n"
                if study.get("assumption"):
                    body += "\nWhat we assumed: " + study["assumption"] + "\n"
        pages[route] = {"title": title, "description": parser.description, "body": prefix + re.sub(r"\n{3,}", "\n\n", body).rstrip() + "\n"}
        suffix = "/index.md" if route == "/" else route.rstrip("/") + ".md"
        tags = f'<meta name="ai-summary" content="{html.escape(parser.description, quote=True)}" />\n    <link rel="alternate" type="text/markdown" href="{identity["url"]}{suffix}" />'
        source = re.sub(r'\n?[ \t]*<meta name="ai-summary"[^>]*>\s*<link rel="alternate" type="text/markdown"[^>]*>\n?', "\n", source)
        path.write_text(re.sub(r"[ \t]*</head>", lambda _: "    " + tags + "\n  </head>", source))
    OUTPUT.write_text(json.dumps({"identity": identity, "pages": pages}, indent=2, ensure_ascii=False) + "\n")
    sys.path.insert(0, str(ROOT / "src"))
    from nutrition_formula.public_readability import documents, routes, markdown_path
    for route, page in pages.items():
        (PUBLIC / markdown_path(route).lstrip("/")).write_text(page["body"])
    for name, body in documents().items():
        if name.endswith(".txt"):
            (PUBLIC / name.lstrip("/")).write_text(body)
    headers = []
    described = ", ".join(f'<{identity["url"]}/{name}>; rel="describedby"' for name in ("llms.txt", "llms-full.txt", "ai.txt"))
    for route in routes():
        headers += [route["path"], f'  Link: {described}, <{route["md"]}>; rel="alternate"; type="text/markdown"', "  Vary: Accept"]
        headers += [markdown_path(route["path"]), "  Content-Type: text/markdown; charset=utf-8", "  X-Robots-Tag: noindex, follow", "  Access-Control-Allow-Origin: *", f'  Content-Location: {route["url"]}', f'  X-Markdown-Tokens: {(len(pages[route["path"]]["body"]) + 3) // 4}']
    for name in ("llms.txt", "llms-full.txt", "ai.txt", "robots.txt"):
        headers += ["/" + name, "  Content-Type: text/plain; charset=utf-8", "  Access-Control-Allow-Origin: *", "  Cache-Control: public, s-maxage=86400, stale-while-revalidate=604800"]
    (PUBLIC / "_headers").write_text("\n".join(headers) + "\n")
    print(f"Generated {len(pages)} authored public pages; saved formulas excluded")


if __name__ == "__main__":
    main()
