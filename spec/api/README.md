# DocsAgent Core API Contract

The C++ search core exposes **JSON-RPC 2.0** over a local transport. The MCP shells are
the only intended clients. This document fixes the envelope, framing, and ID format;
`methods.json` fixes per-method request/response schemas.

## Transport

**HTTP**: `POST http://{coreHost}:{httpPort}/rpc`, default port 23120 (`coreHost`
defaults to `0.0.0.0`). There is no Unix socket / named pipe transport — both core builds
speak HTTP and nothing else, so the shell has exactly one endpoint to try, on every
platform.

The core binds `0.0.0.0`, so it is reachable from other machines as well as from the host
itself. `coreHost` is what the shell dials — set it to the core's IP when the shell runs
elsewhere. The endpoint has no authentication: restrict it with a firewall if the host is
on an untrusted network.

If it is not reachable the shell fails with `core_unavailable` and startup instructions.
The shell **never spawns the core** (DESIGN.md §2.1).

## Envelope

Standard JSON-RPC 2.0. Requests carry string ids; the core echoes them.

```json
{"jsonrpc":"2.0","id":"1","method":"search","params":{"query":"transformers"}}
```

Success:

```json
{"jsonrpc":"2.0","id":"1","result":{...}}
```

Error — the domain error code rides in `data.code`:

```json
{"jsonrpc":"2.0","id":"1","error":{"code":-32603,"message":"index is building","data":{"code":"index_building"}}}
```

## Framing

One request, one JSON object response. No SSE, no chunked JSON-RPC, no batching.

## Timeouts

Shell-side request timeout is 30s (`core_timeout` on expiry). `indexGroupData` /
`syncGroupIndex` requests use a 300s timeout.

## Global ID format

`{source}:{localId}` where `source` is a registered source name:

- Personal library: `zotero:ABCD1234`
- Group library: `zotero-group:12345:ABCD1234` (source `zotero-group:12345`)
- Obsidian note: `obsidian:<vault-relative path>`
- Apple Note (macOS only): `apple-notes:<note UUID>`

Parsing: for `zotero-group:{gid}:{key}` split on the second colon; otherwise split on
the first colon. Shells validate the source against `listSources` and return
`source_not_found` for unknown prefixes.

## Method index

| Group | Methods |
|---|---|
| Data | `getItem` `getAnnotations` `getNotes` `getStandaloneNote` `getContent` `listCollections` `listCollectionItems` `listTags` `listSavedSearches` `listStandaloneNotes` `getCitation` `getStats` |
| Retrieval | `search` `searchPassages` `batchSearchPassages` `grep` |
| Index | `buildIndex` `updateIndex` `indexGroupData` `syncGroupIndex` `deleteGroupIndex` `indexStatus` |
| System | `health` `listSources` |

## Core error codes

`item_not_found` `no_attachment` `index_not_ready` `index_building` `source_unknown`
`invalid_params` `web_api_error` `auth_failed`

Shells map these onto shell error codes per `algorithms/error-mapping.md`.

## Multi-client behavior

The core serves multiple concurrent clients; indexes are shared and updates immediately
visible. Group syncs triggered by concurrent requests are coalesced by the core
(DESIGN.md §14.3) — the shell does not need to coordinate with other shells.
