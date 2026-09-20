# Write Safety Gate

Normative for both shells. Three layers, all enforced by the shell
(DESIGN.md §9.4):

1. **Registration gate** — `enableWrites=false` (default): `import_item`, `add_note`,
   `batch_modify` are not registered at all; they do not appear in tools/list.
2. **Confirm gate** — a write executes only with `confirmed=true`. With
   `confirmed=false` every write tool returns a preview and performs no write.
   (batch_modify's schema documents this uniformly; the >20-item rule below is an
   additional hard floor, not a relaxation.)
3. **Bulk floor** — `batch_modify` affecting more than 20 items requires
   `confirmed=true` (already implied by layer 2) and the preview shows the affected
   count and a sample of ids.

## Preview shapes

import_item preview:

```json
{ "mode": "preview", "items": [{ "path": "...", "identifier": null, "metadata": {}, "suggestedCollections": ["key-or-name"] }] }
```

add_note preview:

```json
{ "mode": "preview", "parentId": "...", "contentPreview": "first 500 chars", "tags": [] }
```

batch_modify preview:

```json
{ "mode": "preview", "action": "...", "affectedCount": 42, "sampleIds": ["...up to 5..."] }
```

## Order of checks

`enableWrites` -> schema validation -> rate limit -> confirm gate -> execute ->
`updateIndex` notification to the core (best effort).
