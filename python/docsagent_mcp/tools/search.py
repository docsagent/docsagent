"""search tool (src/mcp/tools/search.ts port)."""

import asyncio

from .. import budget, ids
from ..context import get_source_info, require_target, resolve_id, text_output
from ..dedup import dedup_results

TARGET_TO_TYPE = {"items": "item", "annotations": "annotation", "notes": "note"}


async def search_tool(ctx, args) -> dict:
    query = str(args["query"])
    targets = args["target"] if isinstance(args.get("target"), list) else [args.get("target") or "items"]
    depth = args.get("depth") or "snippets"
    snippets_per_result = int(args.get("snippetsPerResult") or 3)
    k = int(args.get("k") or 10)
    max_tokens = int(args.get("max_tokens") or ctx.config["maxTokensPerTool"])

    source = ctx.config["defaultSource"]
    info = get_source_info(ctx, source)
    for t in targets:
        require_target(info, t)

    res = await asyncio.to_thread(
        ctx.core.call,
        "search",
        {"source": source, "targets": targets, "query": query, "filters": args.get("filters"), "k": k},
    )
    results = res.get("results", [])

    grouped: dict[str, list] = {t: [] for t in targets}
    for r in results:
        for t in targets:
            if r.get("type") == TARGET_TO_TYPE[t]:
                grouped[t].append(r)

    doc_targets = [t for t in targets if t in ("items", "notes")]
    need_snippets = depth in ("snippets", "full") and doc_targets

    passage_map: dict[str, list] = {}
    if need_snippets:
        doc_ids = []
        for t in doc_targets:
            for r in grouped[t]:
                if r["id"] not in doc_ids:
                    doc_ids.append(r["id"])
        doc_ids = doc_ids[:100]
        if doc_ids:
            res2 = await asyncio.to_thread(
                ctx.core.call,
                "batchSearchPassages",
                {"source": source, "docIds": doc_ids, "query": query, "k": snippets_per_result},
            )
            for d in res2.get("docs", []):
                passage_map[d["docId"]] = d.get("passages") or []

    full_text_map: dict[str, dict] = {}
    if depth == "full":
        for t in doc_targets:
            for r in grouped[t]:
                res3 = await asyncio.to_thread(
                    ctx.core.call,
                    "getContent",
                    {"source": source, "id": r["id"], "offset": 0, "limit": max_tokens * 4},
                )
                full_text_map[r["id"]] = {
                    "text": res3["text"],
                    "truncated": res3["totalLength"] > len(res3["text"]),
                }

    groups: dict[str, dict] = {}
    any_truncated = False
    any_dropped = 0

    for target in targets:
        decorated = [_decorate(source, r, depth, passage_map, full_text_map) for r in grouped[target]]
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

    if len(targets) == 1:
        only = groups[targets[0]]
        return text_output(
            {
                "results": only["bySource"][source]["results"],
                "total": only["total"],
                "truncated": any_truncated,
                "dropped": any_dropped,
            }
        )
    return text_output({"groups": groups, "truncated": any_truncated, "dropped": any_dropped})


def _dumps(obj) -> str:
    import json

    return json.dumps(obj, ensure_ascii=False)


def _decorate(source: str, r: dict, depth: str, passage_map: dict, full_text_map: dict) -> dict:
    gid = ids.format_global_id(source, r["id"])
    base: dict = {"id": gid, "source": source, "type": r.get("type"), "relevance": r.get("relevance")}
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
