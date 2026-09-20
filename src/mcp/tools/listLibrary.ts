import { DocsAgentError } from "../../errors.js";
import { getSourceInfo, textOutput, type ToolHandler } from "../context.js";
import { estimateTokens } from "../../budget.js";
import { formatGlobalId } from "../../ids.js";

const MODES = ["collections", "items", "tags", "saved_searches", "standalone_notes"] as const;
type Mode = (typeof MODES)[number];

export const listLibraryTool: ToolHandler = async (ctx, args) => {
  const mode = (args.mode ?? "collections") as Mode;
  const source = ctx.config.defaultSource;
  const info = getSourceInfo(ctx, source);
  const browseModes = info.browseModes ?? MODES as unknown as string[];
  if (!browseModes.includes(mode)) {
    throw new DocsAgentError(
      "capability_not_supported",
      `Source "${source}" does not support browse mode "${mode}" (supported: ${browseModes.join(", ")})`,
    );
  }
  const limit = Math.min(Number(args.limit ?? 50), 200);
  const maxTokens = Number(args.max_tokens ?? 2000);

  let entries: Array<Record<string, unknown>>;
  let key: string;
  switch (mode) {
    case "collections": {
      const res = await ctx.core.call<{ collections: Array<Record<string, unknown>> }>("listCollections", {
        source,
        parentId: args.parentId ?? null,
      });
      key = "collections";
      entries = res.collections;
      break;
    }
    case "items": {
      const containerId = args.containerId;
      if (typeof containerId !== "string" || containerId.length === 0) {
        throw new DocsAgentError("invalid_params", "mode=items requires containerId");
      }
      const res = await ctx.core.call<{ items: Array<Record<string, unknown>> }>("listCollectionItems", {
        source,
        containerId,
      });
      key = "items";
      entries = res.items.map((it) => ({ ...it, id: formatGlobalId(source, String(it.id)) }));
      break;
    }
    case "tags": {
      const res = await ctx.core.call<{ tags: Array<Record<string, unknown>> }>("listTags", { source });
      key = "tags";
      entries = res.tags;
      break;
    }
    case "saved_searches": {
      const res = await ctx.core.call<{ searches: Array<Record<string, unknown>> }>("listSavedSearches", { source });
      key = "searches";
      entries = res.searches;
      break;
    }
    case "standalone_notes": {
      const res = await ctx.core.call<{ notes: Array<Record<string, unknown>> }>("listStandaloneNotes", { source });
      key = "notes";
      entries = res.notes.map((n) => ({ ...n, id: formatGlobalId(source, String(n.id)) }));
      break;
    }
    default: {
      throw new DocsAgentError("invalid_params", `Unknown mode "${mode}"`);
    }
  }

  const total = entries.length;
  const limited = entries.slice(0, limit);
  // Token ceiling: shrink further if the entries themselves blow the budget.
  let used = 0;
  const kept: Array<Record<string, unknown>> = [];
  for (const entry of limited) {
    const cost = estimateTokens(JSON.stringify(entry));
    if (used + cost > maxTokens) break;
    kept.push(entry);
    used += cost;
  }
  return textOutput({
    mode,
    [key]: kept,
    total,
    truncated: kept.length < total,
  });
};
