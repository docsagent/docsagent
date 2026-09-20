import { DocsAgentError } from "../errors.js";
import { mkdir, writeFile } from "fs/promises";
import path from "path";

const API_VERSION = "3";
const PAGE_SIZE = 100;
const TIMEOUT_MS = 60_000;

/**
 * Zotero Web API v3 client used for group library sync (DESIGN.md §3.6).
 * The core never talks to the web; the shell fetches and hands data over.
 */
export class ZoteroWebApi {
  constructor(private readonly apiKey: string) {}

  private async req(
    method: string,
    apiPath: string,
    raw = false,
  ): Promise<{ data: unknown; headers: Record<string, string> }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(`https://api.zotero.org${apiPath}`, {
        method,
        headers: {
          "Zotero-API-Version": API_VERSION,
          Authorization: `Bearer ${this.apiKey}`,
        },
        signal: controller.signal,
      });
      if (res.status === 401 || res.status === 403) {
        throw new DocsAgentError("auth_failed", `zotero web api: HTTP ${res.status} for ${apiPath}`);
      }
      if (!res.ok) {
        throw new DocsAgentError(
          "web_api_error",
          `zotero web api: HTTP ${res.status} ${res.statusText} for ${apiPath}`,
        );
      }
      const headers: Record<string, string> = {};
      const lm = res.headers.get("last-modified-version");
      if (lm) headers["last-modified-version"] = lm;
      if (raw) {
        headers["body"] = Buffer.from(await res.arrayBuffer()).toString("base64");
        return { data: null, headers };
      }
      const data = await res.json();
      return { data, headers };
    } catch (err) {
      if (err instanceof DocsAgentError) throw err;
      if (err instanceof Error && err.name === "AbortError") {
        throw new DocsAgentError("web_api_error", `zotero web api: timeout for ${apiPath}`);
      }
      throw new DocsAgentError(
        "web_api_error",
        `zotero web api: request failed (${err instanceof Error ? err.message : String(err)})`,
      );
    }
  }

  async getLibraryVersion(groupId: number): Promise<number> {
    const { headers } = await this.req("GET", `/groups/${groupId}/items?limit=1&format=json`);
    const v = Number(headers["last-modified-version"]);
    if (!Number.isFinite(v)) {
      throw new DocsAgentError("web_api_error", `zotero web api: missing Last-Modified-Version for group ${groupId}`);
    }
    return v;
  }

  async fetchCollections(groupId: number): Promise<Array<Record<string, unknown>>> {
    const out: Array<Record<string, unknown>> = [];
    let start = 0;
    for (;;) {
      const { data } = await this.req(
        "GET",
        `/groups/${groupId}/collections?limit=${PAGE_SIZE}&start=${start}&format=json`,
      );
      const page = data as Array<Record<string, unknown>>;
      out.push(...page);
      if (page.length < PAGE_SIZE) return out;
      start += PAGE_SIZE;
    }
  }

  /** All items (top level + children) — optionally only those changed since `since`. */
  async fetchItems(
    groupId: number,
    since?: number,
  ): Promise<{ items: Array<Record<string, unknown>>; libraryVersion: number | null }> {
    const out: Array<Record<string, unknown>> = [];
    let libraryVersion: number | null = null;
    let start = 0;
    for (;;) {
      const suffix = since !== undefined ? `&since=${since}` : "";
      const { data, headers } = await this.req(
        "GET",
        `/groups/${groupId}/items?limit=${PAGE_SIZE}&start=${start}${suffix}&format=json`,
      );
      const page = data as Array<Record<string, unknown>>;
      out.push(...page);
      if (!libraryVersion && headers["last-modified-version"]) {
        libraryVersion = Number(headers["last-modified-version"]);
      }
      if (page.length < PAGE_SIZE) return { items: out, libraryVersion };
      start += PAGE_SIZE;
    }
  }

  /** Download an attachment file (PDF etc.) to destPath. */
  async downloadFile(groupId: number, attachmentKey: string, destPath: string): Promise<void> {
    const { headers } = await this.req(
      "GET",
      `/groups/${groupId}/items/${attachmentKey}/file`,
      true,
    );
    const b64 = headers["body"];
    if (!b64) throw new DocsAgentError("web_api_error", "zotero web api: empty file response");
    await mkdir(path.dirname(destPath), { recursive: true });
    await writeFile(destPath, new Uint8Array(Buffer.from(b64, "base64")));
  }
}
