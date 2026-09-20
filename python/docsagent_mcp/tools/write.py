"""Write tools: import_item / add_note / batch_modify (JS ports).

DESIGN.md section 3.7: writes go to the Zotero local API, never through the
core; the core only re-indexes afterwards (updateIndex, best-effort).
"""

import asyncio
import json
import os
import re
from pathlib import Path

from .. import csl as csl_mod
from .. import ids, markdown
from ..context import resolve_id, text_output, write_gate
from ..errors import DocsAgentError

BATCH_SIZE = 50
BULK_CONFIRM_THRESHOLD = 20

ACTIONS = ("add_to_collection", "remove_from_collection", "add_tags", "remove_tags")


async def import_item_tool(ctx, args) -> dict:
    confirmed = write_gate(ctx, args.get("confirmed"))
    container_id = args.get("containerId") if isinstance(args.get("containerId"), str) else None
    auto_classify = args.get("autoClassify") is True

    paths = args.get("paths")
    if isinstance(paths, list):
        resolved = [str(Path(p).expanduser().resolve()) for p in paths]
        for p in resolved:
            if not os.path.exists(p):
                raise DocsAgentError("invalid_params", f"File not found: {p}")
        if not confirmed:
            items = []
            for p in resolved:
                st = os.stat(p)
                items.append(
                    {
                        "path": p,
                        "metadata": {
                            "title": Path(p).stem,
                            "contentType": "application/pdf",
                            "sizeBytes": st.st_size,
                            "source": "local file",
                        },
                        "suggestedCollections": (
                            await _suggest_collections(ctx, Path(p).name) if auto_classify else []
                        ),
                    }
                )
            return text_output({"mode": "preview", "items": items, "confirmed": False})

        results: list[dict] = []
        created_keys: list[str] = []
        for p in resolved:
            item = {
                "itemType": "attachment",
                "linkMode": "imported_file",
                "title": Path(p).name,
                "path": p,
                "contentType": "application/pdf",
                "tags": [],
                "collections": [container_id] if container_id else [],
            }
            try:
                created = await asyncio.to_thread(ctx.zotero.create_items, [item])
                key = created["success"].get("0")
                if not key:
                    results.append({"path": p, "status": "failed", "error": json.dumps(created["failed"])[:300]})
                    continue
                created_keys.append(key)
                results.append({"path": p, "status": "created", "itemKey": ids.format_global_id("zotero", key)})
            except Exception as err:
                results.append({"path": p, "status": "failed", "error": str(err)})
        await _notify_index(ctx, created_keys)
        return text_output({"results": results, "confirmed": True})

    identifiers = args["identifiers"]
    if not confirmed:
        items = []
        for identifier in identifiers:
            csl = await asyncio.to_thread(_resolve_identifier_safe, identifier)
            metadata = (
                csl_mod.csl_to_zotero_item(csl)
                if csl
                else {"title": identifier, "note": "identifier could not be resolved; will be imported as-is"}
            )
            items.append(
                {
                    "identifier": identifier,
                    "metadata": metadata,
                    "suggestedCollections": (
                        await _suggest_collections(ctx, str(csl.get("title") or "")) if auto_classify and csl else []
                    ),
                }
            )
        return text_output({"mode": "preview", "items": items, "confirmed": False})

    results: list[dict] = []
    created_keys: list[str] = []
    for identifier in identifiers:
        item: dict = {"tags": [], "collections": [container_id] if container_id else []}
        if re.match(r"^10\.\d{4,9}/", identifier.strip(), re.IGNORECASE):
            item["DOI"] = identifier.strip()
        try:
            csl = await asyncio.to_thread(_resolve_identifier_safe, identifier)
            if csl:
                item.update(csl_mod.csl_to_zotero_item(csl))
                if container_id:
                    item["collections"] = [container_id]
            else:
                item["itemType"] = "journalArticle"
                item["title"] = identifier
            created = await asyncio.to_thread(ctx.zotero.create_items, [item])
            key = created["success"].get("0")
            if not key:
                results.append({"identifier": identifier, "status": "failed", "error": json.dumps(created["failed"])[:300]})
                continue
            created_keys.append(key)
            results.append({"identifier": identifier, "status": "created", "itemKey": ids.format_global_id("zotero", key)})
        except Exception as err:
            results.append({"identifier": identifier, "status": "failed", "error": str(err)})
    await _notify_index(ctx, created_keys)
    return text_output({"results": results, "confirmed": True})


async def add_note_tool(ctx, args) -> dict:
    confirmed = write_gate(ctx, args.get("confirmed"))
    gid = resolve_id(ctx, args["id"])
    if gid.source != "zotero":
        raise DocsAgentError("capability_not_supported", "add_note currently supports the personal library only")
    content = str(args["content"])
    tags = [str(t) for t in (args.get("tags") or [])]

    if not confirmed:
        return text_output(
            {
                "mode": "preview",
                "parentId": args["id"],
                "contentPreview": content[:500],
                "tags": tags,
                "confirmed": False,
            }
        )

    parent = await asyncio.to_thread(ctx.zotero.get_item, gid.local_id)
    if not parent:
        raise DocsAgentError(
            "no_content",
            f"Parent item not found: {args['id']}",
            {"tool": "get_metadata", "args": {"id": args["id"], "include": ["metadata"]}},
        )

    note_item = {
        "itemType": "note",
        "parentItem": gid.local_id,
        "note": markdown.markdown_to_html(content),
        "tags": [{"tag": t} for t in tags],
    }
    created = await asyncio.to_thread(ctx.zotero.create_items, [note_item])
    note_key = created["success"].get("0")
    if not note_key:
        raise DocsAgentError(
            "web_api_error",
            f"zotero local api: note creation failed — {json.dumps(created['failed'])[:300]}",
        )

    # Orphan verification (DESIGN.md section 3.7): roll back and report
    # orphan_note when the note was created without its parent link.
    note = await asyncio.to_thread(ctx.zotero.get_item, note_key)
    parent_item = ((note or {}).get("data") or {}).get("parentItem")
    if parent_item != gid.local_id:
        try:
            await asyncio.to_thread(ctx.zotero.delete_item, note_key)
        except Exception:
            pass
        raise DocsAgentError(
            "orphan_note", "Note was created without its parent link; the write was rolled back"
        )

    try:
        await asyncio.to_thread(ctx.core.call, "updateIndex", {"source": "zotero", "itemKeys": [gid.local_id, note_key]})
    except Exception as err:
        ctx.logger.warn(f"updateIndex failed: {err}")
    return text_output({"noteId": ids.format_global_id("zotero", note_key), "parentId": args["id"], "confirmed": True})


async def batch_modify_tool(ctx, args) -> dict:
    confirmed = write_gate(ctx, args.get("confirmed"))
    action = args["action"]
    raw_ids = args["ids"]

    targets = []
    for raw in raw_ids:
        gid = resolve_id(ctx, raw)
        if gid.source != "zotero":
            raise DocsAgentError(
                "capability_not_supported",
                f'batch_modify currently supports the personal library only (got "{raw}")',
            )
        targets.append({"globalId": raw, "localId": gid.local_id})

    if not confirmed:
        return text_output(
            {
                "mode": "preview",
                "action": action,
                "affectedCount": len(targets),
                "sampleIds": [t["globalId"] for t in targets[:5]],
                "requiresConfirmation": len(targets) > BULK_CONFIRM_THRESHOLD,
                "confirmed": False,
            }
        )

    container_id = args.get("containerId") if isinstance(args.get("containerId"), str) else None
    tags = args.get("tags") if isinstance(args.get("tags"), list) else None

    items: list[dict] = []
    missing: list[str] = []
    for t in targets:
        raw = await asyncio.to_thread(ctx.zotero.get_item, t["localId"])
        data = (raw or {}).get("data")
        if not raw or not isinstance(data, dict):
            missing.append(t["globalId"])
            continue
        items.append(
            {
                "key": str(data.get("key") or t["localId"]),
                "version": int(data.get("version") or 0),
                "data": data,
            }
        )

    affected = 0
    for item in items:
        if _apply_action(item["data"], action, container_id, tags):
            affected += 1

    batches: list[dict] = []
    updated = 0
    failed = 0
    for i in range(0, len(items), BATCH_SIZE):
        chunk = [
            {**item["data"], "key": item["key"], "version": item["version"]}
            for item in items[i : i + BATCH_SIZE]
        ]
        created = await asyncio.to_thread(ctx.zotero.replace_items, chunk)
        ok_count = len(created["success"])
        fail_count = len(created["failed"]) if isinstance(created["failed"], dict) else 0
        updated += ok_count
        failed += fail_count
        batches.append({"batch": i // BATCH_SIZE + 1, "updated": ok_count, "failed": fail_count})

    if affected > 0:
        try:
            await asyncio.to_thread(
                ctx.core.call, "updateIndex", {"source": "zotero", "itemKeys": [i["key"] for i in items]}
            )
        except Exception as err:
            ctx.logger.warn(f"updateIndex failed: {err}")

    return text_output(
        {
            "action": action,
            "success": failed == 0,
            "affected": affected,
            "updated": updated,
            "failed": failed,
            "batches": batches,
            "missing": missing,
            "confirmed": True,
        }
    )


def _apply_action(data: dict, action: str, container_id, tags) -> bool:
    if action in ("add_to_collection", "remove_from_collection"):
        collections = list(data.get("collections") or []) if isinstance(data.get("collections"), list) else []
        idx = collections.index(container_id) if container_id in collections else -1
        if action == "add_to_collection" and idx < 0:
            data["collections"] = [*collections, container_id]
            return True
        if action == "remove_from_collection" and idx >= 0:
            data["collections"] = [c for c in collections if c != container_id]
            return True
        return False
    current = [t.get("tag") for t in data.get("tags", []) if isinstance(t, dict)]
    current = [t for t in current if isinstance(t, str)] if current else []
    seen = set(current)
    changed = False
    if action == "add_tags":
        for tag in tags or []:
            if tag not in seen:
                seen.add(tag)
                changed = True
    else:
        for tag in tags or []:
            if tag in seen:
                seen.discard(tag)
                changed = True
    if changed:
        data["tags"] = [{"tag": t} for t in seen]
    return changed


def _resolve_identifier_safe(identifier: str):
    try:
        return csl_mod.resolve_identifier(identifier)
    except Exception:
        return None


async def _notify_index(ctx, item_keys: list[str]) -> None:
    if not item_keys:
        return
    try:
        await asyncio.to_thread(ctx.core.call, "updateIndex", {"source": "zotero", "itemKeys": item_keys})
    except Exception as err:
        ctx.logger.warn(f"updateIndex failed (index will catch up): {err}")


async def _suggest_collections(ctx, title: str) -> list[str]:
    """Keyword-overlap heuristic between the title and existing collection names."""
    try:
        res = await asyncio.to_thread(ctx.core.call, "listCollections", {"source": "zotero", "parentId": None})
        collections = res.get("collections", [])
        words = {w for w in re.split(r"[^\w]+", title.lower(), flags=re.UNICODE) if len(w) > 3}
        out = []
        for c in collections:
            name_words = [w for w in re.split(r"[^\w]+", c["name"].lower(), flags=re.UNICODE) if len(w) > 3]
            if any(w in words for w in name_words):
                out.append(c["name"])
        return out[:5]
    except Exception:
        return []
