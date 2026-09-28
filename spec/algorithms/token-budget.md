# Token Budget Allocation

Normative for both shells. Budget is enforced at two levels.

## estimateTokens

```
estimateTokens(text) = ceil(len(text) / 4)
```

Good enough for budgeting; no tokenizer dependency (zero-LLM constraint).

## List-level allocation

Applied to result lists (search results, metadata sections, browse lists):

```
allocate(items, maxTokens):
  items.sortBy(relevance, desc)          # stable: equal relevance keeps input order
  kept, dropped = [], []
  used = 0
  for item in items:
    cost = item.estimatedTokens
    if used + cost <= maxTokens:
      kept.push(item); used += cost
    else:
      dropped.push(item.id)
  return { kept, dropped, truncated: dropped.length > 0 }
```

Drop whole results; never partially cut a snippet-bearing result at this level.

In `mode=grep` the atom is a hit window (its `hits` array travels together) and the drop
unit is a document, so the rule above holds unchanged.

## Content-level truncation

Applied to single large strings (note bodies, fulltext):

```
truncate(text, budgetTokens):
  limit = budgetTokens * 4               # back to characters
  if len(text) <= limit: return { text, truncated: false }
  return { text: text[:limit], truncated: true, fullLength: len(text) }
```

A truncated response always carries `truncated: true` and, where the field exists,
`fullLength` (characters) and a `nextOffset` the agent can pass back (get_content
fulltext mode).

## Defaults

- `max_tokens` per tool comes from the tool schema default (4000; list_library 2000).
- Estimated total response size (JSON overhead included) must stay under `max_tokens`;
  if overhead alone would exceed it, return the smallest useful payload (depth degrades
  snippets -> ids) instead of an error.
