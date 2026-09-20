import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

export interface ToolSpec {
  name: string;
  title?: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface SuggestedCall {
  tool?: string;
  args?: Record<string, unknown>;
  note?: string;
}

export interface ErrorSpecEntry {
  trigger: string;
  suggested_call: SuggestedCall | null;
}

export interface ErrorsSpec {
  version: string;
  errors: Record<string, ErrorSpecEntry>;
}

function findPackageRoot(startDir: string): string {
  let dir = startDir;
  for (;;) {
    if (fs.existsSync(path.join(dir, "package.json"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) {
      throw new Error(`package.json not found above ${startDir}`);
    }
    dir = parent;
  }
}

export const PACKAGE_ROOT = findPackageRoot(path.dirname(fileURLToPath(import.meta.url)));

export const SPEC_DIR = path.join(PACKAGE_ROOT, "spec");
const TOOLS_DIR = path.join(SPEC_DIR, "tools");

let toolSpecs: ToolSpec[] | null = null;
let errorsSpec: ErrorsSpec | null = null;
let configSpec: Record<string, unknown> | null = null;

export function loadToolSpecs(): ToolSpec[] {
  if (toolSpecs) return toolSpecs;
  const files = fs
    .readdirSync(TOOLS_DIR)
    .filter((f) => f.endsWith(".json"))
    .sort();
  toolSpecs = files.map((f) => {
    const spec = JSON.parse(fs.readFileSync(path.join(TOOLS_DIR, f), "utf8")) as ToolSpec;
    const expected = f.replace(/\.json$/, "");
    if (spec.name !== expected) {
      throw new Error(`spec/tools/${f}: name "${spec.name}" does not match file name "${expected}"`);
    }
    return spec;
  });
  return toolSpecs;
}

export function loadToolSpec(name: string): ToolSpec | undefined {
  return loadToolSpecs().find((t) => t.name === name);
}

export function loadErrorsSpec(): ErrorsSpec {
  if (errorsSpec) return errorsSpec;
  errorsSpec = JSON.parse(fs.readFileSync(path.join(SPEC_DIR, "errors.json"), "utf8")) as ErrorsSpec;
  return errorsSpec;
}

export function loadConfigSpec(): Record<string, unknown> {
  if (configSpec) return configSpec;
  configSpec = JSON.parse(fs.readFileSync(path.join(SPEC_DIR, "config.json"), "utf8")) as Record<
    string,
    unknown
  >;
  return configSpec;
}

export function suggestedCallFor(code: string): SuggestedCall | undefined {
  const entry = loadErrorsSpec().errors[code];
  return entry?.suggested_call ?? undefined;
}
