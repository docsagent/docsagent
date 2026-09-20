import http from "http";
import { randomUUID } from "crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createToolServer, SERVER_VERSION } from "../server.js";
import { DocsAgentError } from "../errors.js";
import type { ToolContext } from "../mcp/context.js";
import type { Logger } from "../logger.js";
import type { DocsAgentConfig } from "../config.js";

const MAX_BODY_BYTES = 8 * 1024 * 1024;
const INTROSPECTION_CACHE_TTL_MS = 60_000;

interface HttpSession {
  transport: StreamableHTTPServerTransport;
}

interface Authenticator {
  /** Resolves the RBAC role for a request; throws unauthorized/forbidden. */
  authenticate(req: http.IncomingMessage): Promise<string | undefined>;
}

/**
 * Remote transport (DESIGN.md §3.3, §6.2): MCP over Streamable HTTP on a single
 * endpoint (/mcp), plus GET /health for liveness/readiness probes (§6.6).
 * Per-session tool servers enforce RBAC (§3.5); sessions live in memory and die
 * with the process, matching the MCP stateful pattern.
 */
export async function serveHttp(ctx: ToolContext, logger: Logger): Promise<void> {
  const { config } = ctx;
  const sessions = new Map<string, HttpSession>();
  const auth = createAuthenticator(config, logger);

  async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://localhost");

    if (req.method === "GET" && url.pathname === "/health") {
      return await handleHealth(ctx, res);
    }
    if (url.pathname !== "/mcp") {
      return json(res, 404, { error: { code: "invalid_params", message: `Unknown endpoint ${url.pathname}` } });
    }

    // Origin validation (DESIGN.md §3.5) — DNS rebinding protection.
    const originError = checkOrigin(config, req);
    if (originError) return json(res, 403, { error: { code: "forbidden", message: originError } });

    let role: string | undefined;
    try {
      role = await auth.authenticate(req);
    } catch (err) {
      const code = err instanceof DocsAgentError ? err.code : "unauthorized";
      const status = code === "forbidden" ? 403 : 401;
      const message = err instanceof Error ? err.message : "authentication failed";
      return json(res, status, { error: { code, message } });
    }

    let body: unknown;
    if (req.method === "POST") {
      try {
        body = await readJsonBody(req);
      } catch (err) {
        return json(res, 400, {
          error: { code: "invalid_params", message: err instanceof Error ? err.message : "invalid body" },
        });
      }
    }

    const sessionId = header(req, "mcp-session-id");
    if (sessionId) {
      const session = sessions.get(sessionId);
      if (!session) {
        return json(res, 404, {
          error: { code: "session_expired", message: "Unknown or expired session; re-initialize" },
        });
      }
      await session.transport.handleRequest(req, res, body);
      return;
    }

    if (req.method !== "POST" || !isInitialize(body)) {
      return json(res, 400, {
        error: { code: "invalid_params", message: "Missing Mcp-Session-Id header; send initialize first" },
      });
    }

    const audit = (tool: string, ok: boolean) => {
      logger.info(`[audit] role=${role ?? "unrestricted"} tool=${tool} ok=${ok}`);
    };
    const server = createToolServer(ctx, { role, audit });
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      enableJsonResponse: true,
      onsessioninitialized: (id) => {
        sessions.set(id, { transport });
        logger.debug(`session ${id} initialized (role=${role ?? "unrestricted"})`);
      },
    });
    server.onclose = () => {
      const id = transport.sessionId;
      if (id) sessions.delete(id);
    };
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
  }

  const httpServer = http.createServer((req, res) => {
    void handle(req, res).catch((err) => {
      logger.error(`http error: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
      if (!res.headersSent) {
        json(res, 500, { error: { code: "internal_error", message: "internal server error" } });
      } else {
        res.end();
      }
    });
  });

  const listenAddr = parseListenAddr(config.httpListenAddr);
  await new Promise<void>((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(listenAddr.port, listenAddr.host, () => resolve());
  });
  logger.info(
    `streamable-http listening on http://${listenAddr.host}:${listenAddr.port}/mcp (authMode=${config.authMode})`,
  );

  await new Promise<void>((resolve) => {
    httpServer.on("close", () => resolve());
  });
  logger.debug("http transport closed");
}

function isInitialize(body: unknown): boolean {
  return (
    typeof body === "object" &&
    body !== null &&
    (body as { method?: unknown }).method === "initialize"
  );
}

function header(req: http.IncomingMessage, name: string): string | undefined {
  const v = req.headers[name];
  if (Array.isArray(v)) return v[0];
  return v;
}

async function handleHealth(ctx: ToolContext, res: http.ServerResponse): Promise<void> {
  try {
    await ctx.core.call("health", undefined, { timeoutMs: 1500 });
    json(res, 200, { status: "ok", core: "ok", version: SERVER_VERSION });
  } catch {
    json(res, 503, { status: "degraded", core: "unavailable" });
  }
}

function json(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

function readJsonBody(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Uint8Array[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error(`request body exceeds ${MAX_BODY_BYTES} bytes`));
        req.destroy();
        return;
      }
      chunks.push(new Uint8Array(chunk));
    });
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (raw.length === 0) {
        resolve(undefined);
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error("request body is not valid JSON"));
      }
    });
    req.on("error", reject);
  });
}

/**
 * Origin validation (DESIGN.md §3.5): non-browser clients send no Origin; same-host
 * and localhost origins are always accepted; others must be listed in
 * authConfig.allowedOrigins.
 */
function checkOrigin(config: DocsAgentConfig, req: http.IncomingMessage): string | null {
  const origin = header(req, "origin");
  if (!origin) return null;
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    return `Invalid Origin header: ${origin}`;
  }
  const host = header(req, "host");
  if (host && parsed.host === host) return null;
  const allowed = (config.authConfig.allowedOrigins as string[] | undefined) ?? [];
  if (allowed.includes(origin)) return null;
  if (
    parsed.hostname === "localhost" ||
    parsed.hostname === "127.0.0.1" ||
    parsed.hostname === "0.0.0.0" ||
    parsed.hostname === "[::1]"
  ) {
    return null;
  }
  return `Origin "${origin}" is not allowed`;
}

function createAuthenticator(config: DocsAgentConfig, logger: Logger): Authenticator {
  if (config.authMode === "none") {
    // Local/trusted deployments: requests are unrestricted.
    return { authenticate: async () => undefined };
  }

  if (config.authMode === "api-key") {
    const keys = (config.authConfig.apiKeys ?? {}) as Record<string, string | undefined>;
    if (typeof keys !== "object" || Object.keys(keys).length === 0) {
      logger.warn("authMode=api-key but authConfig.apiKeys is empty — every request will be rejected");
    }
    return {
      authenticate: async (req) => {
        const authorization = header(req, "authorization") ?? "";
        const match = authorization.match(/^Bearer\s+(\S+)$/i);
        if (!match) {
          throw new DocsAgentError("unauthorized", "Missing Authorization: Bearer <api-key> header");
        }
        if (!(match[1] in keys)) {
          throw new DocsAgentError("unauthorized", "Invalid API key");
        }
        return keys[match[1]];
      },
    };
  }

  // authMode === "oauth2": RFC 7662 token introspection against the IdP.
  const introspectionUrl = String(config.authConfig.introspectionUrl ?? "");
  const roleClaim = String(config.authConfig.roleClaim ?? "role");
  const defaultRole = typeof config.authConfig.defaultRole === "string" ? config.authConfig.defaultRole : undefined;
  const cache = new Map<string, { role: string | undefined; expires: number }>();

  return {
    authenticate: async (req) => {
      if (!introspectionUrl) {
        throw new DocsAgentError(
          "unauthorized",
          "authMode=oauth2 requires authConfig.introspectionUrl (RFC 7662 token introspection)",
        );
      }
      const authorization = header(req, "authorization") ?? "";
      const match = authorization.match(/^Bearer\s+(\S+)$/i);
      if (!match) {
        throw new DocsAgentError("unauthorized", "Missing Authorization: Bearer <access-token> header");
      }
      const token = match[1];
      const cached = cache.get(token);
      if (cached && cached.expires > Date.now()) return cached.role;
      const body = new URLSearchParams({ token });
      const clientId = config.authConfig.clientId;
      const clientSecret = config.authConfig.clientSecret;
      const headers: Record<string, string> = { "Content-Type": "application/x-www-form-urlencoded" };
      if (typeof clientId === "string" && typeof clientSecret === "string") {
        headers.Authorization = `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`;
      }
      let data: { active?: boolean } & Record<string, unknown>;
      try {
        const res = await fetch(introspectionUrl, { method: "POST", headers, body: body.toString() });
        if (!res.ok) {
          throw new DocsAgentError("unauthorized", `token introspection failed (HTTP ${res.status})`);
        }
        data = (await res.json()) as typeof data;
      } catch (err) {
        if (err instanceof DocsAgentError) throw err;
        throw new DocsAgentError(
          "unauthorized",
          `token introspection failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      if (!data.active) {
        throw new DocsAgentError("unauthorized", "Token is not active");
      }
      const role = typeof data[roleClaim] === "string" ? (data[roleClaim] as string) : defaultRole;
      cache.set(token, { role, expires: Date.now() + INTROSPECTION_CACHE_TTL_MS });
      return role;
    },
  };
}

function parseListenAddr(addr: string): { host: string; port: number } {
  const idx = addr.lastIndexOf(":");
  if (idx <= 0 || idx === addr.length - 1) {
    throw new DocsAgentError("invalid_params", `Invalid httpListenAddr "${addr}"; expected "host:port"`);
  }
  const host = addr.slice(0, idx);
  const port = Number(addr.slice(idx + 1));
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new DocsAgentError("invalid_params", `Invalid port in httpListenAddr "${addr}"`);
  }
  return { host, port };
}
