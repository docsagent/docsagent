import { DocsAgentError } from "../../errors.js";
import { suggestedCallFor } from "../../spec.js";
import { resolveId, textOutput, type ToolHandler } from "../context.js";
import { truncateText } from "../../budget.js";
import { formatGlobalId } from "../../ids.js";

export const getContentTool: ToolHandler = async (ctx, args) => {
  const gid = resolveId(ctx, args.id);
  const mode = (args.mode ?? "passages") as "passages" | "fulltext";
  const maxTokens = Number(args.max_tokens ?? ctx.config.maxTokensPerTool);

  if (mode === "passages") {
    const query = args.query ? String(args.query) : "";
    if (!query) {
      throw new DocsAgentError(
        "missing_query",
        "get_content with mode=passages requires a query; use mode=fulltext to page through the text",
        suggestedCallFor("missing_query"),
      );
    }
    const res = await ctx.core.call<{ passages: Array<{ text: string; page?: number | null; score: number }> }>(
      "searchPassages",
      { source: gid.source, docId: gid.localId, query, k: Number(args.k ?? 5) },
    );
    return textOutput({
      type: "document",
      mode: "passages",
      id: args.id,
      passages: res.passages,
    });
  }

  const res = await ctx.core.call<{
    kind: "document" | "note";
    text: string;
    offset?: number;
    nextOffset?: number | null;
    totalLength: number;
    noteType?: string | null;
    parentId?: string | null;
    tags?: string[];
    createdAt?: string | null;
  }>("getContent", {
    source: gid.source,
    id: gid.localId,
    offset: Number(args.offset ?? 0),
    limit: maxTokens * 4,
  });

  const cut = truncateText(res.text, maxTokens);
  if (res.kind === "note") {
    return textOutput({
      type: "note",
      id: args.id,
      noteType: res.noteType ?? "standalone",
      parentId: res.parentId ? formatGlobalId(gid.source, res.parentId) : null,
      format: "text",
      text: cut.text,
      tags: res.tags ?? [],
      createdAt: res.createdAt ?? null,
      truncated: cut.truncated,
      fullLength: cut.fullLength,
    });
  }
  return textOutput({
    type: "document",
    mode: "fulltext",
    id: args.id,
    text: cut.text,
    offset: res.offset ?? 0,
    nextOffset: res.nextOffset ?? null,
    totalLength: res.totalLength,
    truncated: cut.truncated || res.totalLength > res.text.length,
  });
};
