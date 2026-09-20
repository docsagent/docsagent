import { DocsAgentError } from "../../errors.js";
import { resolveId, textOutput, writeGate, type ToolHandler } from "../context.js";
import { markdownToHtml } from "../../zotero/markdown.js";
import { formatGlobalId } from "../../ids.js";

export const addNoteTool: ToolHandler = async (ctx, args) => {
  const confirmed = writeGate(ctx, args.confirmed);
  const gid = resolveId(ctx, args.id);
  if (gid.source !== "zotero") {
    throw new DocsAgentError(
      "capability_not_supported",
      "add_note currently supports the personal library only",
    );
  }
  const content = String(args.content);
  const tags = (Array.isArray(args.tags) ? args.tags : []).map((t) => String(t));

  if (!confirmed) {
    return textOutput({
      mode: "preview",
      parentId: args.id,
      contentPreview: content.slice(0, 500),
      tags,
      confirmed: false,
    });
  }

  const parent = await ctx.zotero.getItem(gid.localId);
  if (!parent) {
    throw new DocsAgentError("no_content", `Parent item not found: ${args.id}`, {
      tool: "get_metadata",
      args: { id: args.id, include: ["metadata"] },
    });
  }

  const html = markdownToHtml(content);
  const noteItem = {
    itemType: "note",
    parentItem: gid.localId,
    note: html,
    tags: tags.map((tag) => ({ tag })),
  };
  const { success, failed } = await ctx.zotero.createItems([noteItem]);
  const noteKey = success["0"];
  if (!noteKey) {
    throw new DocsAgentError(
      "web_api_error",
      `zotero local api: note creation failed — ${JSON.stringify(failed).slice(0, 300)}`,
    );
  }

  // Orphan verification (DESIGN.md §3.7): the note must reference its parent;
  // roll back and report orphan_note otherwise.
  const created = await ctx.zotero.getItem(noteKey);
  const parentItem = (created?.data as Record<string, unknown> | undefined)?.parentItem;
  if (parentItem !== gid.localId) {
    await ctx.zotero.deleteItem(noteKey).catch(() => undefined);
    throw new DocsAgentError(
      "orphan_note",
      "Note was created without its parent link; the write was rolled back",
    );
  }

  try {
    await ctx.core.call("updateIndex", { source: "zotero", itemKeys: [gid.localId, noteKey] });
  } catch (err) {
    ctx.logger.warn(`updateIndex failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  return textOutput({
    noteId: formatGlobalId("zotero", noteKey),
    parentId: args.id,
    confirmed: true,
  });
};
