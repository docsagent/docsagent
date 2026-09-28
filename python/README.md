# DocsAgent MCP shell for Zotero (Python)

<!-- mcp-name: io.github.docsagent/docsagent -->

Python port of the TypeScript [`@docsagent/mcp-zotero`](../) shell — an MCP
server that talks to the resident [DocsAgent C++ search core](../../spec/api/)
over `POST http://{coreHost}:{httpPort}/rpc`. Same tool names, same schemas
(loaded verbatim from `spec/tools/*.json`), same error codes, same write gate.

## Install

```bash
# from this repo
pip install ./python          # or: uv tool install ./python
```

Dependencies: `mcp>=2.2,<2.3` (official SDK), `jsonschema` (spec validation). Python ≥ 3.10.

## Run

```bash
docsagent-mcp-zotero                        # stdio transport (default)
docsagent-mcp-zotero --transport streamable-http   # HTTP on config.httpListenAddr
python -m docsagent_mcp ...                 # same, without installing
```

Config comes from `~/.docsagent/config.json` (or `$DOCSAGENT_CONFIG`) — the same
file the JS shell and the C++ core read. Environment overrides: `DOCSAGENT_CONFIG`,
`DOCSAGENT_SPEC_DIR`.

## MCP client registration

```json
{
  "mcpServers": {
    "docsagent-zotero": {
      "command": "docsagent-mcp-zotero",
      "args": []
    }
  }
}
```

## Bundled core + lifecycle

The wheel ships the C++ core binaries for every supported platform (`docsagent_mcp/bin/`,
the same files as the npm package's `bin/`): macOS universal (Intel + Apple Silicon),
Windows x64, Linux x64 — **Linux ARM is not supported** — plus their dylibs. Manage the resident
core from the same CLI:

```bash
docsagent-mcp-zotero core start     # spawn the bundled core for this platform
docsagent-mcp-zotero core status    # pid / endpoint / version
docsagent-mcp-zotero core stop
docsagent-mcp-zotero core restart
```

The core is spawned detached with `DOCSAGENT_HTTP_PORT` / `DOCSAGENT_ROOT_DIR`
and the dylib search path pointed at the bundled `bin/` (wheels do not preserve
the executable bit, so the launcher chmods the binary on first use). State
(pid/log) lives next to the config file in `~/.docsagent/`.

## Tools

`list_sources`, `list_library`, `search`, `get_content`, `get_metadata`,
`import_item`, `add_note`, `batch_modify` — schemas in [`docsagent_mcp/spec/tools/`](docsagent_mcp/spec/tools/)
(synced from `spec/tools/`, single-sourced contract).

- Read tools proxy to the core (`search` → `search` + `batchSearchPassages`,
  `get_content` → `searchPassages`/`getContent`, …) with the same token budget,
  dedup, and depth semantics as the JS shell.
- Write tools go to the **Zotero local API** (`http://localhost:23119/api`),
  never through the core; the core only re-indexes afterwards (`updateIndex`,
  best-effort). Writes require `enableWrites=true` in config, `confirmed=true`
  in the call, and consume the per-hour write rate limit.

## Parity with the JS shell

Same: server name/version, tool set + schemas, annotations, `list_tools`
gating (`enableWrites` / RBAC roles), write gate + rate limiter, global id
format, token budget/dedup algorithms, error codes and `suggested_call`
hints, config keys and defaults, stdio transport.

Differences (v1):

| Area | JS shell | Python wrapper |
|---|---|---|
| Streamable HTTP | per-session servers | per-request bearer auth (`authMode` none / api-key / oauth2 RFC 7662), origin checks, per-request RBAC; session keeps the role of whoever initialized it |

## Development

```bash
python3 python/sync_spec.py          # refresh the packaged spec copy from spec/
uv venv python/.venv && uv pip install --python python/.venv/bin/python -e ./python
python/.venv/bin/docsagent-mcp-zotero --transport stdio
```
