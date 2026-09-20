import { DocsAgentError } from "../../errors.js";
import { resolveId, textOutput, writeGate, type ToolHandler } from "../context.js";

const BATCH_SIZE = 50;
const BULK_CONFIRM_THRESHOLD = 20;

type Action = "add_to_collection" | "remove_from_collection" | "add_tags" | "remove_tags";

interface ZoteroItem {
  key: string;
  version: number;
  data: Record<string, unknown>;
}

export const batchModifyTool: ToolHandler = async (ctx, args) => {
  const confirmed = writeGate(ctx, args.confirmed);
  const action = args.action as Action;
  const ids = args.ids as string[];

  const targets: Array<{ globalId: string; localId: string }> = [];
  for (const raw of ids) {
    const gid = resolveId(ctx, raw);
    if (gid.source !== "zotero") {
      throw new DocsAgentError(
        "capability_not_supported",
        `batch_modify currently supports the personal library only (got "${raw}")`,
      );
    }
    targets.push({ globalId: raw, localId: gid.localId });
  }

  if (!confirmed) {
    // Write safety gate layer 3: anything above 20 items must be explicitly confirmed.
    const preview = {
      mode: "preview",
      action,
      affectedCount: targets.length,
      sampleIds: targets.slice(0, 5).map((t) => t.globalId),
      requiresConfirmation: targets.length > BULK_CONFIRM_THRESHOLD,
      confirmed: false,
    };
    return textOutput(preview);
  }

  const containerId = typeof args.containerId === "string" ? args.containerId : undefined;
  const tags = Array.isArray(args.tags) ? (args.tags as string[]) : undefined;

  const items: ZoteroItem[] = [];
  const missing: string[] = [];
  for (const t of targets) {
    const raw = await ctx.zotero.getItem(t.localId);
    const data = raw?.data as Record<string, unknown> | undefined;
    if (!raw || !data) {
      missing.push(t.globalId);
      continue;
    }
    items.push({
      key: String(data.key ?? t.localId),
      version: Number(data.version ?? 0),
      data,
    });
  }

  let affected = 0;
  for (const item of items) {
    const changed = applyAction(item.data, action, containerId, tags);
    if (changed) affected += 1;
  }

  const batches: Array<Record<string, unknown>> = [];
  let updated = 0;
  let failed = 0;
  for (let i = 0; i < items.length; i += BATCH_SIZE) {
    const chunk = items.slice(i, i + BATCH_SIZE).map((item) => ({
      ...item.data,
      key: item.key,
      version: item.version,
    }));
    const { success, failed: batchFailed } = await ctx.zotero.replaceItems(chunk);
    const okCount = Object.keys(success).length;
    const failCount = countFailed(batchFailed);
    updated += okCount;
    failed += failCount;
    batches.push({ batch: Math.floor(i / BATCH_SIZE) + 1, updated: okCount, failed: failCount });
  }

  if (affected > 0) {
    try {
      await ctx.core.call("updateIndex", { source: "zotero", itemKeys: items.map((i) => i.key) });
    } catch (err) {
      ctx.logger.warn(`updateIndex failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return textOutput({
    action,
    success: failed === 0,
    affected,
    updated,
    failed,
    batches,
    missing,
    confirmed: true,
  });
};

function applyAction(
  data: Record<string, unknown>,
  action: Action,
  containerId: string | undefined,
  tags: string[] | undefined,
): boolean {
  if (action === "add_to_collection" || action === "remove_from_collection") {
    const collections = Array.isArray(data.collections) ? [...(data.collections as string[])] : [];
    const idx = collections.indexOf(containerId as string);
    if (action === "add_to_collection" && idx < 0) {
      data.collections = [...collections, containerId];
      return true;
    }
    if (action === "remove_from_collection" && idx >= 0) {
      data.collections = collections.filter((c) => c !== containerId);
      return true;
    }
    return false;
  }
  const current = Array.isArray(data.tags) ? (data.tags as Array<{ tag: string }>).map((t) => t.tag) : [];
  const set = new Set(current);
  let changed = false;
  if (action === "add_tags") {
    for (const tag of tags as string[]) {
      if (!set.has(tag)) {
        set.add(tag);
        changed = true;
      }
    }
  } else {
    for (const tag of tags as string[]) {
      if (set.has(tag)) {
        set.delete(tag);
        changed = true;
      }
    }
  }
  if (changed) data.tags = Array.from(set).map((tag) => ({ tag }));
  return changed;
}

function countFailed(failed: unknown): number {
  if (typeof failed !== "object" || failed === null) return 0;
  return Object.keys(failed as Record<string, unknown>).length;
}
