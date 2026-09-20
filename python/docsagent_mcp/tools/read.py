"""list_sources / get_content / get_metadata / list_library (JS ports)."""

import asyncio

from .. import budget, ids
from ..context import get_source_info, require_include, resolve_id, text_output
from ..errors import DocsAgentError
from ..spec import suggested_call_for

MODES = ["collections", "items", "tags", "saved_searches", "standalone_notes"]


async def list_sources_tool(ctx, _args) -> dict:
    res = await asyncio.to_thread(ctx.core.list_sources)
    ctx.sources = res.get("sources", [])
    enriched = []
    for s in ctx.sources:
        try:
            stats = await asyncio.to_thread(ctx.core.call, "getStats", {"source": s["name"]})
            enriched.append({**s, "counts": stats})
        except Exception:
            enriched.append({**s, "counts": None})
    return text_output({"sources": enriched})


async def get_content_tool(ctx, args) -> dict:
    gid = resolve_id(ctx, args["id"])
    mode = args.get("mode") or "passages"
    max_tokens = int(args.get("max_tokens") or ctx.config["maxTokensPerTool"])

    if mode == "passages":
        query = str(args.get("query") or "")
        if not query:
            raise DocsAgentError(
                "missing_query",
                "get_content with mode=passages requires a query; use mode=fulltext to page through the text",
                suggested_call_for("missing_query"),
            )
        res = await asyncio.to_thread(
            ctx.core.call,
            "searchPassages",
            {"source": gid.source, "docId": gid.local_id, "query": query, "k": int(args.get("k") or 5)},
        )
        return text_output(
            {"type": "document", "mode": "passages", "id": args["id"], "passages": res.get("passages", [])}
        )

    res = await asyncio.to_thread(
        ctx.core.call,
        "getContent",
        {
            "source": gid.source,
            "id": gid.local_id,
            "offset": int(args.get("offset") or 0),
            "limit": max_tokens * 4,
        },
    )

    cut = budget.truncate_text(res["text"], max_tokens)
    if res.get("kind") == "note":
        return text_output(
            {
                "type": "note",
                "id": args["id"],
                "noteType": res.get("noteType") or "standalone",
                "parentId": ids.format_global_id(gid.source, res["parentId"]) if res.get("parentId") else None,
                "format": "text",
                "text": cut["text"],
                "tags": res.get("tags") or [],
                "createdAt": res.get("createdAt"),
                "truncated": cut["truncated"],
                "fullLength": cut["fullLength"],
            }
        )
    return text_output(
        {
            "type": "document",
            "mode": "fulltext",
            "id": args["id"],
            "text": cut["text"],
            "offset": res.get("offset", 0),
            "nextOffset": res.get("nextOffset"),
            "totalLength": res["totalLength"],
            "truncated": cut["truncated"] or res["totalLength"] > len(res["text"]),
        }
    )


async def get_metadata_tool(ctx, args) -> dict:
    gid = resolve_id(ctx, args["id"])
    info = get_source_info(ctx, gid.source)
    include = args.get("include") or ["metadata"]
    for inc in include:
        require_include(info, inc)
    max_tokens = int(args.get("max_tokens") or ctx.config["maxTokensPerTool"])

    out: dict = {"id": args["id"], "source": gid.source}
    truncated = False
    full_length = None

    needs_item = "metadata" in include or "abstract" in include
    if needs_item:
        item = await asyncio.to_thread(ctx.core.call, "getItem", {"source": gid.source, "id": gid.local_id})
        if "metadata" in include:
            out["metadata"] = item
        if "abstract" in include:
            out["abstract"] = item.get("abstractNote") if isinstance(item, dict) else None
    if "annotations" in include:
        res = await asyncio.to_thread(
            ctx.core.call, "getAnnotations", {"source": gid.source, "id": gid.local_id}
        )
        out["annotations"] = res.get("annotations")
    if "notes" in include:
        res = await asyncio.to_thread(ctx.core.call, "getNotes", {"source": gid.source, "id": gid.local_id})
        notes = []
        used = 0
        for note in res.get("notes", []):
            body = note.get("text") or ""
            cost = budget.estimate_tokens(body)
            if used + cost <= max_tokens:
                notes.append(note)
                used += cost
                continue
            remaining_chars = max(0, (max_tokens - used) * 4)
            if remaining_chars > 0:
                notes.append({**note, "text": body[:remaining_chars]})
                truncated = True
                full_length = len(body)
            else:
                truncated = True
                full_length = len(body)
            break
        out["notes"] = notes
    if "citation" in include:
        res = await asyncio.to_thread(
            ctx.core.call,
            "getCitation",
            {
                "source": gid.source,
                "id": gid.local_id,
                "format": args.get("citationFormat") or "bibtex",
                "style": args.get("citationStyle"),
            },
        )
        out["citation"] = res.get("citation")
    if truncated:
        out["truncated"] = True
        if full_length is not None:
            out["fullLength"] = full_length
    return text_output(out)


async def list_library_tool(ctx, args) -> dict:
    mode = args.get("mode") or "collections"
    source = ctx.config["defaultSource"]
    info = get_source_info(ctx, source)
    browse_modes = info.get("browseModes") or MODES
    if mode not in browse_modes:
        supported = ", ".join(browse_modes)
        raise DocsAgentError(
            "capability_not_supported",
            f'Source "{source}" does not support browse mode "{mode}" (supported: {supported})',
        )
    limit = min(int(args.get("limit") or 50), 200)
    max_tokens = int(args.get("max_tokens") or 2000)

    key = mode
    if mode == "collections":
        res = await asyncio.to_thread(
            ctx.core.call, "listCollections", {"source": source, "parentId": args.get("parentId")}
        )
        entries = res.get("collections", [])
        key = "collections"
    elif mode == "items":
        container_id = args.get("containerId")
        if not isinstance(container_id, str) or not container_id:
            raise DocsAgentError("invalid_params", "mode=items requires containerId")
        res = await asyncio.to_thread(
            ctx.core.call, "listCollectionItems", {"source": source, "containerId": container_id}
        )
        entries = [{**it, "id": ids.format_global_id(source, str(it["id"]))} for it in res.get("items", [])]
        key = "items"
    elif mode == "tags":
        res = await asyncio.to_thread(ctx.core.call, "listTags", {"source": source})
        entries = res.get("tags", [])
        key = "tags"
    elif mode == "saved_searches":
        res = await asyncio.to_thread(ctx.core.call, "listSavedSearches", {"source": source})
        entries = res.get("searches", [])
        key = "searches"
    elif mode == "standalone_notes":
        res = await asyncio.to_thread(ctx.core.call, "listStandaloneNotes", {"source": source})
        entries = [{**n, "id": ids.format_global_id(source, str(n["id"]))} for n in res.get("notes", [])]
        key = "notes"
    else:
        raise DocsAgentError("invalid_params", f'Unknown mode "{mode}"')

    total = len(entries)
    limited = entries[:limit]
    used = 0
    kept: list = []
    for entry in limited:
        cost = budget.estimate_tokens(_dumps(entry))
        if used + cost > max_tokens:
            break
        kept.append(entry)
        used += cost
    return text_output({"mode": mode, key: kept, "total": total, "truncated": len(kept) < total})


def _dumps(obj) -> str:
    import json

    return json.dumps(obj, ensure_ascii=False)
