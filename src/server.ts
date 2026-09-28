import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolRequest,
  type ListToolsRequest,
  type ToolAnnotations,
} from "@modelcontextprotocol/sdk/types.js";
import { docsagentStateDir, loadConfig, type DocsAgentConfig, type ZoteroGroupConfig } from "./config.js";
import { DocsAgentError } from "./errors.js";
import { CoreClient } from "./core/client.js";
import { Logger } from "./logger.js";
import { RateLimiter } from "./ratelimit.js";
import { loadToolSpecs } from "./spec.js";
import { ZoteroLocalApi } from "./zotero/local.js";
import { ZoteroWebApi } from "./zotero/web.js";
import { GroupSyncer } from "./zotero/sync.js";
import { errorOutput, validateArgs, type ToolContext, type ToolHandler, type ToolOutput } from "./mcp/context.js";
import { searchTool } from "./mcp/tools/search.js";
import { getMetadataTool } from "./mcp/tools/getMetadata.js";
import { getContentTool } from "./mcp/tools/getContent.js";
import { listLibraryTool } from "./mcp/tools/listLibrary.js";
import { listSourcesTool } from "./mcp/tools/listSources.js";
import { importItemTool } from "./mcp/tools/importItem.js";
import { addNoteTool } from "./mcp/tools/addNote.js";
import { batchModifyTool } from "./mcp/tools/batchModify.js";
import { serveStdio } from "./transports/stdio.js";
import { serveHttp } from "./transports/http.js";

export const SERVER_NAME = "docsagent-mcp-zotero";
export const SERVER_VERSION = "5.0.0";

const HANDLERS: Record<string, ToolHandler> = {
  search: searchTool,
  get_metadata: getMetadataTool,
  get_content: getContentTool,
  list_library: listLibraryTool,
  list_sources: listSourcesTool,
  import_item: importItemTool,
  add_note: addNoteTool,
  batch_modify: batchModifyTool,
};

const WRITE_TOOLS = new Set(["import_item", "add_note", "batch_modify"]);

const ANNOTATIONS: Record<string, ToolAnnotations> = {
  search: { readOnlyHint: true },
  get_metadata: { readOnlyHint: true },
  get_content: { readOnlyHint: true },
  list_library: { readOnlyHint: true },
  list_sources: { readOnlyHint: true },
  import_item: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  add_note: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  batch_modify: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
};

export interface RunShellOptions {
  /** Overrides config.transport when provided. */
  transport?: "stdio" | "streamable-http";
}

/**
 * Tool names this session/identity may see: registered set (write tools removed
 * when enableWrites=false, DESIGN.md §9.4 layer 1) intersected with the RBAC
 * grant for the authenticated role, if any (DESIGN.md §3.5). A role with no
 * rbacRoles entry has full access.
 */
export function allowedToolNames(config: DocsAgentConfig, role?: string): Set<string> {
  const names = new Set(Object.keys(HANDLERS));
  if (!config.enableWrites) {
    for (const w of WRITE_TOOLS) names.delete(w);
  }
  const grants = role !== undefined ? config.rbacRoles[role] : undefined;
  if (grants) {
    const granted = new Set(grants);
    for (const n of names) {
      if (!granted.has(n)) names.delete(n);
    }
  }
  return names;
}

/**
 * Build the low-level MCP server. Tool definitions come verbatim from
 * spec/tools/*.json (spec/README.md consume rule 1) — no zod mirror.
 */
export function createToolServer(
  ctx: ToolContext,
  opts: { role?: string; audit?: (tool: string, ok: boolean) => void } = {},
): Server {
  const { config } = ctx;
  const server = new Server(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      capabilities: { tools: { listChanged: false } },
      instructions:
        "DocsAgent searches and reads a Zotero library through a resident search core. " +
        "Use list_sources to discover sources, search with target=annotations for highlights, " +
        "and get_content/get_metadata to drill into a result. Write tools require confirmed=true.",
    },
  );

  server.setRequestHandler(ListToolsRequestSchema, (_req: ListToolsRequest) => {
    const allowed = allowedToolNames(config, opts.role);
    const tools = loadToolSpecs()
      .filter((s) => allowed.has(s.name))
      .map((s) => ({
        name: s.name,
        title: s.title,
        description: s.description,
        inputSchema: s.inputSchema,
        annotations: ANNOTATIONS[s.name],
      }));
    return { tools };
  });

  server.setRequestHandler(CallToolRequestSchema, async (req: CallToolRequest): Promise<ToolOutput> => {
    const name = req.params.name;
    const args = (req.params.arguments ?? {}) as Record<string, unknown>;
    try {
      if (!HANDLERS[name]) {
        throw new DocsAgentError("invalid_params", `Unknown tool "${name}"`);
      }
      if (WRITE_TOOLS.has(name) && !config.enableWrites) {
        throw new DocsAgentError(
          "write_disabled",
          "Write operations are disabled (enableWrites=false); the write tools are not registered",
        );
      }
      if (!allowedToolNames(config, opts.role).has(name)) {
        throw new DocsAgentError("forbidden", `Tool "${name}" is not permitted for this session`);
      }
      const out = await HANDLERS[name](ctx, validateArgs(name, args));
      opts.audit?.(name, !out.isError);
      return out;
    } catch (err) {
      opts.audit?.(name, false);
      return errorOutput(err);
    }
  });

  return server;
}

interface GroupSyncEntry {
  group: ZoteroGroupConfig;
  syncer: GroupSyncer;
}

export interface BootstrapResult {
  ctx: ToolContext;
  groupSyncEntries: GroupSyncEntry[];
}

/**
 * Startup flow (DESIGN.md §3.4): connect core (health, never spawn) -> load
 * sources -> check index status. Connection failure propagates as
 * core_unavailable with startup instructions.
 */
export async function bootstrapServices(config: DocsAgentConfig, logger: Logger): Promise<BootstrapResult> {
  const core = new CoreClient(config);
  const health = await core.health();
  logger.info(`core ${health.version} reachable via ${core.describeEndpoint()}`);

  const { sources } = await core.listSources();
  logger.debug(`sources: ${sources.map((s) => s.name).join(", ") || "(none)"}`);

  try {
    const st = await core.indexStatus(config.defaultSource);
    if (st.status === "missing") {
      logger.warn(`index for "${st.source}" is not built yet — run: docsagent-core rebuild-index`);
    } else if (st.status === "building") {
      logger.info(`index for "${st.source}" is building; search results may be partial`);
    }
  } catch (err) {
    logger.warn(`indexStatus failed (continuing): ${err instanceof Error ? err.message : String(err)}`);
  }

  const groupSyncEntries = buildGroupSyncers(config, core, logger);

  return {
    ctx: {
      config,
      core,
      zotero: new ZoteroLocalApi(config.zoteroApiUrl),
      rateLimiter: new RateLimiter(config.writeRateLimitPerHour),
      groupSyncer: groupSyncEntries[0]?.syncer,
      logger,
      sources,
    },
    groupSyncEntries,
  };
}

function buildGroupSyncers(config: DocsAgentConfig, core: CoreClient, logger: Logger): GroupSyncEntry[] {
  const stateDir = docsagentStateDir();
  return config.zoteroGroups.map((group) => ({
    group,
    syncer: new GroupSyncer(
      core,
      new ZoteroWebApi(group.apiKey),
      config.zoteroDataDir,
      `${stateDir}/cache`,
      `${stateDir}/sync-state.json`,
      logger,
    ),
  }));
}

/**
 * Initial group sync + periodic re-sync. DESIGN.md §3.6 has the core schedule
 * syncs and notify the shell; that notification channel is not part of the core
 * API yet, so the shell self-schedules at the same configured interval.
 */
export function scheduleGroupSync(
  entries: GroupSyncEntry[],
  config: DocsAgentConfig,
  logger: Logger,
): NodeJS.Timeout | undefined {
  const syncAll = async (trigger: string) => {
    for (const { group, syncer } of entries) {
      try {
        const result = await syncer.syncGroup(group);
        if (result.mode !== "skipped") {
          logger.info(`group sync ${group.groupId} (${trigger}, ${result.mode}): ${result.indexed ?? 0} items`);
        }
      } catch (err) {
        logger.warn(`group sync ${group.groupId} failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  };
  if (entries.length === 0) return undefined;
  void syncAll("startup");
  const timer = setInterval(() => void syncAll("scheduled"), config.groupSyncInterval * 1000);
  timer.unref();
  return timer;
}

/** Load config, bootstrap services, start the configured transport. */
export async function runShell(opts: RunShellOptions = {}): Promise<void> {
  const config = loadConfig();
  const logger = new Logger(config.logLevel);
  const transport = opts.transport ?? config.transport;
  logger.debug(`starting ${SERVER_NAME} v${SERVER_VERSION} (${transport})`);

  const { ctx, groupSyncEntries } = await bootstrapServices(config, logger);
  scheduleGroupSync(groupSyncEntries, config, logger);

  if (transport === "streamable-http") {
    await serveHttp(ctx, logger);
  } else {
    await serveStdio(ctx, logger);
  }
}
