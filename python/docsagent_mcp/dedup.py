"""Result dedup (src/dedup.ts port)."""

import re


def _normalize_title(t: str) -> str:
    # JS uses /[^\p{L}\p{N}]+/gu; Python's \w is Unicode-aware, so [\W_]+ is
    # the equivalent "not a letter or digit" run.
    return re.sub(r"[\W_]+", " ", t.lower(), flags=re.UNICODE).strip()


def dedup_results(results: list) -> list:
    """Pass 1 by exact id, pass 2 by normalized title + year. First occurrence wins."""
    seen_ids: set[str] = set()
    seen_title_year: set[str] = set()
    out: list = []
    for r in results:
        rid = r.get("id")
        if rid in seen_ids:
            continue
        seen_ids.add(rid)
        title = r.get("title")
        if title:
            key = f"{_normalize_title(title)}\x00{r.get('year') or ''}"
            if key in seen_title_year:
                continue
            seen_title_year.add(key)
        out.append(r)
    return out
