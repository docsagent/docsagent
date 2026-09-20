# Error Mapping

Normative for both shells. Every failure becomes an MCP result with `isError: true`:

```json
{ "content": [{ "type": "text", "text": "{\"error\":{\"code\":\"...\",\"message\":\"...\"}}" }], "isError": true }
```

With an optional `suggested_call` inside `error` (shape from `spec/errors.json`).

## Core -> shell mapping

| Core code | Shell code | Note |
|---|---|---|
| `source_unknown` | `source_not_found` | suggested_call list_sources |
| `item_not_found` | `no_content` | message "Item not found: {id}" |
| `no_attachment` | `no_content` | message "Item has no readable content" |
| `index_not_ready` | `index_unavailable` | |
| `index_building` | `index_building` | |
| `web_api_error` | `web_api_error` | passthrough |
| `auth_failed` | `auth_failed` | passthrough |
| `invalid_params` | passthrough | shell validates first; core invalid_params signals a contract bug |
| *(anything else)* | passthrough | code kept verbatim, message prefixed "core error: " |

## Other mappings

| Failure | Shell code |
|---|---|
| Tool args fail spec JSON Schema validation | `missing_input` (import_item) / validation message with code `invalid_params` passthrough shape: `{"code":"invalid_params","message":<ajv message>}` |
| get_content mode=passages, no query | `missing_query`, suggested_call get_content(mode=fulltext) |
| Write tool with enableWrites=false (should not be registered; defense in depth) | `write_disabled` |
| Rate limiter rejects | `rate_limited` |
| HTTP connect refused (ECONNREFUSED) | `core_unavailable` + startup instructions (below) |
| Request timeout | `core_timeout` |
| Zotero local API / Web API non-2xx | `web_api_error` (message prefixed `zotero local api:` or `zotero web api:`) |
| Web API 401/403 | `auth_failed` |
| HTTP transport: bad/missing credentials | `unauthorized` |
| HTTP transport: RBAC denies tool | `forbidden` |
| HTTP transport: unknown/expired Mcp-Session-Id | `session_expired` |

## core_unavailable message (verbatim)

```
DocsAgent Core is not running.

Start it with:    docsagent-core start
Install service:  docsagent-core install
Check status:     docsagent-core status
```

The shell never starts the core itself and never falls back to a sidecar.
