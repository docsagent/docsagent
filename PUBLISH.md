# Publishing guide — @docsagent/mcp-zotero (JS) + docsagent-mcp-zotero (Python)

Artifacts in this repo (already built & smoke-tested):

| File | What |
|---|---|
| `docsagent-mcp-zotero-4.0.0.tgz` | npm tarball (includes `bin/` with all-platform core binaries) |
| `python/dist/docsagent_mcp_zotero-4.0.0-py3-none-any.whl` (+ sdist) | PyPI wheel (same bundled core) |
| `mcp-registry/server.json` | official MCP Registry submission payload |
| `smithery.yaml` | Smithery config |

## 1. npm registry (JS)

```bash
npm login                      # browser flow; account must own the @docsagent scope
npm publish docsagent-mcp-zotero-4.0.0.tgz
```

If the `@docsagent` scope does not exist yet: create it at
https://www.npmjs.com/org/new (free), or publish unscoped first.

## 2. PyPI (Python)

`~/.pypirc` currently only has `[testpypi]` credentials.

```bash
# validation upload (already-configured testpypi credentials)
twine upload --repository testpypi python/dist/*

# production: create an API token at https://pypi.org/manage/account/token/
twine upload -u __token__ -p <pypi-token> python/dist/*
```

## 3. Official MCP Registry (registry.modelcontextprotocol.io)

1. Publish npm + PyPI first (the registry resolves identities through them).
2. Submit `mcp-registry/server.json` via https://github.com/modelcontextprotocol/registry
   (PR or the registry API). Name is `io.github.docsagent/zotero` — verified through the
   `docsagent` GitHub organization.

## 4. Smithery (smithery.ai)

```bash
npx @smithery/cli publish      # interactive login; uses ./smithery.yaml
```

## 5. Directories (web-form submissions, no CLI)

| Platform | Where |
|---|---|
| PulseMCP | https://www.pulsemcp.com/submit |
| Glama | https://glama.ai/mcp/servers → "Add server" (points at the GitHub repo) |
| mcp.so | submit via https://mcp.so (repo URL) |
| Cursor directory | https://cursor.directory/submit |
| Cline MCP Marketplace | PR to the cline/mcp-marketplace repo |
