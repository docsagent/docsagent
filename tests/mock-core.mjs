/**
 * Mock DocsAgent Core for smoke tests: JSON-RPC 2.0 over POST /rpc, mirroring
 * spec/api/methods.json for the methods the shell exercises.
 */
import http from "node:http";

const SOURCES = [
  {
    name: "zotero",
    displayName: "My Library",
    type: "zotero",
    status: "ready",
    writable: true,
    targets: ["items", "annotations", "notes"],
    includes: ["metadata", "abstract", "annotations", "notes", "citation"],
    browseModes: ["collections", "items", "tags", "saved_searches", "standalone_notes"],
    filters: ["containerId", "tags", "yearFrom", "yearTo", "itemType", "authors", "colors", "titleContains"],
    capabilities: ["write", "citation", "grep"],
  },
];

const ITEMS = {
  ITEM1: {
    id: "ITEM1",
    itemType: "journalArticle",
    title: "Attention Is All You Need",
    abstractNote: "The dominant sequence transduction models are based on recurrent networks.",
    creators: [{ creatorType: "author", firstName: "Ashish", lastName: "Vaswani" }],
    date: "2017-06-12",
    year: 2017,
    tags: ["transformers"],
    collections: ["C1"],
    url: null,
    doi: "10.5555/3295222.3295349",
  },
  ITEM2: {
    id: "ITEM2",
    itemType: "journalArticle",
    title: "BERT: Pre-training of Deep Bidirectional Transformers",
    abstractNote: "We introduce a new language representation model.",
    creators: [{ creatorType: "author", firstName: "Jacob", lastName: "Devlin" }],
    date: "2019-05-24",
    year: 2019,
    tags: [],
    collections: [],
    url: null,
    doi: null,
  },
};

const SEARCH_RESULTS = [
  {
    id: "ITEM1",
    type: "item",
    relevance: 0.98,
    title: "Attention Is All You Need",
    authors: ["Ashish Vaswani"],
    year: 2017,
    itemType: "journalArticle",
  },
  {
    id: "ITEM2",
    type: "item",
    relevance: 0.81,
    title: "BERT: Pre-training of Deep Bidirectional Transformers",
    authors: ["Jacob Devlin"],
    year: 2019,
    itemType: "journalArticle",
  },
  {
    id: "ANN1",
    type: "annotation",
    relevance: 0.9,
    itemTitle: "Attention Is All You Need",
    text: "Scaled dot-product attention",
    comment: "core mechanism",
    color: "yellow",
    page: 3,
  },
  {
    id: "NOTE1",
    type: "note",
    relevance: 0.7,
    noteType: "child",
    parentId: "ITEM1",
    excerpt: "Follow-up reading list for transformers.",
  },
];

/** mode=grep payload: one document with a coalesced two-hit window plus a meta hit. */
const GREP_RESULTS = [
  {
    id: "ITEM1",
    type: "item",
    relevance: 0,
    title: "Attention Is All You Need",
    authors: ["Ashish Vaswani"],
    year: 2017,
    matchCount: 3,
    matchesTruncated: false,
    snippets: [
      {
        text: "doi:10.1038/s41586 and later work",
        page: 3,
        field: null,
        leading: true,
        trailing: true,
        hitsTruncated: false,
        hits: [
          { line: 42, column: 118, offset: 18342, hitStart: 4, hitLength: 16 },
          { line: 42, column: 190, offset: 18414, hitStart: 76, hitLength: 16 },
        ],
      },
      {
        text: "Attention Is All You Need",
        page: null,
        field: "title",
        leading: false,
        trailing: false,
        hitsTruncated: false,
        hits: [{ line: 1, column: 1, offset: 0, hitStart: 0, hitLength: 9 }],
      },
    ],
  },
  {
    id: "ANN1",
    type: "annotation",
    relevance: 0,
    itemTitle: "Attention Is All You Need",
    text: "Scaled dot-product attention",
    comment: "core mechanism",
    color: "yellow",
    page: 3,
    matchCount: 1,
    matchesTruncated: false,
  },
];

const handlers = {
  health() {
    return { status: "ok", version: "4.0.0-mock", uptimeSec: 42 };
  },
  listSources() {
    return { sources: SOURCES };
  },
  indexStatus(params) {
    return { source: params.source, status: "ready", docs: 4, message: null };
  },
  getStats(params) {
    return { source: params.source, items: 2, annotations: 1, notes: 1, attachments: 1, indexDocs: 4, indexSizeBytes: 4096 };
  },
  search(params) {
    const typeByTarget = { items: "item", annotations: "annotation", notes: "note" };
    const wanted = new Set(params.targets.map((t) => typeByTarget[t]));
    return { results: SEARCH_RESULTS.filter((r) => wanted.has(r.type)) };
  },
  grep(params) {
    const typeByTarget = { items: "item", annotations: "annotation", notes: "note" };
    const wanted = new Set(params.targets.map((t) => typeByTarget[t]));
    const results = GREP_RESULTS.filter((r) => wanted.has(r.type));
    return {
      results,
      total: results.length,
      totalMatches: results.reduce((n, r) => n + r.matchCount, 0),
      truncated: false,
      scanned: { docs: results.length, pages: 3, bytes: 4096, elapsedMs: 2 },
    };
  },
  searchPassages(params) {
    return {
      passages: [
        { text: `Passage mentioning ${params.query} in ${params.docId}.`, page: 2, heading: null, score: 0.92 },
        { text: `Another ${params.query} passage.`, page: 5, heading: null, score: 0.61 },
      ].slice(0, params.k ?? 5),
    };
  },
  batchSearchPassages(params) {
    return {
      docs: params.docIds.map((docId) => ({
        docId,
        passages: [{ text: `Passage mentioning ${params.query} in ${docId}.`, page: 2, heading: null, score: 0.92 }],
      })),
    };
  },
  getContent(params) {
    if (params.id === "NOTE1") {
      return {
        kind: "note",
        text: "Follow-up reading list for transformers.",
        offset: params.offset ?? 0,
        nextOffset: null,
        totalLength: 38,
        noteType: "child",
        parentId: "ITEM1",
        tags: [],
        createdAt: "2026-01-02T10:00:00Z",
      };
    }
    const full = `${ITEMS[params.id]?.title ?? params.id} — full text body. `;
    const text = full.repeat(20);
    const offset = params.offset ?? 0;
    const limit = params.limit ?? 4000;
    const slice = text.slice(offset, offset + limit);
    return { kind: "document", text: slice, offset, nextOffset: offset + limit < text.length ? offset + limit : null, totalLength: text.length };
  },
  getItem(params) {
    return ITEMS[params.id] ?? null;
  },
  getAnnotations() {
    return {
      annotations: [{ id: "ANN1", text: "Scaled dot-product attention", comment: "core mechanism", color: "yellow", page: 3, type: "highlight" }],
    };
  },
  getNotes() {
    return { notes: [{ id: "NOTE1", html: "<p>Follow-up reading list for transformers.</p>", text: "Follow-up reading list for transformers.", tags: [], dateAdded: "2026-01-02T10:00:00Z" }] };
  },
  listCollections() {
    return { collections: [{ id: "C1", name: "Transformers", numItems: 2, hasChildren: false, parentId: null }] };
  },
  listCollectionItems() {
    return { items: SEARCH_RESULTS.filter((r) => r.type === "item") };
  },
  listTags() {
    return { tags: [{ tag: "transformers", count: 1 }] };
  },
  listSavedSearches() {
    return { searches: [] };
  },
  listStandaloneNotes() {
    return { notes: [] };
  },
  getCitation() {
    return { format: "bibtex", style: null, citation: "@inproceedings{vaswani2017, title={Attention Is All You Need}}" };
  },
  updateIndex(params) {
    return { updated: params.itemKeys?.length ?? 0 };
  },
};

export function startMockCore(port) {
  const server = http.createServer((req, res) => {
    if (req.method !== "POST" || !req.url.startsWith("/rpc")) {
      res.writeHead(404).end();
      return;
    }
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      let msg;
      try {
        msg = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch {
        res.writeHead(400).end();
        return;
      }
      const fn = handlers[msg.method];
      res.writeHead(200, { "Content-Type": "application/json" });
      if (!fn) {
        res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            id: msg.id,
            error: { code: -32601, message: `method not found: ${msg.method}`, data: { code: "invalid_params" } },
          }),
        );
        return;
      }
      try {
        res.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: fn(msg.params ?? {}) }));
      } catch (err) {
        res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            id: msg.id,
            error: { code: -32000, message: String(err), data: { code: "invalid_params" } },
          }),
        );
      }
    });
  });
  return new Promise((resolve) => server.listen(port, "127.0.0.1", () => resolve(server)));
}
