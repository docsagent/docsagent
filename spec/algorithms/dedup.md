# Result Deduplication

Normative for both shells. Applied after search, before budget allocation.

## Pass 1 — exact ID

```
seen = set()
for r in results (already sorted by relevance desc):
  if r.id in seen: drop
  else: seen.add(r.id)
```

## Pass 2 — title+year similarity

Catches the same work indexed twice (e.g. preprint + published):

```
key(r) = (normalize(r.title), r.year)
normalize(t) = lowercase(t), strip punctuation, collapse whitespace
```

Same key, different id -> keep the higher-relevance occurrence (input order, since the
list is sorted), drop the rest. Items without a title are never merged in pass 2.

`r.year == null` matches only itself (key includes the null).
