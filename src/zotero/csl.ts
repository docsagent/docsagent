/**
 * CSL JSON -> Zotero item conversion for import_item identifiers
 * (metadata resolved via the official Zotero translation server).
 */

const TYPE_MAP: Record<string, string> = {
  "journal-article": "journalArticle",
  "book-chapter": "bookSection",
  "proceedings-article": "conferencePaper",
  "posted-content": "preprint",
  report: "report",
  thesis: "thesis",
  book: "book",
  dataset: "document",
};

export function cslToZoteroItem(csl: Record<string, unknown>): Record<string, unknown> {
  const type = TYPE_MAP[String(csl.type ?? "")] ?? "journalArticle";
  return {
    itemType: type,
    title: csl.title ?? "",
    creators: mapCreators(csl.author, "author").concat(mapCreators(csl.editor, "editor")),
    abstractNote: (csl.abstract as string) ?? "",
    date: formatDate(csl.issued),
    publicationTitle: (csl["container-title"] as string) ?? "",
    volume: (csl.volume as string) ?? "",
    issue: (csl.issue as string) ?? "",
    pages: (csl.page as string) ?? "",
    DOI: (csl.DOI as string) ?? "",
    url: (csl.URL as string) ?? "",
    ISSN: (csl.ISSN as string) ?? "",
    publisher: (csl.publisher as string) ?? "",
    language: (csl.language as string) ?? "",
  };
}

function formatDate(issued: unknown): string {
  const parts = (issued as { "date-parts"?: number[][] } | undefined)?.["date-parts"]?.[0];
  if (!parts || parts.length === 0) return "";
  return parts.join("-");
}

function mapCreators(
  people: unknown,
  creatorType: string,
): Array<Record<string, unknown>> {
  if (!Array.isArray(people)) return [];
  return people.map((p) => {
    const person = p as { given?: string; family?: string; literal?: string };
    if (person.literal) return { creatorType, name: person.literal };
    return { creatorType, firstName: person.given ?? "", lastName: person.family ?? "" };
  });
}

/** Identifier detection: DOI / ISBN / arXiv (import_item preview path). */
export function detectIdentifier(s: string): "doi" | "isbn" | "arxiv" | null {
  const t = s.trim();
  if (/^10\.\d{4,9}\//i.test(t)) return "doi";
  if (/^arxiv:/i.test(t)) return "arxiv";
  if (/^(97[89][- ]?)?\d{1,5}[- ]?\d+[- ]?\d+[- ]?[\dX]$/i.test(t)) return "isbn";
  return null;
}

/** Resolve an identifier to CSL JSON via the official Zotero translation server. */
export async function resolveIdentifier(identifier: string): Promise<Record<string, unknown> | null> {
  const res = await fetch("https://translate.zotero.org/search", {
    method: "POST",
    headers: { "Content-Type": "text/plain" },
    body: identifier.trim(),
  });
  if (!res.ok) return null;
  const data = (await res.json()) as Array<Record<string, unknown>>;
  return Array.isArray(data) && data.length > 0 ? data[0] : null;
}
