# Write Rate Limiting

Normative for both shells. Enforced by the shell, per process, before any write executes.

```
window = floor(now / 3600s)          # fixed one-hour window, UTC
count  = counters[window] ?? 0
if count + 1 > config.writeRateLimitPerHour:  # default 30
    reject with code rate_limited
    message includes remaining quota reset time (window end)
counters[window] = count + 1
```

- One unit per write call, regardless of item count (a 50-item batch_modify is one unit).
- Counters are in-memory; process restart resets them. The core's own accounting and
  Zotero remain the backstop.
- Applies to `import_item` (confirmed write), `add_note` (confirmed write), and
  `batch_modify` (confirmed write). Previews (confirmed=false) do not consume quota.
