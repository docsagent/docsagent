import { Ajv, type ValidateFunction } from "ajv";
import { DocsAgentError, errorBody } from "../errors.js";
import type { CoreClient, SourceInfo } from "../core/client.js";
import type { DocsAgentConfig } from "../config.js";
import type { Logger } from "../logger.js";
import type { RateLimiter } from "../ratelimit.js";
import type { ZoteroLocalApi } from "../zotero/local.js";
import { loadToolSpec, type ToolSpec } from "../spec.js";
import { parseGlobalId } from "../ids.js";
import type { GroupSyncer } from "../zotero/sync.js";

export interface ToolContext {
  config: DocsAgentConfig;
  core: CoreClient;
  zotero: ZoteroLocalApi;
  rateLimiter: RateLimiter;
  groupSyncer?: GroupSyncer;
  logger: Logger;
  /** Cached listSources result, refreshed at startup and by list_sources. */
  sources: SourceInfo[];
}

export type ToolHandler = (ctx: ToolContext, args: Record<string, unknown>) => Promise<ToolOutput>;

export interface ToolOutput {
  content: [{ type: "text"; text: string }];
  isError?: boolean;
  [key: string]: unknown;
}

export function textOutput(result: unknown): ToolOutput {
  return { content: [{ type: "text", text: JSON.stringify(result) }] };
}

export function errorOutput(err: unknown): ToolOutput {
  return { content: [{ type: "text", text: JSON.stringify(errorBody(err)) }], isError: true };
}

const ajv = new Ajv({ allErrors: true, useDefaults: true, strict: false });
const validators = new Map<string, ValidateFunction>();

export function validateArgs(toolName: string, args: unknown): Record<string, unknown> {
  let validate = validators.get(toolName);
  if (!validate) {
    const spec: ToolSpec | undefined = loadToolSpec(toolName);
    if (!spec) {
      throw new DocsAgentError("invalid_params", `Unknown tool "${toolName}"`);
    }
    validate = ajv.compile(spec.inputSchema);
    validators.set(toolName, validate);
  }
  const data = (args ?? {}) as Record<string, unknown>;
  const ok = validate(data);
  if (!ok) {
    const msg = (validate.errors ?? [])
      .map((e) => `${e.instancePath || "(root)"}: ${e.message}`)
      .join("; ");
    if (toolName === "import_item") {
      throw new DocsAgentError("missing_input", "import_item requires exactly one of paths or identifiers");
    }
    throw new DocsAgentError("invalid_params", `Invalid arguments for ${toolName} — ${msg}`);
  }
  return data;
}

export function getSourceInfo(ctx: ToolContext, source: string): SourceInfo {
  const info = ctx.sources.find((s) => s.name === source);
  if (!info) {
    throw new DocsAgentError("source_not_found", `Unknown source "${source}"`, {
      tool: "list_sources",
      args: {},
    });
  }
  return info;
}

/** Resolve + validate a global id against known sources. */
export function resolveId(ctx: ToolContext, rawId: unknown, param = "id"): { source: string; localId: string } {
  if (typeof rawId !== "string") {
    throw new DocsAgentError("invalid_params", `Parameter "${param}" must be a string`);
  }
  const gid = parseGlobalId(rawId, ctx.config.defaultSource);
  getSourceInfo(ctx, gid.source);
  return gid;
}

export function requireTarget(source: SourceInfo, target: string): void {
  if (!source.targets.includes(target)) {
    throw new DocsAgentError(
      "target_not_supported",
      `Source "${source.name}" does not support target "${target}" (supported: ${source.targets.join(", ")})`,
      { note: `Retry with one of: ${source.targets.join(", ")}` },
    );
  }
}

export function requireCapability(source: SourceInfo, capability: string): void {
  const caps = source.capabilities ?? [];
  if (!caps.includes(capability)) {
    throw new DocsAgentError(
      "capability_not_supported",
      `Source "${source.name}" does not declare the "${capability}" capability (declares: ${caps.length ? caps.join(", ") : "none"})`,
    );
  }
}

export function requireInclude(source: SourceInfo, include: string): void {
  const includes = source.includes ?? [];
  if (includes.length > 0 && !includes.includes(include)) {
    throw new DocsAgentError(
      "include_not_supported",
      `Source "${source.name}" does not support include "${include}" (supported: ${includes.join(", ")})`,
      { note: `Supported includes: ${includes.join(", ")}` },
    );
  }
}

/**
 * Shared write gate (spec/algorithms/write-gate.md). Registration gate happens at
 * tool registration; here: enableWrites defense -> rate limit (confirmed writes
 * only; previews consume no quota) -> confirm gate.
 */
export function writeGate(ctx: ToolContext, confirmed: unknown): boolean {
  if (!ctx.config.enableWrites) {
    throw new DocsAgentError("write_disabled", "Write operations are disabled (enableWrites=false)");
  }
  const isConfirmed = confirmed === true;
  if (isConfirmed) {
    const waitMs = ctx.rateLimiter.tryConsume();
    if (waitMs !== null) {
      const resetMin = Math.max(1, Math.ceil(waitMs / 60_000));
      throw new DocsAgentError(
        "rate_limited",
        `Write rate limit exceeded (${ctx.config.writeRateLimitPerHour}/h). Resets in ~${resetMin} min`,
      );
    }
  }
  return isConfirmed;
}
