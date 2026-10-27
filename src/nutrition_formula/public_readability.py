"""Read-only representations of authored public pages, independent of formula storage."""
import json
import re
from functools import lru_cache
from pathlib import Path

_DATA = json.loads((Path(__file__).parent / "data/public_readability.json").read_text())
IDENTITY = _DATA["identity"]
PAGES = _DATA["pages"]
ORIGIN = IDENTITY["url"]
EXCLUDED = ["/recent-formulas/", "/api/ except /api/md and /api/ai", "/admin/", "/auth/", "/dashboard/"]


def markdown_path(path):
    return "/index.md" if path == "/" else path.rstrip("/") + ".md"


def routes():
    return [{"path": path, "url": ORIGIN + path, "md": ORIGIN + markdown_path(path),
             "title": page["title"], "description": page["description"]}
            for path, page in PAGES.items()]


def wants_markdown(accept):
    ranges = []
    for part in (accept or "").lower().split(","):
        media, *parameters = part.strip().split(";")
        weights = [value.split("=", 1)[1].strip() for value in parameters
                   if re.match(r"^q\s*=", value.strip())]
        valid = len(weights) <= 1 and (not weights or re.fullmatch(
            r"(?:0(?:\.\d{0,3})?|1(?:\.0{0,3})?)", weights[0]))
        quality = (float(weights[0]) if weights else 1) if valid else 0
        ranges.append((media.strip(), quality))

    def quality(types):
        for media in types:
            matches = [q for name, q in ranges if name == media]
            if matches:
                return min(matches)
        return 0

    return quality(["text/markdown"]) > quality(["text/html", "text/*", "*/*"])


def catalog():
    return {"name": IDENTITY["name"], "url": ORIGIN,
            "markdown": {"suffix": ".md", "negotiation": True},
            "llms": ORIGIN + "/llms.txt", "llmsFull": ORIGIN + "/llms-full.txt",
            "sitemap": ORIGIN + "/sitemap.xml", "surfaces": routes(), "exclusions": EXCLUDED}


@lru_cache(maxsize=1)
def documents():
    links = "\n".join(f'- [{r["title"]}]({r["md"]}): {r["description"]}' for r in routes())
    index = (f'# {IDENTITY["name"]}\n\n> {IDENTITY["description"]}\n\n'
             '<!-- Keep in sync with robots.txt and ai.txt. -->\n\n## Public pages\n\n' + links +
             f'\n\n## Machine-readable\n\n- [Full content]({ORIGIN}/llms-full.txt)\n'
             f'- [Markdown catalog]({ORIGIN}/api/md/_catalog)\n- [Agent catalog]({ORIGIN}/api/ai)\n'
             f'- [Sitemap]({ORIGIN}/sitemap.xml)\n- [AI usage policy]({ORIGIN}/ai.txt)\n')
    full = f'# {IDENTITY["name"]} - full content\n\n> {IDENTITY["description"]}\n\nGenerated: {IDENTITY["generated"]}\n\n'
    for path, page in PAGES.items():
        full += f'---\n<!-- source: {ORIGIN}{path} -->\n{page["body"]}\n'
    if len(full) > 500000:
        raise ValueError("Public Markdown export exceeds 500000 characters")
    policy = (f'# Keep in sync with robots.txt and llms.txt.\n[identity]\nname: {IDENTITY["name"]}\n'
              f'url: {ORIGIN}\ndescription: {IDENTITY["description"]}\ncontact: {IDENTITY["contact"]}\n\n'
              '[permissions]\nallowed: summarise, quote with attribution, cite, index for search/answers\n'
              'training: allowed on public pages only\n\n[restrictions]\nNo fabricated quotes or reviews/ratings.\n'
              'Do not present this content as your own.\nNo training on private user data.\n\n'
              f'[attribution]\ncite: {IDENTITY["name"]} and the canonical HTML URL\n\n'
              f'[scope]\nincluded: {ORIGIN}/api/md/_catalog\nexcluded: {", ".join(EXCLUDED)}\n\n'
              f'[contact]\ncontact: {IDENTITY["contact"]}\nLast updated: {IDENTITY["updated"]}\n')
    bots = ["*", "OAI-SearchBot", "ChatGPT-User", "Claude-SearchBot", "Claude-User", "PerplexityBot",
            "Perplexity-User", "GPTBot", "ClaudeBot", "Google-Extended", "Applebot-Extended", "CCBot", "Bytespider"]
    robots = "\n\n".join(f"User-agent: {bot}\nAllow: /\nDisallow: /recent-formulas/\nDisallow: /api/\n"
                          "Allow: /api/ai\nAllow: /api/md\nDisallow: /admin/\nDisallow: /auth/\nDisallow: /dashboard/"
                          for bot in bots)
    robots += f"\n\n# Keep in sync with /llms.txt and /ai.txt.\nSitemap: {ORIGIN}/sitemap.xml\n"
    return {"/llms.txt": index, "/llms-full.txt": full.rstrip() + "\n", "/ai.txt": policy, "/robots.txt": robots}


def public_response(path, method, accept=""):
    """Return Response kwargs, or None to leave existing API/assets handling untouched."""
    if method not in {"GET", "HEAD", "OPTIONS"}:
        return None
    direct = path == "/api/md" or path.startswith("/api/md/")
    suffix = path.endswith(".md") and not path.startswith(("/api/", "/.well-known/", "/fonts/"))
    document = path in documents() or path in {"/api/ai", "/api/md/_catalog"}
    canonical_path = "/case-studies/" if path == "/case-studies" else path
    negotiated = canonical_path in PAGES and wants_markdown(accept)
    if not (direct or suffix or document or negotiated):
        return None
    headers = {"Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
               "X-Content-Type-Options": "nosniff", "Cache-Control": "public, s-maxage=86400, stale-while-revalidate=604800"}
    if method == "OPTIONS":
        headers.update({"Access-Control-Allow-Headers": "Accept", "Access-Control-Max-Age": "86400"})
        return {"body": None, "status": 204, "headers": headers}
    status = 200
    if path == "/api/ai" or path == "/api/md/_catalog":
        body = json.dumps(catalog() if path == "/api/ai" else routes(), ensure_ascii=False)
        headers["Content-Type"] = "application/json; charset=utf-8"
    elif path in documents():
        body = documents()[path]
        headers["Content-Type"] = "text/plain; charset=utf-8"
    else:
        if direct:
            target = path[len("/api/md"):] or "/"
        elif suffix:
            target = path[:-3]
        else:
            target = canonical_path
        target = "/" if target == "/index" else "/case-studies/" if target == "/case-studies" else target
        page = PAGES.get(target)
        body = page["body"] if page else "# Not found\n\nNo public Markdown page exists at this path.\n"
        status = 200 if page else 404
        canonical = ORIGIN + target
        headers.update({"Content-Type": "text/markdown; charset=utf-8", "X-Robots-Tag": "noindex, follow",
                        "X-Markdown-Tokens": str((len(body) + 3) // 4), "Content-Location": canonical,
                        "Vary": "Accept", "Link": f'<{canonical}>; rel="canonical"'})
        if not page:
            headers["Cache-Control"] = "no-store"
        if negotiated or not page:
            headers.update({"CDN-Cache-Control": "no-store", "Cloudflare-CDN-Cache-Control": "no-store"})
    discovery = ", ".join(f'<{ORIGIN}/{name}>; rel="describedby"' for name in ("llms.txt", "llms-full.txt", "ai.txt"))
    headers["Link"] = (headers["Link"] + ", " if "Link" in headers else "") + discovery
    return {"body": None if method == "HEAD" else body, "status": status, "headers": headers}
