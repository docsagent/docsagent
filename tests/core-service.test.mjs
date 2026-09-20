/**
 * Tests for the core lifecycle commands (start / stop / restart / status) —
 * src/core-service.ts. Uses a stub "core" (a Node HTTP server answering the
 * JSON-RPC `health` method) spawned through dist/cli.js with coreBinary
 * pointing at the stub, so the real service path is exercised end to end.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import os from "node:os";

const CLI = new URL("../dist/cli.js", import.meta.url).pathname;

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

/** Stub core binary: HTTP JSON-RPC server answering `health`. */
const STUB_CORE = `
import http from "node:http";
const port = Number(process.env.FAKE_CORE_PORT);
const srv = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    let id = "1";
    try { id = JSON.parse(body || "{}").id ?? "1"; } catch {}
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ jsonrpc: "2.0", id, result: { status: "ok", version: "stub-core-1.0.0", uptimeSec: 1 } }));
  });
});
srv.listen(port, "127.0.0.1");
`;

function makeEnvironment(t, port) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "docsagent-corectl-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const stubPath = path.join(root, "stub-core.mjs");
  fs.writeFileSync(stubPath, STUB_CORE);
  const configPath = path.join(root, "config.json");
  fs.writeFileSync(
    configPath,
    JSON.stringify({ httpPort: port, coreBinary: stubPath }),
  );
  return { root, configPath };
}

function runCli(args, configPath, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      env: { ...process.env, ...env, DOCSAGENT_CONFIG: configPath },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (c) => (out += c));
    child.stderr.on("data", (c) => (err += c));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, out, err }));
  });
}

test("start / status / stop / restart manage a background core process", async (t) => {
  const port = await getFreePort();
  const { root, configPath } = makeEnvironment(t, port);

  const start = await runCli(["start"], configPath, { FAKE_CORE_PORT: String(port) });
  assert.equal(start.code, 0, `start failed: ${start.err}`);
  assert.match(start.out, /Core started/);
  const pidFile = path.join(root, "core.pid");
  assert.ok(fs.existsSync(pidFile), "pid file written next to config");
  const pid = Number(fs.readFileSync(pidFile, "utf8").trim());
  assert.ok(pid > 0);
  try {
    process.kill(pid, 0);
  } catch (e) {
    assert.fail(`expected a live core process, got ${e.code}`);
  }

  const status = await runCli(["status"], configPath, {});
  assert.equal(status.code, 0, `status failed: ${status.err}`);
  assert.match(status.out, /running/);
  assert.match(status.out, /stub-core-1\.0\.0/);

  const stop = await runCli(["stop"], configPath, {});
  assert.equal(stop.code, 0, `stop failed: ${stop.err}`);
  assert.match(stop.out, /stopped|terminated/i);
  assert.throws(() => process.kill(pid, 0), (e) => e.code === "ESRCH", "core process is gone after stop");
  assert.ok(!fs.existsSync(pidFile), "pid file removed after stop");

  const start2 = await runCli(["start"], configPath, { FAKE_CORE_PORT: String(port) });
  assert.equal(start2.code, 0, `restart-start failed: ${start2.err}`);

  const stop2 = await runCli(["stop"], configPath, {});
  assert.equal(stop2.code, 0);
});

test("stop and status report gracefully when no core is running", async (t) => {
  const port = await getFreePort();
  const { configPath } = makeEnvironment(t, port);

  const stop = await runCli(["stop"], configPath, {});
  assert.equal(stop.code, 0);
  assert.match(stop.out, /not running/i);

  const status = await runCli(["status"], configPath, {});
  assert.equal(status.code, 0);
  assert.match(status.out, /not running/i);
});

test("start reports an already-running core without spawning a second one", async (t) => {
  const port = await getFreePort();
  const { root, configPath } = makeEnvironment(t, port);

  const first = await runCli(["start"], configPath, { FAKE_CORE_PORT: String(port) });
  assert.equal(first.code, 0, first.err);

  const second = await runCli(["start"], configPath, { FAKE_CORE_PORT: String(port) });
  assert.equal(second.code, 0, second.err);
  assert.match(second.out, /already running/i);

  // pid file still points at the first process, and that process is still alive
  const pidFile = path.join(root, "core.pid");
  assert.ok(fs.existsSync(pidFile));
  const pid = Number(fs.readFileSync(pidFile, "utf8").trim());
  try {
    process.kill(pid, 0);
  } catch (e) {
    assert.fail(`expected the first core process to still be alive: ${e.code}`);
  }

  await runCli(["stop"], configPath, {});
});
