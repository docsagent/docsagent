import {
  getSourceInfo,
  requireCapability,
  requireTarget,
  textOutput,
  type ToolContext,
  type ToolHandler,
  type ToolOutput,
} from "../context.js";
import { dedupResults } from "../../dedup.js";
import { allocateBudget, estimateTokens } from "../../budget.js";
import { formatGlobalId } from "../../ids.js";

interface CoreResult {
  id: string;
  type: string;
  relevance: number;
  title?: string | null;
  authors?: string[] | null;
  year?: number | null;
  itemType?: string;
  itemTitle?: string | null;
  text?: string | null;
  comment?: string | null;
  color?: string | null;
  page?: number | null;
  noteType?: string | null;
  parentId?: string | null;
  excerpt?: string | null;
}

interface Passage {
  text: string;
  page?: number | null;
  score: number;
}

interface GrepHit {
  line: number;
  column: number;
  offset: number;
  hitStart: number;
  hitLength: number;
}

interface GrepSnippet {
  text: string;
  page?: number | null;
  field?: string | null;
  leading?: boolean;
  trailing?: boolean;
  hitsTruncated?: boolean;
  hits: GrepHit[];
}

interface CoreGrepResult extends CoreResult {
  matchCount: number;
  matchesTruncated: boolean;
  snippets?: GrepSnippet[];
}

/** Decorated result: dedupable via id/title/year, rest is open. */
interface Decorated {
  id: string;
  title?: string | null;
  year?: number | null;
  [key: string]: unknown;
}

type Depth = "ids" | "snippets" | "full";

const TARGET_TO_TYPE: Record<string, string> = {
  items: "item",
  annotations: "annotation",
  notes: "note",
};

export const searchTool: ToolHandler = async (ctx, args) => {
  const mode = (args.mode ?? "relevance") as string;
  return mode === "grep" ? grepBranch(ctx, args) : relevanceBranch(ctx, args);
};

async function relevanceBranch(ctx: ToolContext, args: Record<string, unknown>): Promise<ToolOutput> {
  const query = String(args.query);
  const targets = (Array.isArray(args.target) ? args.target : [args.target ?? "items"]) as string[];
  const depth = (args.depth ?? "snippets") as Depth;
  const snippetsPerResult = Number(args.snippetsPerResult ?? 3);
  const k = Number(args.k ?? 10);
  const maxTokens = Number(args.max_tokens ?? ctx.config.maxTokensPerTool);

  const source = ctx.config.defaultSource;
  const info = getSourceInfo(ctx, source);
  for (const t of targets) requireTarget(info, t);

  const { results } = await ctx.core.call<{ results: CoreResult[] }>("search", {
    source,
    targets,
    query,
    filters: args.filters,
    k,
  });

  const grouped = groupByTarget(results, targets);
  const docTargets = targets.filter((t) => t === "items" || t === "notes");
  const needSnippets = (depth === "snippets" || depth === "full") && docTargets.length > 0;

  // docId -> passages (one round trip for all documents)
  const passageMap = new Map<string, Passage[]>();
  if (needSnippets) {
    const docIds = Array.from(new Set(docTargets.flatMap((t) => grouped[t]).map((r) => r.id))).slice(0, 100);
    if (docIds.length > 0) {
      const { docs } = await ctx.core.call<{ docs: Array<{ docId: string; passages: Passage[] }> }>(
        "batchSearchPassages",
        { source, docIds, query, k: snippetsPerResult },
      );
      for (const d of docs) passageMap.set(d.docId, d.passages ?? []);
    }
  }

  const fullTextMap = depth === "full" ? await fetchFullTexts(ctx, source, docTargets, grouped, maxTokens) : new Map();

  return finalize({
    source,
    targets,
    grouped,
    maxTokens,
    decorate: (r) => decorate(source, r, depth, passageMap, fullTextMap),
  });
}

async function grepBranch(ctx: ToolContext, args: Record<string, unknown>): Promise<ToolOutput> {
  const pattern = String(args.pattern);
  const targets = (Array.isArray(args.target) ? args.target : [args.target ?? "items"]) as string[];
  const depth = (args.depth ?? "snippets") as Depth;
  const snippetsPerResult = Number(args.snippetsPerResult ?? 3);
  const k = Number(args.k ?? 10);
  const maxTokens = Number(args.max_tokens ?? ctx.config.maxTokensPerTool);
  const caseSensitive = args.caseSensitive === true;
  const wholeWord = args.wholeWord === true;
  const maxMatches = Number(args.maxMatches ?? 1000);

  const source = ctx.config.defaultSource;
  const info = getSourceInfo(ctx, source);
  for (const t of targets) requireTarget(info, t);
  requireCapability(info, "grep");

  // One call: the scan returns its own hit windows, so no batchSearchPassages.
  const scan = await ctx.core.call<{ results: CoreGrepResult[]; totalMatches: number; truncated: boolean }>("grep", {
    source,
    targets,
    pattern,
    caseSensitive,
    wholeWord,
    filters: args.filters,
    k,
    maxMatches,
    maxSnippetsPerDoc: snippetsPerResult,
  });

  const grouped = groupByTarget(scan.results ?? [], targets);
  const docTargets = targets.filter((t) => t === "items" || t === "notes");
  const fullTextMap = depth === "full" ? await fetchFullTexts(ctx, source, docTargets, grouped, maxTokens) : new Map();

  return finalize({
    source,
    targets,
    grouped,
    maxTokens,
    extra: { totalMatches: scan.totalMatches ?? 0 },
    extraTruncated: scan.truncated === true,
    decorate: (r) => decorateGrep(source, r, depth, fullTextMap),
  });
}

function groupByTarget<T extends CoreResult>(results: T[], targets: string[]): Record<string, T[]> {
  const grouped: Record<string, T[]> = {};
  for (const target of targets) {
    grouped[target] = results.filter((r) => r.type === TARGET_TO_TYPE[target]);
  }
  return grouped;
}

async function fetchFullTexts(
  ctx: ToolContext,
  source: string,
  docTargets: string[],
  grouped: Record<string, CoreResult[]>,
  maxTokens: number,
): Promise<Map<string, { text: string; truncated: boolean }>> {
  const map = new Map<string, { text: string; truncated: boolean }>();
  for (const target of docTargets) {
    for (const r of grouped[target]) {
      const res = await ctx.core.call<{ kind: string; text: string; totalLength: number }>("getContent", {
        source,
        id: r.id,
        offset: 0,
        limit: maxTokens * 4,
      });
      map.set(r.id, { text: res.text, truncated: res.totalLength > res.text.length });
    }
  }
  return map;
}

interface FinalizeInput {
  source: string;
  targets: string[];
  grouped: Record<string, CoreResult[]>;
  maxTokens: number;
  decorate: (r: CoreResult) => Decorated;
  extra?: Record<string, unknown>;
  extraTruncated?: boolean;
}

/** dedup -> estimate -> budget -> single-target / groups envelope (spec/algorithms/token-budget.md). */
function finalize(o: FinalizeInput): ToolOutput {
  const groups: Record<string, { total: number; bySource: Record<string, { results: unknown[] }> }> = {};
  let anyTruncated = o.extraTruncated === true;
  let anyDropped = 0;

  for (const target of o.targets) {
    const decorated = o.grouped[target].map(o.decorate);
    const deduped = dedupResults(decorated);
    const withCost = deduped.map((r) => ({
      ...r,
      relevance: (r.relevance as number | undefined) ?? 0,
      estimatedTokens: estimateTokens(JSON.stringify(r)),
    }));
    const budget = allocateBudget(withCost, o.maxTokens);
    anyTruncated = anyTruncated || budget.truncated;
    anyDropped += budget.droppedIds.length;
    groups[target] = {
      total: deduped.length,
      bySource: { [o.source]: { results: budget.kept } },
    };
  }

  if (o.targets.length === 1) {
    const only = groups[o.targets[0]];
    return textOutput({
      results: only.bySource[o.source].results,
      total: only.total,
      ...(o.extra ?? {}),
      truncated: anyTruncated,
      dropped: anyDropped,
    });
  }
  return textOutput({ groups, ...(o.extra ?? {}), truncated: anyTruncated, dropped: anyDropped });
}

function decorate(
  source: string,
  r: CoreResult,
  depth: Depth,
  passageMap: Map<string, Passage[]>,
  fullTextMap: Map<string, { text: string; truncated: boolean }>,
): Decorated {
  const gid = formatGlobalId(source, r.id);
  const base: Decorated = {
    id: gid,
    source,
    type: r.type,
    relevance: r.relevance,
  };
  if (r.type === "item" || r.type === "attachment") {
    base.title = r.title ?? null;
    base.authors = r.authors ?? [];
    base.year = r.year ?? null;
  } else if (r.type === "annotation") {
    base.itemTitle = r.itemTitle ?? null;
    base.text = r.text ?? "";
    base.comment = r.comment ?? null;
    base.color = r.color ?? null;
    base.page = r.page ?? null;
  } else if (r.type === "note") {
    base.noteType = r.noteType ?? "child";
    base.parentId = r.parentId ? formatGlobalId(source, r.parentId) : null;
    base.excerpt = r.excerpt ?? (r.text ? r.text.slice(0, 200) : null);
  }
  if (depth === "snippets") {
    const passages = passageMap.get(r.id);
    if (passages && passages.length > 0) base.snippets = passages.map((p) => ({ text: p.text, page: p.page ?? null, score: p.score }));
  } else if (depth === "full") {
    const full = fullTextMap.get(r.id);
    if (full) {
      base.text = full.text;
      if (full.truncated) base.textTruncated = true;
    }
  }
  return base;
}

function decorateGrep(
  source: string,
  row: CoreResult,
  depth: Depth,
  fullTextMap: Map<string, { text: string; truncated: boolean }>,
): Decorated {
  const r = row as CoreGrepResult;
  const gid = formatGlobalId(source, r.id);
  // No ranking in grep mode: relevance stays 0 so the stable budget sort keeps core order.
  const base: Decorated = { id: gid, source, type: r.type, relevance: 0 };
  if (r.type === "item" || r.type === "attachment") {
    base.title = r.title ?? null;
    base.authors = r.authors ?? [];
    base.year = r.year ?? null;
  } else if (r.type === "annotation") {
    base.itemTitle = r.itemTitle ?? null;
    base.text = r.text ?? "";
    base.comment = r.comment ?? null;
    base.color = r.color ?? null;
    base.page = r.page ?? null;
  } else if (r.type === "note") {
    base.noteType = r.noteType ?? "child";
    base.parentId = r.parentId ? formatGlobalId(source, r.parentId) : null;
    base.excerpt = r.excerpt ?? null;
  }
  base.matchCount = r.matchCount ?? 0;
  base.matchesTruncated = r.matchesTruncated === true;
  if (depth === "snippets") {
    if (r.snippets && r.snippets.length > 0) {
      base.snippets = r.snippets.map((s) => ({
        text: s.text,
        page: s.page ?? null,
        field: s.field ?? null,
        leading: s.leading === true,
        trailing: s.trailing === true,
        hitsTruncated: s.hitsTruncated === true,
        hits: s.hits ?? [],
      }));
    }
  } else if (depth === "full") {
    const full = fullTextMap.get(r.id);
    if (full) {
      base.text = full.text;
      if (full.truncated) base.textTruncated = true;
    }
  }
  return base;
}
