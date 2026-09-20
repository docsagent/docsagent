# DocsAgent Shared Spec

Shared specification for all DocsAgent MCP shells (JS and Python). Both shells MUST read
tool definitions, error codes, and the configuration schema from this directory so that
they expose byte-identical tool schemas and identical error behavior
(DESIGN.md §3.2, §3.9).

| Path | Contents |
|---|---|
| `tools/*.json` | MCP tool definitions: `name`, `description`, `inputSchema` (JSON Schema draft-07). The file name (minus `.json`) is the tool name. |
| `errors.json` | Shell error codes, trigger conditions, and `suggested_call` hints. |
| `config.json` | JSON Schema for `~/.docsagent/config.json`, including defaults. |
| `api/README.md` | C++ core transport, JSON-RPC envelope, global ID format, method index. |
| `api/methods.json` | Request/response JSON Schemas for every core API method. |
| `algorithms/*.md` | Normative pseudocode both shells implement identically. |

## Consume rules

1. Tool registration: shell lists `tools/*.json`, advertises `description` and
   `inputSchema` verbatim in `tools/list`. No zod mirror — the JSON Schema here is the
   single source of truth.
2. Validation: tool arguments are validated against `inputSchema` (draft-07) before any
   handler runs. Validation failure is reported per `algorithms/error-mapping.md`.
3. Errors: every failure maps to a code in `errors.json`. Unknown core codes pass
   through unchanged (see `algorithms/error-mapping.md`).
4. Config: `~/.docsagent/config.json` is validated against `config.json`. Unknown keys
   are accepted and ignored (forward compatibility). Missing keys take the schema default.

## Versioning

Bump `version` in `errors.json` and this README together with any behavioral change.
Tool input schemas are append-only between minor versions: new optional properties may
be added, existing properties must not be renamed or removed.
