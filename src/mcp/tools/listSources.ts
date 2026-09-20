import { textOutput, type ToolHandler } from "../context.js";

export const listSourcesTool: ToolHandler = async (ctx) => {
  const { sources } = await ctx.core.listSources();
  ctx.sources = sources;
  const enriched = await Promise.all(
    sources.map(async (s) => {
      try {
        const stats = await ctx.core.call<Record<string, unknown>>("getStats", { source: s.name });
        return { ...s, counts: stats };
      } catch {
        return { ...s, counts: null };
      }
    }),
  );
  return textOutput({ sources: enriched });
};
