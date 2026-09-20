#!/usr/bin/env node
import { DocsAgentError } from "./errors.js";
import { runShell } from "./server.js";
import {
  coreStatus,
  logFile,
  restartCore,
  startCore,
  stopCore,
  type ServiceCommand,
} from "./core-service.js";
import { loadConfig } from "./config.js";

const USAGE = `DocsAgent MCP shell for Zotero (@docsagent/mcp-zotero)

Usage:
  docsagent                          Start the MCP server (stdio, default)
  docsagent --transport streamable-http
                                     Serve MCP over Streamable HTTP
                                     (listen address from config: httpListenAddr)

Core service management (background C++ core):
  docsagent start                    Start the core in the background
  docsagent stop                     Stop the running core
  docsagent restart                  Restart the core
  docsagent status                   Show whether the core is running/reachable

Options:
  --transport <stdio|streamable-http>  Override the transport from config
  -h, --help                           Show this help

Configuration: ~/.docsagent/config.json (override path with DOCSAGENT_CONFIG)

The MCP server connects to the resident DocsAgent Core and never spawns it from
a session; use "docsagent start" to launch it. Core log: ${logFile()}
`;

const SERVICE_COMMANDS: readonly string[] = ["start", "stop", "restart", "status"];

function parseTransport(v: string | undefined): "stdio" | "streamable-http" {
  if (v === "stdio" || v === "streamable-http") return v;
  throw new DocsAgentError("invalid_params", `Invalid transport "${v ?? ""}"; expected "stdio" or "streamable-http"`);
}

function parseArgs(argv: string[]): {
  help: boolean;
  transport?: "stdio" | "streamable-http";
  command?: ServiceCommand;
} {
  const out = { help: false, transport: undefined as "stdio" | "streamable-http" | undefined, command: undefined as ServiceCommand | undefined };
  if (argv.length > 0 && SERVICE_COMMANDS.includes(argv[0])) {
    return { help: false, transport: undefined, command: argv[0] as ServiceCommand };
  }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "-h" || arg === "--help") {
      out.help = true;
    } else if (arg === "--transport") {
      out.transport = parseTransport(argv[++i]);
    } else if (arg.startsWith("--transport=")) {
      out.transport = parseTransport(arg.slice("--transport=".length));
    } else {
      throw new DocsAgentError("invalid_params", `Unknown argument "${arg}"\n\n${USAGE}`);
    }
  }
  return out;
}

async function runServiceCommand(command: ServiceCommand): Promise<void> {
  const config = loadConfig();
  if (command === "start") {
    const result = await startCore(config);
    if (result.started) {
      process.stdout.write(`DocsAgent Core started (pid ${result.pid}, endpoint ${result.endpoint}).\n`);
    } else {
      process.stdout.write(`DocsAgent Core already running (pid ${result.pid ?? "unknown"}, endpoint ${result.endpoint}).\n`);
    }
    return;
  }
  if (command === "stop") {
    const result = await stopCore(config);
    if (result.stopped) {
      process.stdout.write(`DocsAgent Core stopped (pid ${result.pid}).\n`);
    } else {
      process.stdout.write("DocsAgent Core is not running.\n");
    }
    return;
  }
  if (command === "restart") {
    const result = await restartCore(config);
    process.stdout.write(`DocsAgent Core ${result.started ? "restarted" : "already running"} (pid ${result.pid ?? "unknown"}, endpoint ${result.endpoint}).\n`);
    return;
  }
  const status = await coreStatus(config);
  if (!status.running) {
    process.stdout.write(`DocsAgent Core is not running (pid file: ${status.pid ?? "none"}).\nStart it with: docsagent start\n`);
    return;
  }
  const details = [
    status.pid !== undefined ? `pid ${status.pid}` : undefined,
    status.reachable ? `reachable at ${status.endpoint}` : `NOT reachable at ${status.endpoint}`,
    status.version ? `version ${status.version}` : undefined,
  ]
    .filter(Boolean)
    .join(", ");
  process.stdout.write(`DocsAgent Core running (${details}).\n`);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(USAGE);
    return;
  }
  if (args.command) {
    await runServiceCommand(args.command);
    return;
  }
  await runShell({ transport: args.transport });
}

main().catch((err) => {
  process.stderr.write(
    `[docsagent] ${err instanceof DocsAgentError ? err.message : err instanceof Error ? err.stack ?? err.message : String(err)}\n`,
  );
  process.exit(1);
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => process.exit(0));
}
