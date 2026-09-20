import { DocsAgentError } from "./errors.js";
import { suggestedCallFor } from "./spec.js";

/** ~4 chars per token; budgeting only, no tokenizer dependency. */
export function estimateTokens(text: string | undefined | null): number {
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}

export interface Budgetable {
  relevance: number;
  estimatedTokens: number;
}

export interface BudgetResult<T> {
  kept: T[];
  droppedIds: string[];
  truncated: boolean;
}

export interface HasId {
  id: string;
}

/**
 * List-level allocation (spec/algorithms/token-budget.md): sort by relevance desc,
 * accumulate whole items, drop the rest.
 */
export function allocateBudget<T extends Budgetable & HasId>(items: T[], maxTokens: number): BudgetResult<T> {
  const sorted = [...items].sort((a, b) => b.relevance - a.relevance);
  const kept: T[] = [];
  const droppedIds: string[] = [];
  let used = 0;
  for (const item of sorted) {
    const cost = item.estimatedTokens;
    if (Number.isFinite(cost) && used + cost <= maxTokens) {
      kept.push(item);
      used += cost;
    } else {
      droppedIds.push(item.id);
    }
  }
  return { kept, droppedIds, truncated: droppedIds.length > 0 };
}

export interface TruncatedText {
  text: string;
  truncated: boolean;
  fullLength?: number;
}

/** Content-level truncation (spec/algorithms/token-budget.md). */
export function truncateText(text: string, budgetTokens: number): TruncatedText {
  const limit = Math.max(1, budgetTokens) * 4;
  if (text.length <= limit) {
    return { text, truncated: false, fullLength: text.length };
  }
  return { text: text.slice(0, limit), truncated: true, fullLength: text.length };
}
