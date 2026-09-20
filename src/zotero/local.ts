import { DocsAgentError } from "../errors.js";

const TIMEOUT_MS = 15_000;

/**
 * Zotero local API client (http://localhost:23119/api, Web-API v3 shape) used for
 * write orchestration. DESIGN.md §5.1: the core never writes Zotero data; the shell
 * does, through this API.
 */
export class ZoteroLocalApi {
  constructor(private readonly baseUrl: string) {}

  private async req(method: string, apiPath: string, body?: unknown): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(`${this.baseUrl.replace(/\/$/, "")}${apiPath}`, {
        method,
        headers: body !== undefined ? { "Content-Type": "application/json" } : undefined,
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });
      if (res.status === 401 || res.status === 403) {
        throw new DocsAgentError("auth_failed", `zotero local api: HTTP ${res.status} for ${apiPath}`);
      }
      if (!res.ok) {
        const detail = await res.text().catch(() => "");
        throw new DocsAgentError(
          "web_api_error",
          `zotero local api: HTTP ${res.status} ${res.statusText} for ${apiPath}${detail ? ` — ${detail.slice(0, 300)}` : ""}`,
        );
      }
      const text = await res.text();
      return text ? JSON.parse(text) : {};
    } catch (err) {
      if (err instanceof DocsAgentError) throw err;
      if (err instanceof Error && err.name === "AbortError") {
        throw new DocsAgentError("web_api_error", `zotero local api: timeout for ${apiPath}`);
      }
      throw new DocsAgentError(
        "web_api_error",
        `zotero local api: request failed (${err instanceof Error ? err.message : String(err)}). Is Zotero running?`,
      );
    }
  }

  /** Cheap liveness probe: returns false when Zotero is not running. */
  async ping(): Promise<boolean> {
    try {
      await this.req("GET", "/users/0/items?limit=1&format=json");
      return true;
    } catch {
      return false;
    }
  }

  async getItem(key: string): Promise<Record<string, unknown> | null> {
    try {
      return (await this.req("GET", `/users/0/items/${key}?format=json`)) as Record<string, unknown>;
    } catch (err) {
      if (err instanceof DocsAgentError && err.message.includes("404")) return null;
      throw err;
    }
  }

  /**
   * POST /users/0/items with an array of item objects.
   * Returns { "0": "KEY", ... } per successful index (Web API write response shape).
   */
  async createItems(items: Record<string, unknown>[]): Promise<{ success: Record<string, string>; failed: unknown }> {
    const res = (await this.req("POST", "/users/0/items", items)) as {
      success?: Record<string, string>;
      failed?: unknown;
    };
    return { success: res.success ?? {}, failed: res.failed ?? {} };
  }

  /** POST /users/0/items with full item objects (incl. version) to update them. */
  async replaceItems(items: Record<string, unknown>[]): Promise<{ success: Record<string, string>; failed: unknown }> {
    return await this.createItems(items);
  }

  async deleteItem(key: string): Promise<void> {
    await this.req("DELETE", `/users/0/items/${key}`, undefined);
  }
}
