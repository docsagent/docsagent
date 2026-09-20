import { suggestedCallFor, type SuggestedCall } from "./spec.js";

export interface JsonRpcErrorShape {
  code: number;
  message: string;
  data?: { code?: string; message?: string } | null;
}

export class DocsAgentError extends Error {
  readonly code: string;
  readonly suggestedCall?: SuggestedCall;

  constructor(code: string, message: string, suggestedCall?: SuggestedCall) {
    super(message);
    this.name = "DocsAgentError";
    this.code = code;
    if (suggestedCall) this.suggestedCall = suggestedCall;
  }
}

export const CORE_UNAVAILABLE_MESSAGE = [
  "DocsAgent Core is not running.",
  "",
  "Start it with:    docsagent start",
  "Check status:     docsagent status",
  "Core log:         see core.log next to the config file",
].join("\n");

const CORE_MAP: Record<string, string> = {
  source_unknown: "source_not_found",
  item_not_found: "no_content",
  no_attachment: "no_content",
  index_not_ready: "index_unavailable",
  index_building: "index_building",
  web_api_error: "web_api_error",
  auth_failed: "auth_failed",
  invalid_params: "invalid_params",
};

export function coreErrorToDocsAgent(err: JsonRpcErrorShape): DocsAgentError {
  const coreCode = err.data?.code;
  if (coreCode && CORE_MAP[coreCode]) {
    const mapped = CORE_MAP[coreCode];
    let message = err.message || coreCode;
    if (coreCode === "item_not_found") message = err.data?.message || `Item not found: ${extractId(message)}`;
    if (coreCode === "no_attachment") message = err.data?.message || "Item has no readable content";
    return new DocsAgentError(mapped, message, suggestedCallFor(mapped));
  }
  const code = coreCode ?? "core_error";
  return new DocsAgentError(code, `core error: ${err.message || "unknown core error"}`);
}

function extractId(message: string): string {
  const m = message.match(/[A-Z0-9]{8}/);
  return m ? m[0] : "unknown";
}

export function errorBody(err: unknown): Record<string, unknown> {
  if (err instanceof DocsAgentError) {
    const body: Record<string, unknown> = { code: err.code, message: err.message };
    if (err.suggestedCall) body.suggested_call = err.suggestedCall;
    return { error: body };
  }
  const message = err instanceof Error ? err.message : String(err);
  return { error: { code: "internal_error", message } };
}

export function isConnectFailure(err: unknown): boolean {
  const e = err as NodeJS.ErrnoException;
  if (err instanceof DocsAgentError) return false;
  // Node's fetch wraps connection failures in a TypeError with the errno on .cause.
  const causes = [e, e?.cause as NodeJS.ErrnoException | undefined];
  return causes.some((c) => ["ECONNREFUSED", "ENOENT", "EACCES", "EADDRNOTAVAIL"].includes(c?.code ?? ""));
}
