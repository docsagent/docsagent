import { spawn } from "child_process";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { configPath, expandHome, type DocsAgentConfig } from "./config.js";
import { CoreClient } from "./core/client.js";
import { DocsAgentError } from "./errors.js";

/**
 * Lifecycle management for the resident C++ core (DESIGN.md §2.1, §13).
 * The MCP shell itself never spawns the core; these commands exist so one
 * shell/CLI invocation can start, stop, restart or inspect the core as a
 * background process. State (pid/log) lives next to the config file.
 */

const START_WAIT_MS = 15_000;
const STOP_GRACE_MS = 10_000;
const POLL_INTERVAL_MS = 150;
const HEALTH_TIMEOUT_MS = 1_500;

export interface CoreStartResult {
  started: boolean;
  pid?: number;
  endpoint: string;
}

export interface CoreStopResult {
  stopped: boolean;
  pid?: number;
}

export interface CoreStatus {
  pid?: number;
  running: boolean;
  reachable: boolean;
  version?: string;
  uptimeSec?: number;
  endpoint: string;
}

export type ServiceCommand = "start" | "stop" | "restart" | "status";

export function serviceDir(): string {
  return path.dirname(configPath());
}

export function pidFile(): string {
  return path.join(serviceDir(), "core.pid");
}

export function logFile(): string {
  return path.join(serviceDir(), "core.log");
}

function readPid(): number | undefined {
  try {
    const raw = fs.readFileSync(pidFile(), "utf8").trim();
    const pid = Number(raw);
    return Number.isInteger(pid) && pid > 0 ? pid : undefined;
  } catch {
    return undefined;
  }
}

export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Readiness probe used by start/restart/status: a `health` JSON-RPC call over
 * HTTP (POST http://{coreHost}:{httpPort}/rpc).
 */
export async function isCoreReachable(
  config: DocsAgentConfig,
  timeoutMs = HEALTH_TIMEOUT_MS,
): Promise<{ version?: string; uptimeSec?: number } | undefined> {
  const client = new CoreClient(config);
  try {
    const health = await client.call<{ status: string; version: string; uptimeSec?: number }>("health", undefined, {
      timeoutMs,
    });
    return { version: health.version, uptimeSec: health.uptimeSec };
  } catch {
    return undefined;
  }
}

const BUNDLED_BINARIES: Record<string, string> = {
  // One universal (x86_64 + arm64) binary serves every mac.
  "darwin-arm64": "docsagent-universal-apple-darwin",
  "darwin-x64": "docsagent-universal-apple-darwin",
  "linux-x64": "docsagent-linux-gnu",
  // The Linux core is built for x86_64 only — Linux ARM is not supported.
  "win32-x64": "docsagent-x86_64-pc-windows-msvc.exe",
};

/** Directory containing the packaged core binary (…/bin), resolved from this module. */
function packageRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
}

function bundledBinary(): string | undefined {
  const key = `${process.platform}-${process.arch}`;
  const name = BUNDLED_BINARIES[key];
  if (!name) return undefined;
  const candidate = path.join(packageRoot(), "bin", name);
  return fs.existsSync(candidate) ? candidate : undefined;
}

export function resolveCoreBinary(config: DocsAgentConfig): string {
  if (config.coreBinary) {
    const resolved = expandHome(config.coreBinary);
    if (!fs.existsSync(resolved)) {
      throw new DocsAgentError("core_unavailable", `coreBinary "${resolved}" (config) does not exist`);
    }
    return resolved;
  }
  const bundled = bundledBinary();
  if (bundled) return bundled;
  throw new DocsAgentError(
    "core_unavailable",
    `No DocsAgent Core binary found for ${process.platform}-${process.arch}. ` +
      "Supported platforms: macOS universal (Intel + Apple Silicon), Windows x64, " +
      "Linux x64 (x86_64 only — no Linux ARM). " +
      `Alternatively set "coreBinary" in ${configPath()} to the core binary path.`,
  );
}

/** Extra env for the bundled layout: the core's dylibs sit next to the binary. */
function spawnEnv(config: DocsAgentConfig): NodeJS.ProcessEnv {
  const env = { ...process.env };
  env.DOCSAGENT_HTTP_PORT = String(config.httpPort);
  env.DOCSAGENT_ROOT_DIR = path.dirname(configPath());
  if (!config.coreBinary) {
    const libDir = path.join(packageRoot(), "bin");
    if (process.platform === "darwin") {
      env.DYLD_LIBRARY_PATH = libDir;
      env.DYLD_FALLBACK_LIBRARY_PATH = libDir;
    } else if (process.platform === "linux") {
      env.LD_LIBRARY_PATH = libDir;
    }
  }
  return env;
}

function spawnCore(config: DocsAgentConfig): number {
  const binary = resolveCoreBinary(config);
  fs.mkdirSync(serviceDir(), { recursive: true });
  const out = fs.openSync(logFile(), "a");
  const isScript = /\.(m|c)?js$/i.test(binary);
  const child = isScript
    ? spawn(process.execPath, [binary], { detached: true, stdio: ["ignore", out, out], env: spawnEnv(config) })
    : spawn(binary, [], {
        detached: true,
        stdio: ["ignore", out, out],
        env: spawnEnv(config),
        cwd: path.dirname(binary),
      });
  if (child.pid === undefined) {
    throw new DocsAgentError("core_unavailable", `Failed to spawn core binary: ${binary}`);
  }
  fs.writeFileSync(pidFile(), String(child.pid));
  child.unref();
  return child.pid;
}

async function waitForHealth(config: DocsAgentConfig, waitMs: number): Promise<void> {
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    await sleep(POLL_INTERVAL_MS);
    if (await isCoreReachable(config)) return;
  }
  throw new DocsAgentError(
    "core_unavailable",
    `Core started but did not answer "health" within ${waitMs}ms — see ${logFile()}`,
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function startCore(config: DocsAgentConfig): Promise<CoreStartResult> {
  const client = new CoreClient(config);
  const existing = await isCoreReachable(config);
  if (existing) {
    return { started: false, pid: readPid(), endpoint: client.describeEndpoint() };
  }
  const pid = spawnCore(config);
  await waitForHealth(config, START_WAIT_MS);
  return { started: true, pid, endpoint: client.describeEndpoint() };
}

export async function stopCore(_config?: DocsAgentConfig): Promise<CoreStopResult> {
  const pid = readPid();
  if (pid === undefined) return { stopped: false };
  let killed = false;
  if (pidAlive(pid)) {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      /* already gone */
    }
    const deadline = Date.now() + STOP_GRACE_MS;
    while (Date.now() < deadline && pidAlive(pid)) {
      await sleep(POLL_INTERVAL_MS);
    }
    if (pidAlive(pid)) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        /* already gone */
      }
      await sleep(POLL_INTERVAL_MS);
    }
    killed = !pidAlive(pid);
  }
  fs.rmSync(pidFile(), { force: true });
  return { stopped: killed, pid };
}

export async function restartCore(config: DocsAgentConfig): Promise<CoreStartResult> {
  await stopCore(config);
  return await startCore(config);
}

export async function coreStatus(config: DocsAgentConfig): Promise<CoreStatus> {
  const client = new CoreClient(config);
  const pid = readPid();
  const health = await isCoreReachable(config);
  return {
    pid,
    running: (pid !== undefined && pidAlive(pid)) || health !== undefined,
    reachable: health !== undefined,
    version: health?.version,
    uptimeSec: health?.uptimeSec,
    endpoint: client.describeEndpoint(),
  };
}
