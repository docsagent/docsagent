import { DocsAgentError } from "./errors.js";

export interface GlobalId {
  source: string;
  localId: string;
}

/**
 * Global ID format: `{source}:{localId}`.
 * Group sources contain a colon themselves: `zotero-group:{gid}:{localId}`.
 */
export function parseGlobalId(id: string, defaultSource?: string): GlobalId {
  if (id.startsWith("zotero-group:")) {
    const rest = id.slice("zotero-group:".length);
    const sep = rest.indexOf(":");
    if (sep > 0 && sep < rest.length - 1) {
      return { source: `zotero-group:${rest.slice(0, sep)}`, localId: rest.slice(sep + 1) };
    }
  } else {
    const sep = id.indexOf(":");
    if (sep > 0 && sep < id.length - 1) {
      return { source: id.slice(0, sep), localId: id.slice(sep + 1) };
    }
  }
  if (defaultSource && !id.includes(":") && id.length > 0) {
    return { source: defaultSource, localId: id };
  }
  throw new DocsAgentError(
    "invalid_params",
    `Invalid global id "${id}": expected "{source}:{localId}", e.g. "zotero:ABCD1234"`,
  );
}

export function formatGlobalId(source: string, localId: string): string {
  return `${source}:${localId}`;
}

/** Group source name for a group id. */
export function groupSourceName(groupId: number | string): string {
  return `zotero-group:${groupId}`;
}
