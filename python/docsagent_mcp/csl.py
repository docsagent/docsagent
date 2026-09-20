"""CSL JSON -> Zotero item conversion (src/zotero/csl.ts port)."""

import json
import re
import urllib.request

TYPE_MAP = {
    "journal-article": "journalArticle",
    "book-chapter": "bookSection",
    "proceedings-article": "conferencePaper",
    "posted-content": "preprint",
    "report": "report",
    "thesis": "thesis",
    "book": "book",
    "dataset": "document",
}


def csl_to_zotero_item(csl: dict) -> dict:
    ztype = TYPE_MAP.get(str(csl.get("type", "")), "journalArticle")
    return {
        "itemType": ztype,
        "title": csl.get("title", ""),
        "creators": _map_creators(csl.get("author"), "author") + _map_creators(csl.get("editor"), "editor"),
        "abstractNote": csl.get("abstract", ""),
        "date": _format_date(csl.get("issued")),
        "publicationTitle": csl.get("container-title", ""),
        "volume": csl.get("volume", ""),
        "issue": csl.get("issue", ""),
        "pages": csl.get("page", ""),
        "DOI": csl.get("DOI", ""),
        "url": csl.get("URL", ""),
        "ISSN": csl.get("ISSN", ""),
        "publisher": csl.get("publisher", ""),
        "language": csl.get("language", ""),
    }


def _format_date(issued) -> str:
    if not isinstance(issued, dict):
        return ""
    parts = (issued.get("date-parts") or [None])[0]
    if not parts:
        return ""
    return "-".join(str(p) for p in parts)


def _map_creators(people, creator_type: str) -> list:
    if not isinstance(people, list):
        return []
    out = []
    for p in people:
        if not isinstance(p, dict):
            continue
        if p.get("literal"):
            out.append({"creatorType": creator_type, "name": p["literal"]})
        else:
            out.append(
                {
                    "creatorType": creator_type,
                    "firstName": p.get("given", ""),
                    "lastName": p.get("family", ""),
                }
            )
    return out


def detect_identifier(s: str) -> str | None:
    """Identifier detection: DOI / ISBN / arXiv (import_item preview path)."""
    t = s.strip()
    if re.match(r"^10\.\d{4,9}/", t, re.IGNORECASE):
        return "doi"
    if re.match(r"^arxiv:", t, re.IGNORECASE):
        return "arxiv"
    if re.match(r"^(97[89][- ]?)?\d{1,5}[- ]?\d+[- ]?\d+[- ]?[\dX]$", t, re.IGNORECASE):
        return "isbn"
    return None


def resolve_identifier(identifier: str):
    """Resolve an identifier to CSL JSON via the official Zotero translation server."""
    req = urllib.request.Request(
        url="https://translate.zotero.org/search",
        data=identifier.strip().encode("utf-8"),
        method="POST",
    )
    req.add_header("Content-Type", "text/plain")
    try:
        with urllib.request.urlopen(req, timeout=15) as res:
            if res.status < 200 or res.status >= 300:
                return None
            data = json.loads(res.read().decode("utf-8"))
    except Exception:
        return None
    return data[0] if isinstance(data, list) and data else None
