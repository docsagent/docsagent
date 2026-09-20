import { randomUUID } from "crypto";
import {
  CORE_UNAVAILABLE_MESSAGE,
  DocsAgentError,
  coreErrorToDocsAgent,
  isConnectFailure,
  type JsonRpcErrorShape,
} from "../errors.js";
import type { DocsAgentConfig } from "../config.js";

const DEFAULT_TIMEOUT_MS = 30_000;
const GROUP_SYNC_TIMEOUT_MS = 300_000;

export interface CoreRequestOptions {
  timeoutMs?: number;
}

export interface SourceInfo {
  name: string;
  displayName?: string;
  type: string;
  status: "ready" | "building" | "unavailable";
  writable: boolean;
  targets: string[];
  includes?: string[];
  browseModes?: string[];
  filters?: string[];
  capabilities?: string[];
}

export interface IndexStatusInfo {
  source: string;
  status: "ready" | "building" | "missing" | "error";
  docs?: number | null;
  message?: string | null;
}

/**
 * JSON-RPC 2.0 client for the resident C++ core (spec/api/README.md).
 * Transport: HTTP, `POST http://{coreHost}:{httpPort}/rpc` (`coreHost` defaults to 0.0.0.0).
 * The shell never spawns the core — an unreachable core surfaces as
 * `core_unavailable` with startup instructions.
 */
export class CoreClient {
  private readonly coreHost: string;
  private readonly httpPort: number;
  private readonly defaultTimeoutMs: number;

  constructor(config: DocsAgentConfig, defaultTimeoutMs: number = DEFAULT_TIMEOUT_MS) {
    this.coreHost = config.coreHost;
    this.httpPort = config.httpPort;
    this.defaultTimeoutMs = defaultTimeoutMs;
  }

  async call<T = unknown>(method: string, params?: unknown, opts?: CoreRequestOptions): Promise<T> {
    const timeoutMs =
      opts?.timeoutMs ??
      (method === "indexGroupData" || method === "syncGroupIndex" ? GROUP_SYNC_TIMEOUT_MS : this.defaultTimeoutMs);
    return await this.httpCall<T>(method, params, timeoutMs);
  }

  private async httpCall<T>(method: string, params: unknown, timeoutMs: number): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(`http://${this.coreHost}:${this.httpPort}/rpc`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: randomUUID(), method, params }),
        signal: controller.signal,
      });
      const body = (await res.json().catch(() => null)) as { result?: T; error?: JsonRpcErrorShape } | null;
      if (!body) {
        throw new DocsAgentError(
          "core_unavailable",
          `DocsAgent Core returned a non-JSON response (HTTP ${res.status}).\n\n${CORE_UNAVAILABLE_MESSAGE}`,
        );
      }
      if (body.error) throw coreErrorToDocsAgent(body.error);
      return body.result as T;
    } catch (err) {
      if (err instanceof DocsAgentError) throw err;
      if (isAbort(err)) {
        throw new DocsAgentError("core_timeout", `DocsAgent Core did not answer "${method}" within ${timeoutMs}ms`);
      }
      if (isConnectFailure(err)) {
        throw new DocsAgentError("core_unavailable", CORE_UNAVAILABLE_MESSAGE);
      }
      throw new DocsAgentError(
        "core_unavailable",
        `DocsAgent Core request failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      clearTimeout(timer);
    }
  }

  async health(): Promise<{ status: string; version: string; uptimeSec?: number }> {
    return await this.call<{ status: string; version: string; uptimeSec?: number }>("health");
  }

  /** Human-readable endpoint used for startup logs. */
  describeEndpoint(): string {
    return `http://${this.coreHost}:${this.httpPort}/rpc`;
  }

  async listSources(): Promise<{ sources: SourceInfo[] }> {
    return await this.call<{ sources: SourceInfo[] }>("listSources");
  }

  async indexStatus(source: string): Promise<IndexStatusInfo> {
    return await this.call<IndexStatusInfo>("indexStatus", { source });
  }
}

function isAbort(err: unknown): boolean {
  return err instanceof Error && err.name === "AbortError";
}
