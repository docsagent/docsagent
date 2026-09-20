type Level = "debug" | "info" | "warn" | "error";

const LEVELS: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

/**
 * All shell logs go to stderr — stdout carries the MCP stdio protocol.
 */
export class Logger {
  constructor(private level: Level = "info") {}

  setLevel(level: Level): void {
    this.level = level;
  }

  private write(level: Level, msg: string): void {
    if (LEVELS[level] < LEVELS[this.level]) return;
    process.stderr.write(`[docsagent] ${msg}\n`);
  }

  debug(msg: string): void {
    this.write("debug", msg);
  }
  info(msg: string): void {
    this.write("info", msg);
  }
  warn(msg: string): void {
    this.write("warn", msg);
  }
  error(msg: string): void {
    this.write("error", msg);
  }
}
