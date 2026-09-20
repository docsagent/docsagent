export interface Dedupable {
  id: string;
  title?: string | null;
  year?: number | null;
}

function normalizeTitle(t: string): string {
  return t
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/**
 * spec/algorithms/dedup.md — pass 1 by exact id, pass 2 by normalized title + year.
 * Input must already be sorted by relevance desc; first occurrence wins.
 */
export function dedupResults<T extends Dedupable>(results: T[]): T[] {
  const seenIds = new Set<string>();
  const seenTitleYear = new Set<string>();
  const out: T[] = [];
  for (const r of results) {
    if (seenIds.has(r.id)) continue;
    seenIds.add(r.id);
    if (r.title) {
      const key = `${normalizeTitle(r.title)}\u0000${r.year ?? ""}`;
      if (seenTitleYear.has(key)) continue;
      seenTitleYear.add(key);
    }
    out.push(r);
  }
  return out;
}
