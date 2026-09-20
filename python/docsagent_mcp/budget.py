"""Token budget helpers (src/budget.ts port)."""

import math


def estimate_tokens(text) -> int:
    """~4 chars per token; budgeting only, no tokenizer dependency."""
    if not text:
        return 0
    return math.ceil(len(text) / 4)


def allocate_budget(items: list, max_tokens: int) -> dict:
    """List-level allocation: sort by relevance desc, accumulate whole items."""
    sorted_items = sorted(items, key=lambda r: r.get("relevance") or 0, reverse=True)
    kept: list = []
    dropped_ids: list[str] = []
    used = 0
    for item in sorted_items:
        cost = item.get("estimatedTokens", 0)
        if isinstance(cost, (int, float)) and math.isfinite(cost) and used + cost <= max_tokens:
            kept.append(item)
            used += cost
        else:
            dropped_ids.append(item.get("id", ""))
    return {"kept": kept, "droppedIds": dropped_ids, "truncated": len(dropped_ids) > 0}


def truncate_text(text: str, budget_tokens: int) -> dict:
    """Content-level truncation."""
    limit = max(1, budget_tokens) * 4
    if len(text) <= limit:
        return {"text": text, "truncated": False, "fullLength": len(text)}
    return {"text": text[:limit], "truncated": True, "fullLength": len(text)}
