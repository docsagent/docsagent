# Grep Mode (literal scan)

Normative for both shells. `search` has two modes: `relevance` (default, BM25) and `grep`
(literal scan). Wire schemas live in `api/methods.json` (`grep`) and `tools/search.json`
(`mode`); this file fixes matching, snippet, coordinate, limit, and assembly semantics.

## Why

BM25 tokenizes (`isalnum` runs), drops stop words, and stems, so punctuation/code strings
(`10.1038/s41586`, `CVE-2024-1234`), substrings (`ents` in `transformers`), and CJK
substrings are structurally unreachable. Grep is the complement: no tokenization, no
ranking, positions returned so a hit can be verified and jumped to.

## Corpus and coverage

Scans the per-page plain text the core already stores in the index (`getDocText`), never
the source files: grep covers exactly what the index covers.

- `zotero` and every `zotero-group:*` share one index. A document belongs to a source by
  its index sign prefix `{source}:{key}` — grep MUST filter by that prefix, not by "the
  index was loaded for this source".
- Obsidian has its own index. `source:"all"` = personal + obsidian, id-deduplicated.
- No PDF/HTML re-parsing at scan time. Text is byte-identical to what `getContent` /
  `getMetadata` return — in particular note and annotation bodies are raw HTML, **not**
  tag-stripped.
- A source must declare the `grep` capability in `listSources`; otherwise the shell fails
  with `capability_not_supported`.

## Matching

```
scan(text, pattern, caseSensitive, wholeWord):
  i = 0
  while i + len(pattern) <= len(text):
    hit = ascii_fold_search(text, pattern, i, caseSensitive)   # byte-wise; ASCII folding only
    if hit < 0: break
    if not wholeWord or is_boundary(text, hit, len(pattern)): emit hit
    i = hit + len(pattern)          # leftmost-longest, non-overlapping
```

- Literal only in v1 (no regex). An empty pattern is rejected by schema validation.
- Case-insensitive by default. Folding is **ASCII-only**; non-ASCII case pairs are not
  folded, and that is not an error.
- `wholeWord`: the byte before and the byte after the hit are absent or not `[A-Za-z0-9_]`.
- Advance by `len(pattern)`, not 1, so `aa` in `aaa` is one hit.
- No stop words, no stemming, no tokenization: patterns with spaces or punctuation match
  verbatim.

## Snippet window

A window is the unit of delivery and is atomic. Constants are core-internal, not part of
the wire schema: `MAX_SNIPPET_BYTES = 240`, `CONTEXT_BYTES = 60`, `MAX_HITS_PER_SNIPPET = 20`.

```
make_snippet(text, m_start, m_len):
  ls = after previous '\n' (0 if none)                  # whole line first
  le = before next '\n' (len if none)
  if le - ls > MAX_SNIPPET_BYTES:                       # one-line PDF pages
    ls = max(0, m_start - CONTEXT_BYTES)
    le = min(len(text), m_start + m_len + CONTEXT_BYTES)
  ls = utf8_floor(text, ls); le = utf8_ceil(text, le)   # never split a codepoint
  ls, le = trim_edge_space(ls, le, m_start, m_len)      # strip '\r'/blanks outside the hit
  return { text: text[ls:le], hit_start: m_start - ls,
           leading: ls > 0, trailing: le < len(text) }
```

- `trim_edge_space` MUST shift `hit_start` by the same amount it trims. `offset`/`page`/
  `line` always refer to the unmodified text.
- `\t`, `\f`, and other control bytes are returned verbatim (offsets stay valid); shells
  MUST NOT rewrite snippet text.
- Hits whose windows would overlap are merged into one window.

## Hits, counting, coordinates

```json
{ "text": "…", "page": 3, "field": null, "leading": true, "trailing": true,
  "hitsTruncated": false,
  "hits": [ { "line": 42, "column": 118, "offset": 18342, "hitStart": 4, "hitLength": 16 } ] }
```

- `matchCount` (per document) counts every hit. `hits[]` is capped at `MAX_HITS_PER_SNIPPET`
  per window, setting `hitsTruncated:true`. `matchCount` MAY exceed `hits.length` — clients
  MUST NOT use the array length as the count.
- `field` is `null` for page text, otherwise `title` | `abstract` | `tags` | `notes` |
  `annotation` (the `items` target covers page text plus item meta).
- `line`/`column` are page-relative; `column` counts **codepoints** from the line start.
- `offset` is the byte offset in the document's joined text:
  `offset = Σ(len(page_i) + 2 for i < page) + byte offset within page` — the same `"\n\n"`
  join `getContent` uses, so an `items` content hit can be passed straight back to
  `getContent(offset, limit)`. For `notes`/`annotations` targets `offset` is relative to
  that field's raw text and the client re-fetches the whole field with `getMetadata`.
- A match spanning a page boundary is not reported in v1 (pages are scanned independently).

## Limits

| Limit | On reaching it |
|---|---|
| `maxMatches` (per response) | stop scanning; `truncated: true` |
| `maxSnippetsPerDoc` | stop emitting windows for that document; its `matchesTruncated: true` |
| `maxScanBytes` | stop scanning; `truncated: true` |

Results never contain a partially cut window: a window and its `hits` travel together.
Dropping under the token budget happens at document granularity (`token-budget.md`).

## Shell assembly (identical in both shells)

1. `mode = "grep"` dispatches to one core `grep` call. **No `batchSearchPassages`** — the
   scan returns its own snippets. `caseSensitive`, `wholeWord`, `maxMatches`,
   `snippetsPerResult` (as `maxSnippetsPerDoc`), `k`, `filters`, `target` pass through.
2. Each returned document is decorated by the normal path; windows attach to `snippets[]`
   with the extra `leading`/`trailing`/`hits`/`hitsTruncated` keys. `score` is absent.
   Snippets are attached for the document targets (`items`, `notes`) only — an
   `annotations` hit is already carried by its `text` field, matching the BM25 rule.
3. `relevance` is `0` for every result; order is the core's order (document order, then
   first-hit offset), preserved by the stable budget sort.
4. `depth:"ids"` drops `snippets` and keeps `matchCount`; `depth:"snippets"` (default)
   attaches them; `depth:"full"` keeps the existing per-document `getContent` path.
5. Grouping, `dedupResults`, `estimateTokens`, `allocateBudget`, and the single-target /
   `groups` envelopes are unchanged. `total` counts documents; the response adds
   `totalMatches` and `scanned`.
