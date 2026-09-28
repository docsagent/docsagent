"""search tool (src/mcp/tools/search.ts port)."""

import asyncio

from .. import budget, ids
from ..context import get_source_info, require_capability, require_target, text_output
from ..dedup import dedup_results

TARGET_TO_TYPE = {"items": "item", "annotations": "annotation", "notes": "note"}
DOC_TARGETS = ("items", "notes")


async def search_tool(ctx, args) -> dict:
    mode = args.get("mode") or "relevance"
    if mode == "grep":
        return await _grep_branch(ctx, args)
    return await _relevance_branch(ctx, args)


def _targets(args) -> list:
    target = args.get("target")
    return target if isinstance(target, list) else [target or "items"]


async def _call(ctx, method, params):
    return await asyncio.to_thread(ctx.core.call, method, params)


async def _resolve(ctx, args):
    targets = _targets(args)
    source = ctx.config["defaultSource"]
    info = get_source_info(ctx, source)
    for t in targets:
        require_target(info, t)
    return source, targets, info


async def _relevance_branch(ctx, args) -> dict:
    query = str(args["query"])
    source, targets, _info = await _resolve(ctx, args)
    depth = args.get("depth") or "snippets"
    snippets_per_result = int(args.get("snippetsPerResult") or 3)
    k = int(args.get("k") or 10)
    max_tokens = int(args.get("max_tokens") or ctx.config["maxTokensPerTool"])

    res = await _call(
        ctx,
        "search",
        {"source": source, "targets": targets, "query": query, "filters": args.get("filters"), "k": k},
    )
    grouped = _group_by_target(res.get("results", []), targets)
    doc_targets = [t for t in targets if t in DOC_TARGETS]
    need_snippets = depth in ("snippets", "full") and doc_targets

    passage_map: dict[str, list] = {}
    if need_snippets:
        doc_ids: list = []
        for t in doc_targets:
            for r in grouped[t]:
                if r["id"] not in doc_ids:
                    doc_ids.append(r["id"])
        doc_ids = doc_ids[:100]
        if doc_ids:
            res2 = await _call(
                ctx,
                "batchSearchPassages",
                {"source": source, "docIds": doc_ids, "query": query, "k": snippets_per_result},
            )
            for d in res2.get("docs", []):
                passage_map[d["docId"]] = d.get("passages") or []

    full_text_map = await _fetch_full_texts(ctx, source, doc_targets, grouped, max_tokens) if depth == "full" else {}

    return _finalize(
        source,
        targets,
        grouped,
        max_tokens,
        _decorate,
        (depth, passage_map, full_text_map),
    )


async def _grep_branch(ctx, args) -> dict:
    pattern = str(args["pattern"])
    source, targets, info = await _resolve(ctx, args)
    require_capability(info, "grep")
    depth = args.get("depth") or "snippets"
    snippets_per_result = int(args.get("snippetsPerResult") or 3)
    k = int(args.get("k") or 10)
    max_tokens = int(args.get("max_tokens") or ctx.config["maxTokensPerTool"])

    # One call: the scan returns its own hit windows, so no batchSearchPassages.
    scan = await _call(
        ctx,
        "grep",
        {
            "source": source,
            "targets": targets,
            "pattern": pattern,
            "caseSensitive": args.get("caseSensitive") is True,
            "wholeWord": args.get("wholeWord") is True,
            "filters": args.get("filters"),
            "k": k,
            "maxMatches": int(args.get("maxMatches") or 1000),
            "maxSnippetsPerDoc": snippets_per_result,
        },
    )
    grouped = _group_by_target(scan.get("results") or [], targets)
    doc_targets = [t for t in targets if t in DOC_TARGETS]
    full_text_map = await _fetch_full_texts(ctx, source, doc_targets, grouped, max_tokens) if depth == "full" else {}

    return _finalize(
        source,
        targets,
        grouped,
        max_tokens,
        _decorate_grep,
        (depth, full_text_map),
        extra={"totalMatches": scan.get("totalMatches") or 0},
        extra_truncated=scan.get("truncated") is True,
    )


def _group_by_target(results: list, targets: list) -> dict[str, list]:
    return {t: [r for r in results if r.get("type") == TARGET_TO_TYPE[t]] for t in targets}


async def _fetch_full_texts(ctx, source, doc_targets, grouped, max_tokens) -> dict:
    full_text_map: dict[str, dict] = {}
    for t in doc_targets:
        for r in grouped[t]:
            res = await _call(ctx, "getContent", {"source": source, "id": r["id"], "offset": 0, "limit": max_tokens * 4})
            full_text_map[r["id"]] = {"text": res["text"], "truncated": res["totalLength"] > len(res["text"])}
    return full_text_map


def _finalize(source, targets, grouped, max_tokens, decorate, decorate_args, extra=None, extra_truncated=False) -> dict:
    """dedup -> estimate -> budget -> single-target / groups envelope (spec/algorithms/token-budget.md)."""
    groups: dict[str, dict] = {}
    any_truncated = extra_truncated
    any_dropped = 0

    for target in targets:
        decorated = [decorate(source, r, *decorate_args) for r in grouped[target]]
        deduped = dedup_results(decorated)
        with_cost = [
            {**r, "relevance": r.get("relevance") or 0, "estimatedTokens": budget.estimate_tokens(_dumps(r))}
            for r in deduped
        ]
        budgeted = budget.allocate_budget(with_cost, max_tokens)
        any_truncated = any_truncated or budgeted["truncated"]
        any_dropped += len(budgeted["droppedIds"])
        groups[target] = {
            "total": len(deduped),
            "bySource": {source: {"results": budgeted["kept"]}},
        }

    payload = dict(extra or {})
    if len(targets) == 1:
        only = groups[targets[0]]
        return text_output(
            {
                "results": only["bySource"][source]["results"],
                "total": only["total"],
                **payload,
                "truncated": any_truncated,
                "dropped": any_dropped,
            }
        )
    return text_output({"groups": groups, **payload, "truncated": any_truncated, "dropped": any_dropped})


def _dumps(obj) -> str:
    import json

    return json.dumps(obj, ensure_ascii=False)


def _base(source: str, r: dict, relevance) -> dict:
    base: dict = {"id": ids.format_global_id(source, r["id"]), "source": source, "type": r.get("type"), "relevance": relevance}
    rtype = r.get("type")
    if rtype in ("item", "attachment"):
        base["title"] = r.get("title")
        base["authors"] = r.get("authors") or []
        base["year"] = r.get("year")
    elif rtype == "annotation":
        base["itemTitle"] = r.get("itemTitle")
        base["text"] = r.get("text") or ""
        base["comment"] = r.get("comment")
        base["color"] = r.get("color")
        base["page"] = r.get("page")
    elif rtype == "note":
        base["noteType"] = r.get("noteType") or "child"
        base["parentId"] = ids.format_global_id(source, r["parentId"]) if r.get("parentId") else None
        base["excerpt"] = r.get("excerpt")
    return base


def _decorate(source: str, r: dict, depth: str, passage_map: dict, full_text_map: dict) -> dict:
    base = _base(source, r, r.get("relevance"))
    if r.get("type") == "note":
        base["excerpt"] = r.get("excerpt") or ((r.get("text") or "")[:200] or None)
    if depth == "snippets":
        passages = passage_map.get(r["id"])
        if passages:
            base["snippets"] = [
                {"text": p["text"], "page": p.get("page"), "score": p.get("score", 0)} for p in passages
            ]
    elif depth == "full":
        full = full_text_map.get(r["id"])
        if full:
            base["text"] = full["text"]
            if full["truncated"]:
                base["textTruncated"] = True
    return base


def _decorate_grep(source: str, r: dict, depth: str, full_text_map: dict) -> dict:
    # No ranking in grep mode: relevance stays 0 so the stable budget sort keeps core order.
    base = _base(source, r, 0)
    base["matchCount"] = r.get("matchCount") or 0
    base["matchesTruncated"] = r.get("matchesTruncated") is True
    if depth == "snippets":
        snippets = r.get("snippets")
        if snippets:
            base["snippets"] = [
                {
                    "text": s["text"],
                    "page": s.get("page"),
                    "field": s.get("field"),
                    "leading": s.get("leading") is True,
                    "trailing": s.get("trailing") is True,
                    "hitsTruncated": s.get("hitsTruncated") is True,
                    "hits": s.get("hits") or [],
                }
                for s in snippets
            ]
    elif depth == "full":
        full = full_text_map.get(r["id"])
        if full:
            base["text"] = full["text"]
            if full["truncated"]:
                base["textTruncated"] = True
    return base
