/**
 * End-to-end smoke tests for the @docsagent/mcp-zotero shell.
 * Runs the built dist/cli.js against tests/mock-core.mjs over both stdio and
 * Streamable HTTP transports, and covers the write gate, RBAC, auth, origin
 * validation, and core_unavailable startup behavior (DESIGN.md §3.4, §3.5, §8).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { startMockCore } from "./mock-core.mjs";

const CLI = new URL("../dist/cli.js", import.meta.url).pathname;
const READ_TOOLS = ["search", "get_metadata", "get_content", "list_library", "list_sources"];
const WRITE_TOOLS = ["import_item", "add_note", "batch_modify"];

function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
    srv.on("error", reject);
  });
}

async function makeConfig(tmpRoot, overrides = {}) {
  const corePort = await getFreePort();
  const configPath = path.join(tmpRoot, `config-${Math.random().toString(36).slice(2)}.json`);
  const config = {
    httpPort: corePort,
    zoteroDataDir: tmpRoot,
    zoteroApiUrl: "http://127.0.0.1:9/api",
    zoteroGroups: [],
    enableWrites: true,
    logLevel: "info",
    ...overrides,
  };
  fs.writeFileSync(configPath, JSON.stringify(config));
  return { configPath, corePort, config };
}

function startShell(configPath) {
  const child = spawn(process.execPath, [CLI], {
    env: { ...process.env, DOCSAGENT_CONFIG: configPath },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const pending = new Map();
  let nextId = 0;
  let buffer = "";
  const stderr = [];

  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    let idx;
    while ((idx = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      const waiter = pending.get(msg.id);
      if (waiter) {
        pending.delete(msg.id);
        waiter.resolve(msg);
      }
    }
  });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (c) => stderr.push(c));

  return {
    child,
    stderrText: () => stderr.join(""),
    send(obj) {
      child.stdin.write(JSON.stringify(obj) + "\n");
    },
    request(method, params, timeoutMs = 10_000) {
      const id = String(++nextId);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`timeout waiting for ${method}`));
        }, timeoutMs);
        pending.set(id, {
          resolve: (msg) => {
            clearTimeout(timer);
            resolve(msg);
          },
        });
        this.send({ jsonrpc: "2.0", id, method, params });
      });
    },
    async initialize() {
      const res = await this.request("initialize", {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "smoke", version: "0.0.0" },
      });
      this.send({ jsonrpc: "2.0", method: "notifications/initialized" });
      return res;
    },
    async callTool(name, args) {
      const res = await this.request("tools/call", { name, arguments: args ?? {} });
      const text = res.result?.content?.[0]?.text ?? "";
      return { raw: res.result, body: JSON.parse(text) };
    },
    close() {
      child.kill("SIGKILL");
      return new Promise((resolve) => child.once("exit", resolve));
    },
  };
}

function httpPost(url, { headers = {}, body } = {}) {
  return fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      // The SDK transport rejects requests without both media types (HTTP 406).
      Accept: "application/json, text/event-stream",
      "mcp-protocol-version": "2025-06-18",
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

const INITIALIZE = {
  jsonrpc: "2.0",
  id: "1",
  method: "initialize",
  params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "smoke", version: "0.0.0" } },
};

test("stdio: boots against the core, lists 8 tools, and serves reads", { timeout: 30_000 }, async (t) => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "docsagent-smoke-"));
  t.after(() => fs.rmSync(tmpRoot, { recursive: true, force: true }));
  const { configPath, corePort } = await makeConfig(tmpRoot);
  const core = await startMockCore(corePort);
  const shell = startShell(configPath);
  t.after(() => Promise.all([shell.close(), new Promise((r) => core.close(r))]));

  const init = await shell.initialize();
  assert.equal(init.result.serverInfo.name, "docsagent-mcp-zotero");
  assert.equal(init.result.serverInfo.version, "4.0.0");

  const tools = await shell.request("tools/list", {});
  const names = tools.result.tools.map((tool) => tool.name).sort();
  assert.deepEqual(names, [...READ_TOOLS, ...WRITE_TOOLS].sort());
  const searchToolSpec = tools.result.tools.find((tool) => tool.name === "search");
  assert.equal(searchToolSpec.inputSchema.properties.query.type, "string");
  assert.equal(searchToolSpec.annotations.readOnlyHint, true);

  const search = await shell.callTool("search", { query: "attention" });
  assert.equal(search.body.results[0].id, "zotero:ITEM1");
  assert.equal(search.body.results[0].title, "Attention Is All You Need");
  assert.ok(Array.isArray(search.body.results[0].snippets), "depth=snippets must attach snippets");

  const annotations = await shell.callTool("search", { query: "attention", target: "annotations" });
  const ann = annotations.body.results[0];
  assert.equal(ann.id, "zotero:ANN1");
  assert.equal(ann.text, "Scaled dot-product attention");
  assert.equal(ann.page, 3);
  assert.ok(!("snippets" in ann), "annotation results carry no snippets");

  const meta = await shell.callTool("get_metadata", { id: "zotero:ITEM1", include: ["metadata", "notes"] });
  assert.equal(meta.body.metadata.title, "Attention Is All You Need");
  assert.equal(meta.body.notes[0].text, "Follow-up reading list for transformers.");

  const passages = await shell.callTool("get_content", { id: "zotero:ITEM1", mode: "passages", query: "attention" });
  assert.equal(passages.body.type, "document");
  assert.ok(passages.body.passages.length > 0);

  const fulltext = await shell.callTool("get_content", { id: "zotero:ITEM1", mode: "fulltext", max_tokens: 200 });
  assert.equal(fulltext.body.mode, "fulltext");
  assert.ok(fulltext.body.truncated, "fulltext must respect the token budget");

  const lib = await shell.callTool("list_library", { mode: "collections" });
  assert.equal(lib.body.collections[0].name, "Transformers");

  const sources = await shell.callTool("list_sources", {});
  assert.equal(sources.body.sources[0].name, "zotero");

  const preview = await shell.callTool("add_note", { id: "zotero:ITEM1", content: "hello" });
  assert.equal(preview.body.mode, "preview");

  const missing = await shell.callTool("import_item", {});
  assert.equal(missing.raw.isError, true);
  assert.equal(missing.body.error.code, "missing_input");

  const noQuery = await shell.callTool("get_content", { id: "zotero:ITEM1", mode: "passages" });
  assert.equal(noQuery.body.error.code, "missing_query");
  assert.deepEqual(noQuery.body.error.suggested_call, { tool: "get_content", args: { mode: "fulltext" } });

  const unknown = await shell.callTool("no_such_tool", {});
  assert.equal(unknown.body.error.code, "invalid_params");
});

test("stdio: enableWrites=false hides write tools and rejects write calls", { timeout: 30_000 }, async (t) => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "docsagent-smoke-"));
  t.after(() => fs.rmSync(tmpRoot, { recursive: true, force: true }));
  const { configPath, corePort } = await makeConfig(tmpRoot, { enableWrites: false });
  const core = await startMockCore(corePort);
  const shell = startShell(configPath);
  t.after(() => Promise.all([shell.close(), new Promise((r) => core.close(r))]));

  await shell.initialize();
  const tools = await shell.request("tools/list", {});
  const names = tools.result.tools.map((tool) => tool.name).sort();
  assert.deepEqual(names, READ_TOOLS.sort());

  const res = await shell.callTool("add_note", { id: "zotero:ITEM1", content: "hello", confirmed: true });
  assert.equal(res.body.error.code, "write_disabled");
});

test("stdio: core unreachable fails fast with startup instructions, never spawning", { timeout: 15_000 }, async (t) => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "docsagent-smoke-"));
  t.after(() => fs.rmSync(tmpRoot, { recursive: true, force: true }));
  const { configPath } = await makeConfig(tmpRoot); // core port is free: nothing listens
  const exit = new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI], {
      env: { ...process.env, DOCSAGENT_CONFIG: configPath },
      stdio: ["pipe", "pipe", "pipe"],
    });
    child.stderr.setEncoding("utf8");
    let stderr = "";
    child.stderr.on("data", (c) => (stderr += c));
    child.once("exit", (code) => resolve({ code, stderr }));
  });
  const result = await exit;
  assert.equal(result.code, 1);
  assert.match(result.stderr, /DocsAgent Core is not running/);
  assert.match(result.stderr, /docsagent start/);
});

test("http: api-key auth, RBAC, origin validation, sessions, health", { timeout: 30_000 }, async (t) => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "docsagent-smoke-"));
  t.after(() => fs.rmSync(tmpRoot, { recursive: true, force: true }));
  const shellPort = await getFreePort();
  const { configPath, corePort } = await makeConfig(tmpRoot, {
    transport: "streamable-http",
    httpListenAddr: `127.0.0.1:${shellPort}`,
    authMode: "api-key",
    authConfig: { apiKeys: { "sk-admin": "admin", "sk-readonly": "readonly" } },
    rbacRoles: { readonly: READ_TOOLS },
  });
  const core = await startMockCore(corePort);
  const shell = spawn(process.execPath, [CLI], {
    env: { ...process.env, DOCSAGENT_CONFIG: configPath },
    stdio: ["pipe", "pipe", "pipe"],
  });
  t.after(() => {
    shell.kill("SIGKILL");
    return Promise.all([new Promise((r) => shell.once("exit", r)), new Promise((r) => core.close(r))]);
  });

  const base = `http://127.0.0.1:${shellPort}`;
  for (let i = 0; i < 50; i++) {
    try {
      const res = await fetch(`${base}/health`);
      if (res.ok) break;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 100));
  }

  // /health reflects core reachability
  const health = await fetch(`${base}/health`);
  assert.equal(health.status, 200);
  assert.equal((await health.json()).core, "ok");

  // no credentials -> 401 unauthorized
  const anon = await httpPost(`${base}/mcp`, { body: INITIALIZE });
  assert.equal(anon.status, 401);
  assert.equal((await anon.json()).error.code, "unauthorized");

  // bad key -> 401
  const badKey = await httpPost(`${base}/mcp`, { headers: { Authorization: "Bearer sk-wrong" }, body: INITIALIZE });
  assert.equal(badKey.status, 401);

  // foreign origin -> 403 forbidden (DNS rebinding protection)
  const evil = await httpPost(`${base}/mcp`, {
    headers: { Authorization: "Bearer sk-admin", Origin: "https://evil.example" },
    body: INITIALIZE,
  });
  assert.equal(evil.status, 403);
  assert.equal((await evil.json()).error.code, "forbidden");

  // admin session: full tool list
  const adminInit = await httpPost(`${base}/mcp`, { headers: { Authorization: "Bearer sk-admin" }, body: INITIALIZE });
  assert.equal(adminInit.status, 200);
  const adminSession = adminInit.headers.get("mcp-session-id");
  assert.ok(adminSession);
  await adminInit.json();

  const adminInitd = await httpPost(`${base}/mcp`, {
    headers: { Authorization: "Bearer sk-admin", "mcp-session-id": adminSession },
    body: { jsonrpc: "2.0", method: "notifications/initialized" },
  });
  assert.equal(adminInitd.status, 202);

  const adminTools = await httpPost(`${base}/mcp`, {
    headers: { Authorization: "Bearer sk-admin", "mcp-session-id": adminSession },
    body: { jsonrpc: "2.0", id: "2", method: "tools/list" },
  });
  const adminToolNames = (await adminTools.json()).result.tools.map((tool) => tool.name).sort();
  assert.deepEqual(adminToolNames, [...READ_TOOLS, ...WRITE_TOOLS].sort());

  const adminSearch = await httpPost(`${base}/mcp`, {
    headers: { Authorization: "Bearer sk-admin", "mcp-session-id": adminSession },
    body: { jsonrpc: "2.0", id: "3", method: "tools/call", params: { name: "search", arguments: { query: "attention" } } },
  });
  const searchBody = JSON.parse((await adminSearch.json()).result.content[0].text);
  assert.equal(searchBody.results[0].id, "zotero:ITEM1");

  // readonly session: write tools filtered from list and blocked at call
  const roInit = await httpPost(`${base}/mcp`, { headers: { Authorization: "Bearer sk-readonly" }, body: INITIALIZE });
  assert.equal(roInit.status, 200);
  const roSession = roInit.headers.get("mcp-session-id");
  await roInit.json();
  await httpPost(`${base}/mcp`, {
    headers: { Authorization: "Bearer sk-readonly", "mcp-session-id": roSession },
    body: { jsonrpc: "2.0", method: "notifications/initialized" },
  });
  const roTools = await httpPost(`${base}/mcp`, {
    headers: { Authorization: "Bearer sk-readonly", "mcp-session-id": roSession },
    body: { jsonrpc: "2.0", id: "2", method: "tools/list" },
  });
  const roToolNames = (await roTools.json()).result.tools.map((tool) => tool.name).sort();
  assert.deepEqual(roToolNames, READ_TOOLS.sort());

  const roWriteRes = await httpPost(`${base}/mcp`, {
    headers: { Authorization: "Bearer sk-readonly", "mcp-session-id": roSession },
    body: { jsonrpc: "2.0", id: "3", method: "tools/call", params: { name: "add_note", arguments: { id: "zotero:ITEM1", content: "x" } } },
  });
  const roWriteRpc = await roWriteRes.json();
  const roWriteBody = JSON.parse(roWriteRpc.result.content[0].text);
  assert.equal(roWriteBody.error.code, "forbidden");

  // unknown session -> 404 session_expired
  const ghost = await httpPost(`${base}/mcp`, {
    headers: { Authorization: "Bearer sk-admin", "mcp-session-id": "nope" },
    body: { jsonrpc: "2.0", id: "9", method: "tools/list" },
  });
  assert.equal(ghost.status, 404);
  assert.equal((await ghost.json()).error.code, "session_expired");
});
