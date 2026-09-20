import fs from "fs";
import path from "path";
import { DocsAgentError } from "../../errors.js";
import { textOutput, writeGate, type ToolContext, type ToolHandler } from "../context.js";
import { cslToZoteroItem, resolveIdentifier } from "../../zotero/csl.js";
import { formatGlobalId } from "../../ids.js";

interface PreviewEntry {
  path?: string;
  identifier?: string;
  metadata: Record<string, unknown>;
  suggestedCollections: string[];
}

export const importItemTool: ToolHandler = async (ctx, args) => {
  const confirmed = writeGate(ctx, args.confirmed);
  const containerId = typeof args.containerId === "string" ? args.containerId : undefined;
  const autoClassify = args.autoClassify === true;

  if (Array.isArray(args.paths)) {
    const paths = (args.paths as string[]).map((p) => path.resolve(p));
    for (const p of paths) {
      if (!fs.existsSync(p)) {
        throw new DocsAgentError("invalid_params", `File not found: ${p}`);
      }
    }
    if (!confirmed) {
      const items: PreviewEntry[] = [];
      for (const p of paths) {
        items.push({
          path: p,
          metadata: {
            title: path.basename(p, path.extname(p)),
            contentType: "application/pdf",
            sizeBytes: fs.statSync(p).size,
            source: "local file",
          },
          suggestedCollections: autoClassify ? await suggestCollections(ctx, path.basename(p)) : [],
        });
      }
      return textOutput({ mode: "preview", items, confirmed: false });
    }
    const results: Array<Record<string, unknown>> = [];
    const createdKeys: string[] = [];
    for (const p of paths) {
      const item = {
        itemType: "attachment",
        linkMode: "imported_file",
        title: path.basename(p),
        path: p,
        contentType: "application/pdf",
        tags: [],
        collections: containerId ? [containerId] : [],
      };
      try {
        const { success, failed } = await ctx.zotero.createItems([item]);
        const key = success["0"];
        if (!key) {
          results.push({ path: p, status: "failed", error: JSON.stringify(failed).slice(0, 300) });
          continue;
        }
        createdKeys.push(key);
        results.push({ path: p, status: "created", itemKey: formatGlobalId("zotero", key) });
      } catch (err) {
        results.push({ path: p, status: "failed", error: err instanceof Error ? err.message : String(err) });
      }
    }
    await notifyIndex(ctx, createdKeys);
    return textOutput({ results, confirmed: true });
  }

  // identifiers
  const identifiers = args.identifiers as string[];
  if (!confirmed) {
    const items: PreviewEntry[] = [];
    for (const identifier of identifiers) {
      const csl = await resolveIdentifier(identifier).catch(() => null);
      const metadata = csl
        ? (cslToZoteroItem(csl) as Record<string, unknown>)
        : { title: identifier, note: "identifier could not be resolved; will be imported as-is" };
      items.push({
        identifier,
        metadata,
        suggestedCollections: autoClassify && csl ? await suggestCollections(ctx, String(csl.title ?? "")) : [],
      });
    }
    return textOutput({ mode: "preview", items, confirmed: false });
  }

  const results: Array<Record<string, unknown>> = [];
  const createdKeys: string[] = [];
  for (const identifier of identifiers) {
    const item: Record<string, unknown> = {
      tags: [],
      collections: containerId ? [containerId] : [],
    };
    if (/^10\.\d{4,9}\//i.test(identifier.trim())) {
      item.DOI = identifier.trim();
    }
    try {
      const csl = await resolveIdentifier(identifier).catch(() => null);
      if (csl) {
        Object.assign(item, cslToZoteroItem(csl));
        if (containerId) item.collections = [containerId];
      } else {
        item.itemType = "journalArticle";
        item.title = identifier;
      }
      const { success, failed } = await ctx.zotero.createItems([item]);
      const key = success["0"];
      if (!key) {
        results.push({ identifier, status: "failed", error: JSON.stringify(failed).slice(0, 300) });
        continue;
      }
      createdKeys.push(key);
      results.push({ identifier, status: "created", itemKey: formatGlobalId("zotero", key) });
    } catch (err) {
      results.push({ identifier, status: "failed", error: err instanceof Error ? err.message : String(err) });
    }
  }
  await notifyIndex(ctx, createdKeys);
  return textOutput({ results, confirmed: true });
};

async function notifyIndex(ctx: ToolContext, itemKeys: string[]): Promise<void> {
  if (itemKeys.length === 0) return;
  try {
    await ctx.core.call("updateIndex", { source: "zotero", itemKeys });
  } catch (err) {
    ctx.logger.warn(`updateIndex failed (index will catch up): ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** Keyword-overlap heuristic between the title and existing collection names. */
async function suggestCollections(ctx: ToolContext, title: string): Promise<string[]> {
  try {
    const { collections } = await ctx.core.call<{ collections: Array<{ id: string; name: string }> }>(
      "listCollections",
      { source: "zotero", parentId: null },
    );
    const words = new Set(
      title
        .toLowerCase()
        .split(/[^\p{L}\p{N}]+/u)
        .filter((w) => w.length > 3),
    );
    return collections
      .filter((c) => {
        const nameWords = c.name.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 3);
        return nameWords.some((w) => words.has(w));
      })
      .map((c) => c.name)
      .slice(0, 5);
  } catch {
    return [];
  }
}
