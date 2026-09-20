import { getSourceInfo, requireInclude, resolveId, textOutput, type ToolHandler } from "../context.js";
import { estimateTokens } from "../../budget.js";

interface NoteItem {
  id: string;
  html?: string;
  text: string;
  tags?: string[];
  dateAdded?: string | null;
}

export const getMetadataTool: ToolHandler = async (ctx, args) => {
  const gid = resolveId(ctx, args.id);
  const info = getSourceInfo(ctx, gid.source);
  const include = (args.include ?? ["metadata"]) as string[];
  for (const inc of include) requireInclude(info, inc);
  const maxTokens = Number(args.max_tokens ?? ctx.config.maxTokensPerTool);

  const out: Record<string, unknown> = { id: args.id, source: gid.source };
  let truncated = false;
  let fullLength: number | undefined;

  const needsItem = include.includes("metadata") || include.includes("abstract");
  if (needsItem) {
    const item = await ctx.core.call<Record<string, unknown>>("getItem", { source: gid.source, id: gid.localId });
    if (include.includes("metadata")) out.metadata = item;
    if (include.includes("abstract")) out.abstract = (item.abstractNote as string) ?? null;
  }
  if (include.includes("annotations")) {
    const res = await ctx.core.call<{ annotations: unknown[] }>("getAnnotations", {
      source: gid.source,
      id: gid.localId,
    });
    out.annotations = res.annotations;
  }
  if (include.includes("notes")) {
    const res = await ctx.core.call<{ notes: NoteItem[] }>("getNotes", { source: gid.source, id: gid.localId });
    // spec/algorithms/token-budget.md — full notes until the budget is hit, then
    // truncate the overflowing note and drop the rest.
    const notes: NoteItem[] = [];
    let used = 0;
    for (const note of res.notes) {
      const body = note.text ?? "";
      const cost = estimateTokens(body);
      if (used + cost <= maxTokens) {
        notes.push(note);
        used += cost;
        continue;
      }
      const remainingChars = Math.max(0, (maxTokens - used) * 4);
      if (remainingChars > 0) {
        notes.push({ ...note, text: body.slice(0, remainingChars) });
        truncated = true;
        fullLength = body.length;
      } else {
        truncated = true;
        fullLength = body.length;
      }
      break;
    }
    out.notes = notes;
  }
  if (include.includes("citation")) {
    const res = await ctx.core.call<{ citation: string | Record<string, unknown> }>("getCitation", {
      source: gid.source,
      id: gid.localId,
      format: args.citationFormat ?? "bibtex",
      style: args.citationStyle ?? null,
    });
    out.citation = res.citation;
  }
  if (truncated) {
    out.truncated = true;
    if (fullLength !== undefined) out.fullLength = fullLength;
  }
  return textOutput(out);
};
