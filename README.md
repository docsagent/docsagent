# DocsAgent MCP — Zotero MCP Server 📚⚡

**`@docsagent/mcp-zotero`** is a spec-driven **MCP (Model Context Protocol) server** that lets any
AI agent — Claude Desktop, Cursor, Cline, Qwen Code, or any MCP client — search, read, and write
your **Zotero** library through a resident **C++ search engine**. Local-first RAG infrastructure
for your papers: BM25 full-text search + query-ranked passage retrieval over **1,000+ PDFs** with
**~15 ms** average retrieval latency.

- 🔒 **Local-first & private** — the engine reads `zotero.sqlite` and `storage/` directly on your
  machine. Your PDFs never leave it.
- ⚡ **Native C++ search core** — inverted-index BM25 + passage ranking, millisecond lookup,
  low memory footprint (160–227 MB for a 1,500-paper library).
- 🧩 **8 MCP tools** — 5 read + 3 write, with JSON-schema validated arguments, token budgets,
  result dedup, and a three-layer write safety gate.
- 🌐 **Two transports** — stdio for local MCP clients, Streamable HTTP for remote deployment
  (origin checks, API-key / OAuth 2.0 token introspection, per-request RBAC, `/health` probe).
- 🐍 **Two shells, one core** — this TypeScript package and a feature-equal
  [Python wrapper](python/) ship the same tools over the same JSON-RPC contract.

---

## Architecture

```
MCP Client (Claude Desktop / Cursor / Cline / Qwen Code / any MCP host)
        │  stdio (local)   or   Streamable HTTP  /mcp  (remote)
        ▼
MCP shell  ← this package (@docsagent/mcp-zotero / docsagent-mcp-zotero)
   · tool schemas (spec-driven), argument validation, token budget, dedup
   · write orchestration via the Zotero local API, write safety gate, RBAC
   · group-library sync via the Zotero Web API
        │  JSON-RPC 2.0 over HTTP ({coreHost}:{httpPort}/rpc, cpp-httplib)
        ▼
DocsAgent Core (resident C++ engine, papersgpt-agent)
   · reads ~/Zotero/zotero.sqlite + storage/ directly on your machine
   · builds & serves the full-text index (BM25 + passage ranking)
```

The shell **never spawns the core** during tool calls and never touches your Zotero files.
The core runs as a background service and stays available across MCP client restarts.
Tool schemas and error codes: [spec/](spec/).

---

## Quick Start

### 1. Start the core

```bash
npx @docsagent/mcp-zotero start           # spawn the bundled core for your platform
npx @docsagent/mcp-zotero status          # pid / endpoint / version
```

Python shell (same verbs, under the `core` subcommand):

```bash
pip install ./python                      # build the wheel locally (PyPI upload pending)
docsagent-mcp-zotero core start
```

(`core stop` / `core restart` also available. The core reads your Zotero data directory,
builds the full-text index, and serves JSON-RPC on `http://0.0.0.0:23120/rpc`.)

### 2. Configure your MCP client

Claude Desktop / Cursor / Cline / Qwen Code (`mcpServers`):

```json
{
  "mcpServers": {
    "docsagent-zotero": {
      "command": "npx",
      "args": ["-y", "@docsagent/mcp-zotero"]
    }
  }
}
```

Python shell (same tools, same contract, installed from this repo) — `mcpServers`:

```json
{
  "mcpServers": {
    "docsagent-zotero-py": {
      "command": "docsagent-mcp-zotero"
    }
  }
}
```

Install the Python package first (step 1) so `docsagent-mcp-zotero` is on your PATH.

On startup the shell connects to the core, loads sources, and checks index status. If the
core is not running it fails fast with startup instructions — it never spawns anything.

---

## MCP Tools (external API)

8 tools, 5 read + 3 write. Schemas are the single-sourced contract in
[`spec/tools/*.json`](spec/tools) (mirrored into both packages); arguments are validated
before handlers run and failures map to typed docsagent error codes.

### `list_sources`
Every searchable source with capabilities, supported targets/includes/browse modes,
filters, and document counts. **Call this first.**

### `search`
Cross-entry search over the whole library.

| Parameter | Type | Notes |
|---|---|---|
| `query` | string, required | plain keywords or phrases |
| `target` | `"items" \| "annotations" \| "notes"` or array | default `items` |
| `depth` | `ids` \| `snippets` \| `full` | snippets by default (BM25-ranked passages) |
| `filters` | object | `tags`, `yearFrom`/`yearTo`, `itemType`, `authors`, `colors`, `containerId`, `titleContains` |
| `k`, `snippetsPerResult`, `max_tokens` | numbers | ranking depth and token budget |

Returns `results[]` with global ids (`zotero:KEY`), titles, relevance, snippets; multi-target
searches group by target. Results are deduped (id, then normalized title + year) and packed
under a token budget.

### `get_content`
Read one entry. `mode=passages` (query-ranked passages, `k`) or `mode=fulltext`
(offset pagination with `nextOffset`). Notes return their body with tags and metadata.

### `get_metadata`
`include`: `metadata`, `abstract`, `annotations`, `notes`, `citation` (bibtex / csljson /
formatted via `citationFormat`/`citationStyle`). Notes are packed under the token budget.

### `list_library`
Browse modes: `collections` (drill-down via `parentId`), `items` (by `containerId`),
`tags`, `saved_searches`, `standalone_notes`.

### Write tools (three-layer safety gate)

| Tool | What it does | Key arguments |
|---|---|---|
| `import_item` | Import local PDFs or resolve DOI / ISBN / arXiv IDs (via the Zotero translation server); optional `autoClassify` suggests collections | `paths` \| `identifiers`, `containerId`, `autoClassify`, `confirmed` |
| `add_note` | Add a Markdown child note to an item (converted to Zotero note HTML), with orphan verification and rollback | `id`, `content`, `tags`, `confirmed` |
| `batch_modify` | Bulk `add_to_collection` / `remove_from_collection` / `add_tags` / `remove_tags` on up to 200 items in batches of 50 | `action`, `ids`, `containerId`, `tags`, `confirmed` |

Write safety gate (spec/algorithms/write-gate.md): **layer 1** write tools are not
registered unless `enableWrites=true`; **layer 2** `confirmed=false` returns a preview and
consumes no rate-limit quota; **layer 3** confirmed writes consume a per-hour rate limit
(default 30/h). Anything above 20 items in `batch_modify` additionally reports
`requiresConfirmation` in the preview.

---

## Engine performance

The C++ engine powers [PapersGPT](https://www.papersgpt.com/zh) — the same index and
retrieval stack ships in this MCP server. Benchmark on a real Zotero installation
([full write-up](https://www.papersgpt.com/zh/blogs/papersgpt-search-performance-benchmark)):

| Metric | Mac (Intel i9) | Windows VM (4C8G) |
|---|---|---|
| Library size | 1,506 PDFs (4.5 GB on disk) | 500+ PDFs |
| **Index build time** | **141 s** | a few seconds |
| **Memory (agent process)** | **227 MB** | **160 MB** |
| **Average retrieval latency** | **~15 ms** | **~15 ms** |

- Indexing cost scales roughly **linearly** with library size; retrieval latency stays
  **constant** — a 10,000-paper library (~30 GB) indexes in about 15–20 minutes, and
  everyday search stays at **~15 ms**.
- For comparison: a typical web page load takes 1,000–3,000 ms; a blink of an eye is
  100–150 ms. PapersGPT answers in ~15 ms, fully offline.
- Privacy: your library never leaves your machine.

## Configuration

Config lives at `~/.docsagent/config.json` (or `$DOCSAGENT_CONFIG`) — one file shared by
the JS shell, the Python wrapper, and the C++ core. Validated against
[`spec/config.json`](spec/config.json).

| Key | Default | Description |
|---|---|---|
| `coreHost` | `0.0.0.0` | Address the core binds and the shell dials |
| `httpPort` | `23120` | Core HTTP port (`POST /rpc`) |
| `coreBinary` | `""` | Optional explicit path to the core binary |
| `zoteroDataDir` | `~/Zotero` | Zotero data directory |
| `zoteroApiUrl` | `http://localhost:23119/api` | Zotero local API (write orchestration) |
| `zoteroGroups` | `[]` | Group libraries to sync from zotero.org |
| `enableWrites` | `false` | Register the three write tools |
| `writeRateLimitPerHour` | `30` | Confirmed-write rate limit |
| `maxTokensPerTool` | `4000` | Token budget per tool result |
| `defaultSource` | `zotero` | Source used when an id omits the prefix |
| `transport` | `stdio` | `stdio` or `streamable-http` |
| `httpListenAddr` | `0.0.0.0:8080` | Listen address for streamable-http (`/mcp`) |
| `authMode` / `authConfig` | `none` | `api-key` or `oauth2` (RFC 7662) + `allowedOrigins` |
| `rbacRoles` | `{}` | role → allowed tool names (per-request RBAC on HTTP) |
| `logLevel` | `info` | `debug` / `info` / `warn` / `error` |

---

## Distribution

| Channel | Package | Bundled core | Size |
|---|---|---|---|
| npm (JS/TS shell) | `@docsagent/mcp-zotero` | all platforms in `bin/` | ~70 MB tarball |
| PyPI (Python shell) | `docsagent-mcp-zotero` (`pip install ./python`) | same binaries in the wheel | ~65 MB wheel |

Both shells read the same config and talk to the same core — pick either (or both) as
your MCP distribution channel. Core lifecycle (`start` / `stop` / `restart` / `status`)
is available from both CLIs.

## Links

- [spec/](spec/) — the single-sourced contract: 8 tool schemas, 23 JSON-RPC methods,
  error codes + suggested calls, config schema
- [PapersGPT search performance benchmark](https://www.papersgpt.com/zh/blogs/papersgpt-search-performance-benchmark)
- [Zotero](https://www.zotero.org/) · [Model Context Protocol](https://modelcontextprotocol.io)

## License

Apache-2.0
