import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createToolServer } from "../server.js";
import type { ToolContext } from "../mcp/context.js";
import type { Logger } from "../logger.js";

/**
 * Local transport (DESIGN.md §3.3): MCP over stdin/stdout. All diagnostics go
 * to stderr; stdout carries only the protocol. Resolves when the client closes
 * the stream.
 */
export async function serveStdio(ctx: ToolContext, logger: Logger): Promise<void> {
  const server = createToolServer(ctx, {
    // Local mode is the machine owner: no RBAC role restriction.
    audit: (tool, ok) => logger.debug(`tool ${tool} ok=${ok}`),
  });
  const transport = new StdioServerTransport();
  await server.connect(transport);
  logger.info("stdio transport ready");

  await new Promise<void>((resolve) => {
    process.stdin.once("end", () => resolve());
    // Chain, don't overwrite: the SDK protocol layer installs its own onclose.
    const prior = transport.onclose;
    transport.onclose = () => {
      prior?.call(transport);
      resolve();
    };
  });
  logger.debug("stdio transport closed");
}
