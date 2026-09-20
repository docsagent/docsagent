import fs from "fs";
import os from "os";
import path from "path";
import { Ajv } from "ajv";
import { loadConfigSpec } from "./spec.js";
import { DocsAgentError } from "./errors.js";

export interface ZoteroGroupConfig {
  groupId: number;
  apiKey: string;
  displayName?: string;
  readOnly: boolean;
}

export interface DocsAgentConfig {
  coreHost: string;
  httpPort: number;
  coreBinary: string;
  zoteroDataDir: string;
  zoteroApiUrl: string;
  zoteroGroups: ZoteroGroupConfig[];
  indexCheckInterval: number;
  groupSyncInterval: number;
  enableWrites: boolean;
  writeRateLimitPerHour: number;
  defaultSource: string;
  maxTokensPerTool: number;
  logLevel: "debug" | "info" | "warn" | "error";
  transport: "stdio" | "streamable-http";
  httpListenAddr: string;
  authMode: "none" | "api-key" | "oauth2";
  authConfig: Record<string, unknown>;
  rbacRoles: Record<string, string[]>;
}

export const DEFAULT_CONFIG: DocsAgentConfig = {
  coreHost: "0.0.0.0",
  httpPort: 23120,
  coreBinary: "",
  zoteroDataDir: "~/Zotero",
  zoteroApiUrl: "http://localhost:23119/api",
  zoteroGroups: [],
  indexCheckInterval: 300,
  groupSyncInterval: 3600,
  enableWrites: false,
  writeRateLimitPerHour: 30,
  defaultSource: "zotero",
  maxTokensPerTool: 4000,
  logLevel: "info",
  transport: "stdio",
  httpListenAddr: "0.0.0.0:8080",
  authMode: "none",
  authConfig: {},
  rbacRoles: {},
};

export function expandHome(p: string): string {
  if (p === "~") return os.homedir();
  if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
  return p;
}

export function configPath(): string {
  return process.env.DOCSAGENT_CONFIG
    ? expandHome(process.env.DOCSAGENT_CONFIG)
    : path.join(os.homedir(), ".docsagent", "config.json");
}

const TYPE_CHECKS: Record<string, (v: unknown) => boolean> = {
  coreHost: (v) => typeof v === "string",
  httpPort: (v) => Number.isInteger(v),
  coreBinary: (v) => typeof v === "string",
  zoteroDataDir: (v) => typeof v === "string",
  zoteroApiUrl: (v) => typeof v === "string",
  zoteroGroups: (v) => Array.isArray(v),
  indexCheckInterval: (v) => Number.isInteger(v),
  groupSyncInterval: (v) => Number.isInteger(v),
  enableWrites: (v) => typeof v === "boolean",
  writeRateLimitPerHour: (v) => Number.isInteger(v),
  defaultSource: (v) => typeof v === "string",
  maxTokensPerTool: (v) => Number.isInteger(v),
  logLevel: (v) => ["debug", "info", "warn", "error"].includes(v as string),
  transport: (v) => ["stdio", "streamable-http"].includes(v as string),
  httpListenAddr: (v) => typeof v === "string",
  authMode: (v) => ["none", "api-key", "oauth2"].includes(v as string),
  authConfig: (v) => typeof v === "object" && v !== null && !Array.isArray(v),
  rbacRoles: (v) => typeof v === "object" && v !== null && !Array.isArray(v),
};

export function mergeConfig(fileValue: unknown): DocsAgentConfig {
  const merged: DocsAgentConfig = { ...DEFAULT_CONFIG, zoteroGroups: [], authConfig: {}, rbacRoles: {} };
  if (typeof fileValue !== "object" || fileValue === null) return merged;
  const obj = fileValue as Record<string, unknown>;
  for (const key of Object.keys(DEFAULT_CONFIG) as (keyof DocsAgentConfig)[]) {
    if (!(key in obj)) continue;
    const check = TYPE_CHECKS[key];
    if (check && !check(obj[key])) continue;
    (merged as unknown as Record<string, unknown>)[key] = obj[key];
  }
  return merged;
}

export function validateConfigFile(fileValue: unknown): string[] {
  const ajv = new Ajv({ allErrors: true });
  const validate = ajv.compile(loadConfigSpec());
  const ok = validate(fileValue);
  if (ok) return [];
  return (validate.errors ?? []).map((e) => `${e.instancePath || "/"}: ${e.message}`);
}

export function loadConfig(): DocsAgentConfig {
  const file = configPath();
  let fileValue: unknown = {};
  if (fs.existsSync(file)) {
    try {
      fileValue = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch (err) {
      throw new DocsAgentError(
        "invalid_params",
        `Config file ${file} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    const problems = validateConfigFile(fileValue);
    if (problems.length > 0) {
      process.stderr.write(
        `[docsagent] config warnings for ${file}:\n` + problems.map((p) => `  - ${p}`).join("\n") + "\n",
      );
    }
  }
  return mergeConfig(fileValue);
}

export function docsagentStateDir(): string {
  return path.join(os.homedir(), ".docsagent");
}
