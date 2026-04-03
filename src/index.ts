import { ChildProcess, spawn } from "child_process";
import { getBinaryPath } from "./utils.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const DEFAULT_PORT = 18688;

/**
 * Structured search result record
 */
export interface SearchResult {
  path?: string;
  score: number;
  context: string;
  page?: number;
  metadata?: Record<string, any>;
}

export class DocsAgent {
  private process: ChildProcess | null = null;
  private binaryPath: string;
  private port: number;
  private baseUrl: string;
  private initialPath: string | string[] | undefined;
  private readyPromise: Promise<void>;

  /**
   * Initialize DocsAgent and start the C++ engine immediately.
   * @param path Local folder directory or an array of file paths. Optional.
   * @param port The port for the local service. Defaults to 18688.
   */
  constructor(path?: string | string[], port: number = DEFAULT_PORT) {
    this.binaryPath = getBinaryPath();
    this.initialPath = path;
    this.port = port;
    this.baseUrl = `http://localhost:${this.port}`;

    // Start the C++ engine immediately upon construction
    this.readyPromise = this.startEngine();
  }

  /**
   * Starts the C++ background process and waits for the HTTP interface to be ready.
   * If a service is already running on the target port, it will skip spawning.
   */
  private async startEngine(): Promise<void> {
    // Check if a service is already running on this port
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 200);
      const res = await fetch(`${this.baseUrl}/status`, { signal: controller.signal });
      clearTimeout(timeoutId);
      if (res.ok) {
        // Service already alive, no need to spawn a new one
        return;
      }
    } catch {
      // Not running, proceed to spawn
    }

    const args = ["--port", this.port.toString()];
    if (this.initialPath) {
      const dirArg = Array.isArray(this.initialPath) 
        ? this.initialPath.join(" ") 
        : this.initialPath;
      args.push("--source", dirArg);
    }

    return new Promise((resolve, reject) => {
      this.process = spawn(this.binaryPath, args, {
        stdio: "ignore",
        detached: true,
      });

      // Allow the process to stay alive after the parent exits
      this.process.unref();

      this.process.on("error", (err) => {
        this.process = null;
        reject(err);
      });

      this.process.on("exit", (code) => {
        if (code !== 0 && this.process) {
          console.error(`DocsAgent engine exited with code ${code}`);
        }
        this.process = null;
      });

      // Poll the health check endpoint until the HTTP server is responsive
      let attempts = 0;
      const checkReady = async () => {
        try {
          const controller = new AbortController();
          const timeoutId = setTimeout(() => controller.abort(), 100);
          
          const res = await fetch(`${this.baseUrl}/status`, { signal: controller.signal });
          clearTimeout(timeoutId);
          
          if (res.ok) resolve();
          else throw new Error();
        } catch {
          attempts++;
          if (attempts > 50) {
            reject(new Error(`Timeout waiting for DocsAgent service to start on port ${this.port}`));
          } else {
            setTimeout(checkReady, 100);
          }
        }
      };
      
      setTimeout(checkReady, 50);
    });
  }

  private async request(path: string, method: "GET" | "POST", body?: any): Promise<any> {
    await this.readyPromise;
    
    const url = `${this.baseUrl}${path}`;
    try {
      const response = await fetch(url, {
        method,
        headers: body ? { "Content-Type": "application/json" } : undefined,
        body: body ? JSON.stringify(body) : undefined,
      });

      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      return await response.json();
    } catch (error: any) {
      throw new Error(`Failed to communicate with DocsAgent service: ${error.message}`);
    }
  }

  /**
   * Real-time document addition interface.
   * @param path The newly added folder directory or an array of file paths.
   */
  public async add(path: string | string[]): Promise<void> {
    const sources = Array.isArray(path) ? path : [path];
    await this.request("/add", "POST", { source: sources });
  }

  /**
   * Query interface: Returns relevant records based on the user's query.
   */
  public async search(query: string): Promise<SearchResult[]> {
    const response = await this.request("/search", "POST", { query: query });
    if (response && response.code === 200 && Array.isArray(response.result_items)) {
      return response.result_items;
    }
    return [];
  }

  /**
   * Status interface: Returns current engine and indexing state.
   */
  public async status(): Promise<any> {
    return await this.request("/status", "GET");
  }

  /**
   * List interface: Returns all indexed files/directories.
   */
  public async list(): Promise<string[]> {
    const res = await this.request("/list", "GET");
    return Array.isArray(res) ? res : [];
  }

  /**
   * Remove interface: Removes a path from the index.
   */
  public async remove(path: string): Promise<void> {
    await this.request("/remove", "POST", { path });
  }

  /**
   * Closing interface: Closes the DocsAgent engine via HTTP request.
   */
  public async close(): Promise<void> {
    try {
      await this.request("/close", "POST");
    } catch {
      // If request fails (e.g. already closed), fallback to local kill if we started it
      if (this.process) {
        this.process.kill();
        this.process = null;
      }
    }
  }

  /**
   * Starts an MCP server instance using this DocsAgent engine.
   */
  public async startMcpServer() {
    await this.readyPromise;
    const server = new McpServer({
      name: "DocsAgent",
      version: "1.0.0",
    });

    server.tool(
      "search",
      { query: z.string().describe("The search query for local documents") },
      async ({ query }) => {
        try {
          const results = await this.search(query);
          if (results.length === 0) return { content: [{ type: "text", text: "No results found." }] };
          const formatted = results.map(r => `[Score: ${r.score.toFixed(2)}]${r.path ? ` ${r.path}` : ""}${r.page ? ` (P${r.page})` : ""}\nContext: ${r.context}`).join("\n\n");
          return { content: [{ type: "text", text: formatted }] };
        } catch (error: any) {
          return { content: [{ type: "text", text: error.message }], isError: true };
        }
      }
    );

    server.tool(
      "add_docs",
      { dir: z.string().describe("The directory or file path to add") },
      async ({ dir }) => {
        try {
          await this.add(dir);
          return { content: [{ type: "text", text: `Added ${dir}` }] };
        } catch (error: any) {
          return { content: [{ type: "text", text: error.message }], isError: true };
        }
      }
    );

    const transport = new StdioServerTransport();
    await server.connect(transport);
  }
}
